// Wire format between the main thread and the AI worker (`ai-worker.ts`).
//
// Kept free of DOM and WebWorker globals so both sides — and the unit tests —
// can import it under either tsconfig. Everything here has to survive
// structured cloning, which is why the payloads are plain data: the game states
// are already boards of plain objects, and the RNG crosses as a *seed* rather
// than a function, since functions can't be cloned.

import type { GameState, Move } from "../games/dame/game.js";

/** Which engine to run. One worker bundle serves every game that gets one. */
export type AiGameId = "dame";

export interface AiRequest {
  /** Matches a response to its request; a stale reply is ignored, not applied. */
  id: number;
  game: AiGameId;
  state: GameState;
  /** Seeds the worker's RNG so tie-breaks stay reproducible across the boundary. */
  seed: number;
}

export type AiResponse =
  /** A completed search depth. The main thread keeps the latest as its fallback:
   *  if the worker dies before "done", this is still a legal, sensible move. */
  | { id: number; kind: "progress"; depth: number; move: Move }
  | { id: number; kind: "done"; move: Move }
  | { id: number; kind: "error"; message: string };
