// AI worker entry. esbuild bundles this (and the engines it imports) into
// ai-worker.js, which offline-kit precaches like any other asset.
//
// Why the search lives here rather than on the main thread: a deep search can be
// killed outright on a low-memory device, and that takes the whole JS execution
// context with it — pending timers included — so nothing on that thread survives
// to notice. Measured on a 1GB Android tablet: Dame's depth-8 "Experte" search
// burned ~30s of CPU, then stopped dead with no exception, no `catch`, and no
// `window.onerror`; an already-armed 45s watchdog never fired and a 1s heartbeat
// never resumed. Running it here means only *this* context dies, and the main
// thread stays alive to fall back to the deepest result it was told about.
//
// So the contract is: report every completed depth, don't wait for the end.

/// <reference lib="webworker" />

import { getAiMoveIterative } from "./games/dame/game.js";
import type { AiRequest, AiResponse } from "./shell/ai-protocol.js";
import { seededRandom } from "./shell/seeded-random.js";

// `self` types as WorkerGlobalScope, which has neither onmessage nor
// postMessage — those belong to the dedicated-worker scope this actually runs in.
const ctx = self as unknown as DedicatedWorkerGlobalScope;

const post = (response: AiResponse): void => {
  ctx.postMessage(response);
};

ctx.onmessage = (event: MessageEvent<AiRequest>): void => {
  const { id, game, state, seed } = event.data;
  try {
    if (game !== "dame") throw new Error(`unknown game "${game}"`);
    const random = seededRandom(seed);
    const move = getAiMoveIterative(state, random, {
      onDepth: (progress) => {
        post({ id, kind: "progress", depth: progress.depth, move: progress.move });
      },
    });
    post({ id, kind: "done", move });
  } catch (error) {
    // Only reaches here for a *throwable* failure (an illegal state, say). The
    // failure this worker exists for — the search being killed — never runs a
    // catch block anywhere, which is exactly why the caller also needs a timeout.
    post({
      id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
      // Everything reachable here comes out of the engine, so the message is a
      // diagnostic. The client must not pass it off as text for a player.
      fromEngine: true,
    });
  }
};
