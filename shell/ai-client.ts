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

import { getAiMoveIterative, type GameState, type Move } from "../games/dame/game.js";
import type { AiGameId, AiRequest, AiResponse } from "./ai-protocol.js";
import { randomSeed, seededRandom } from "./seeded-random.js";

/** Built by offline-kit and precached; resolved relative to the page. */
const WORKER_URL = "ai-worker.js";

// Long on purpose. This is a dead-worker detector, not a search budget: it must
// sit clear of any search that would legitimately finish, or it would silently
// cost playing strength on a slow device. The slowest *successful* search
// measured is ~6s (desktop, king-and-men middlegame); the killed one gave up at
// ~30s. 45s is comfortably past both.
const AI_TIMEOUT_MS = 45_000;

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
  resolve(move: Move): void;
  reject(error: Error): void;
  /** Deepest move reported so far — the fallback if the worker goes quiet. */
  best: Move | null;
  timer: ReturnType<typeof setTimeout>;
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

/** Give up on every in-flight request, using each one's fallback if it has one. */
function failAll(reason: string): void {
  for (const id of [...pending.keys()]) {
    settle(id, (entry) => {
      if (entry.best) entry.resolve(entry.best);
      else entry.reject(new AiUnavailableError(reason));
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
      if (entry) entry.best = response.move;
      return;
    }
    settle(response.id, (entry) => {
      if (response.kind === "done") entry.resolve(response.move);
      else if (entry.best) entry.resolve(entry.best);
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
 * Falls back to searching on this thread when no worker can be created — which
 * restores the old blocking behaviour, freeze and all, but only where a worker
 * was never an option to begin with.
 */
export function requestAiMove(game: AiGameId, state: GameState): Promise<Move> {
  const active = ensureWorker();
  if (!active) {
    try {
      return Promise.resolve(getAiMoveIterative(state, seededRandom(randomSeed())));
    } catch (error) {
      return Promise.reject(
        new AiUnavailableError(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  const id = nextId++;
  return new Promise<Move>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Silence past the deadline means the worker is gone — the silent kill,
      // which produces no error event at all. discardWorker settles this
      // request through failAll: the deepest completed depth if we got one,
      // otherwise a rejection. Rebuilding happens on the next request.
      discardWorker("Die KI hat nicht geantwortet.");
    }, AI_TIMEOUT_MS);

    pending.set(id, { resolve, reject, best: null, timer });
    const request: AiRequest = { id, game, state, seed: randomSeed() };
    active.postMessage(request);
  });
}

/** Drop any in-flight request — the caller has moved on (undo, restart, exit).
 *  Rejects rather than leaving the promise unsettled, which would keep its
 *  handlers (and the position they close over) alive for the page's lifetime. */
export function cancelAiMoves(): void {
  for (const id of [...pending.keys()]) {
    settle(id, (entry) => entry.reject(new AiCancelledError()));
  }
}
