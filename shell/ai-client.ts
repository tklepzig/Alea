// Main-thread side of the AI worker: hands a position over, collects the
// deepest result the worker managed, and — crucially — never leaves the caller
// waiting forever.
//
// The failure this guards against is not an exception. On a low-memory device a
// deep search is killed mid-flight and takes its whole JS context with it: no
// throw, no "error" message, just silence. That is survivable only because the
// search is over *there* while this timer is over *here* — an equivalent timer
// armed on a blocked main thread dies with the search and never fires (measured;
// see ai-worker.ts). So: a timeout, and the last reported depth as the answer.

import { AI_ENGINES, type AiMoves, type AiPayloads } from "./ai-engines.js";
import type { AiGameId, AiRequest, AiResponse } from "./ai-protocol.js";
import { randomSeed, seededRandom } from "./seeded-random.js";

/** Built by offline-kit and precached; resolved relative to the page. */
const WORKER_URL = "ai-worker.js";

// How long the worker may stay *silent* before we call it dead. Re-armed on
// every completed depth, so it measures a gap between results, not a total
// budget — a search that keeps reporting can run as long as it likes.
//
// A constant is not enough, though: each rung costs several times the one
// before, so the final gap is exactly where a perfectly healthy search looks
// dead. With a flat 25s the deepest rung of Mühle expert (measured ~15s here,
// so ~130s on a 9x-slower tablet) and Halma expert would time out every single
// move, and the fallback is the *previous* rung — those levels would quietly
// and permanently play at their "hard" depth on the one device this whole
// design exists for, re-paying the discarded work each turn.
//
// So scale the allowance from the gap actually observed: whatever the last rung
// took, allow generously more for the next. Still a liveness check, not a
// budget — it never truncates a search that is reporting progress.
const AI_IDLE_TIMEOUT_MS = 25_000;
const IDLE_GAP_MULTIPLIER = 20;

// Depth cap for the main-thread fallback only. That path blocks the UI, and an
// unbounded ladder there would reproduce the original bug exactly: ~30s of
// frozen board and then a killed context with no timer left to notice. Depth 4
// costs ~57ms on desktop and ~0.5s on the slow tablet. A weak move beats a dead
// game, and this only runs when no worker could be created at all.
const FALLBACK_MAX_DEPTH = 4;

export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

/** The caller abandoned the position (undo, restart, left the game). Distinct
 *  from AiUnavailableError so the UI can ignore it instead of reporting a
 *  failure for a turn nobody is waiting on any more. */
export class AiCancelledError extends Error {
  constructor() {
    super("AI request cancelled");
    this.name = "AiCancelledError";
  }
}

interface Pending {
  resolve(move: unknown): void;
  reject(error: Error): void;
  /** Deepest move reported so far — the fallback if the worker goes quiet. */
  best: unknown;
  /** Which engine, and the position asked about, so a request can still be
   *  answered on this thread once we know no worker is coming. */
  game: AiGameId;
  payload: unknown;
  timer: ReturnType<typeof setTimeout>;
  /** When the last sign of life arrived, so the next allowance can be scaled
   *  from the gap the worker actually needed. */
  lastSignalAt: number;
  /** Restarts the silence clock; called each time a depth lands. */
  touch(): void;
}

/** The capped on-thread search. Blocks, so it is only ever a last resort. */
function searchHere(game: AiGameId, payload: unknown): unknown {
  return AI_ENGINES[game](payload, seededRandom(randomSeed()), {
    maxDepth: FALLBACK_MAX_DEPTH,
  });
}

let worker: Worker | null = null;
let workerBroken = false;
/** Has the *current* worker sent anything yet? Per-instance, not global: a
 *  later worker can fail to load even after an earlier one worked (a purged
 *  cache), and a global flag would keep rebuilding a worker that can't run. */
let workerResponded = false;
// Consecutive workers that died without a word. One such failure is ambiguous —
// it could be the low-memory kill this whole design exists for, and falling back
// to the main thread for that would reinstate the freeze it is meant to prevent.
// Two in a row is not a coincidence: the bundle isn't loading, so stop trying.
// (A worker that is merely being killed still gets depth 2 out first — ~130ms
// even on the slow tablet — so it counts as having responded.)
let silentFailures = 0;
const MAX_SILENT_FAILURES = 2;
let nextId = 1;
const pending = new Map<number, Pending>();

function settle(id: number, apply: (entry: Pending) => void): void {
  const entry = pending.get(id);
  if (!entry) return; // already settled — a late duplicate, ignore
  pending.delete(id);
  clearTimeout(entry.timer);
  apply(entry);
}

/** Give up on every in-flight request, answering each as well as we still can. */
function failAll(reason: string): void {
  for (const id of [...pending.keys()]) {
    settle(id, (entry) => {
      if (entry.best !== null) {
        entry.resolve(entry.best);
        return;
      }
      // Once the worker is written off for good, no retry will do better — so
      // answer here rather than reporting a failure the player can only respond
      // to by tapping Nochmal and meeting the same wall.
      if (workerBroken) {
        try {
          entry.resolve(searchHere(entry.game, entry.payload));
          return;
        } catch {
          // Engine threw on this position; fall through and report it.
        }
      }
      entry.reject(new AiUnavailableError(reason));
    });
  }
}

/** Drop the worker so the next request builds a fresh one — a killed context
 *  can't be reused, and a wedged one would swallow every later request. */
function discardWorker(reason: string): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  failAll(reason);
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (workerBroken) return null;
  try {
    worker = new Worker(WORKER_URL);
  } catch {
    // Workers unsupported, or blocked outright. Remember it so every later turn
    // goes straight to the fallback instead of retrying a constructor that throws.
    workerBroken = true;
    return null;
  }
  workerResponded = false;

  worker.onmessage = (event: MessageEvent<AiResponse>) => {
    workerResponded = true;
    silentFailures = 0;
    const response = event.data;
    if (response.kind === "progress") {
      const entry = pending.get(response.id);
      if (entry) {
        entry.best = response.move;
        entry.touch(); // it's alive — restart the silence clock
      }
      return;
    }
    settle(response.id, (entry) => {
      if (response.kind === "done") entry.resolve(response.move);
      else if (entry.best !== null) entry.resolve(entry.best);
      // An engine assertion is a diagnostic, so it stays a plain Error and the
      // UI shows its own copy. Wrapping it as AiUnavailableError would make the
      // UI treat "no legal move — check status first" as German player text.
      else if (response.fromEngine) entry.reject(new Error(response.message));
      else entry.reject(new AiUnavailableError(response.message));
    });
  };
  // A worker that dies outright still reaches us here — unlike the silent kill,
  // which only the timeout catches. A failure before it ever spoke means the
  // bundle never loaded (404 from a stale cache, blocked by CSP): `new Worker`
  // resolves happily for those, so this is the only place they surface.
  worker.onerror = () => {
    if (!workerResponded && ++silentFailures >= MAX_SILENT_FAILURES) {
      workerBroken = true;
    }
    discardWorker("Der KI-Worker ist abgestürzt.");
  };
  worker.onmessageerror = () => discardWorker("Unlesbare Antwort vom KI-Worker.");

  return worker;
}

/**
 * The AI's move for `state`. Resolves with the deepest move the worker
 * completed; rejects with `AiUnavailableError` only when not even the shallowest
 * depth came back.
 *
 * Falls back to a *shallow* search on this thread when no worker can be created.
 * That blocks the UI, so it is capped at FALLBACK_MAX_DEPTH — running the full
 * ladder here would be the original bug verbatim.
 */
export function requestAiMove<TGame extends AiGameId>(
  game: TGame,
  payload: AiPayloads[TGame],
): Promise<AiMoves[TGame]> {
  const active = ensureWorker();
  if (!active) {
    try {
      return Promise.resolve(searchHere(game, payload) as AiMoves[TGame]);
    } catch (error) {
      // An engine throw is a diagnostic, not player copy — keep it a plain
      // Error so the UI shows its own message instead of an assertion string.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  const id = nextId++;
  return new Promise<AiMoves[TGame]>((resolve, reject) => {
    // Silence past the deadline means the worker is gone — the silent kill
    // produces no error event at all, so this is the only thing that notices.
    // discardWorker settles through failAll: the deepest completed depth if we
    // got one, otherwise a rejection. Rebuilding happens on the next request.
    const onSilence = () => discardWorker("Die KI hat nicht geantwortet.");
    const entry: Pending = {
      resolve: resolve as (move: unknown) => void,
      reject,
      best: null,
      game,
      payload,
      timer: setTimeout(onSilence, AI_IDLE_TIMEOUT_MS),
      lastSignalAt: Date.now(),
      touch: () => {
        const now = Date.now();
        const gap = now - entry.lastSignalAt;
        entry.lastSignalAt = now;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(
          onSilence,
          Math.max(AI_IDLE_TIMEOUT_MS, gap * IDLE_GAP_MULTIPLIER),
        );
      },
    };

    pending.set(id, entry);
    const request: AiRequest = { id, game, payload, seed: randomSeed() };
    active.postMessage(request);
  });
}

/**
 * Drop any in-flight request — the caller has moved on (undo, restart, exit).
 *
 * Rejects rather than leaving promises unsettled, which would keep their
 * handlers (and the positions they close over) alive for the page's lifetime.
 *
 * Then kills the worker, which is the part that matters: the search inside it
 * doesn't yield, so an abandoned one keeps a core busy and the *next* request
 * queues behind it. Worse, the abandoned request's silence timer would later
 * call `discardWorker` and terminate the worker mid-way through the new search,
 * which has no progress of its own yet — so a plain undo during a think would
 * surface as a spurious "KI-Fehler". Terminating fires no `onerror`, so the
 * silent-failure bookkeeping is untouched. It also frees the worker's heap when
 * leaving the game, on the very devices whose memory started all this.
 */
export function cancelAiMoves(): void {
  for (const id of [...pending.keys()]) {
    settle(id, (entry) => entry.reject(new AiCancelledError()));
  }
  if (worker) {
    worker.terminate();
    worker = null;
  }
}
