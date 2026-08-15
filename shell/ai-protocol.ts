// Wire format between the main thread and the AI worker (`ai-worker.ts`).
//
// Kept free of DOM and WebWorker globals so both sides — and the unit tests —
// can import it under either tsconfig. Everything here has to survive
// structured cloning, which is why the payloads are plain data: the game states
// are already boards of plain objects, and the RNG crosses as a *seed* rather
// than a function, since functions can't be cloned.
//
// Moves are `unknown` on the wire because each game has its own move type (a
// square pair, a column index, a whole turn as an array). The registry in
// ai-engines.ts is where a payload is matched back to its game, and
// `requestAiMove` is generic so callers get their own type back.

export type AiGameId = "dame" | "quadra" | "muehle" | "schach" | "halma";

export interface AiRequest {
  /** Matches a response to its request; a stale reply is ignored, not applied. */
  id: number;
  game: AiGameId;
  /** Whatever that game's engine needs — usually its GameState, but Quadra
   *  takes board/player/difficulty. See ai-engines.ts. */
  payload: unknown;
  /** Seeds the worker's RNG so tie-breaks stay reproducible across the boundary. */
  seed: number;
}

export type AiResponse =
  /** A completed search depth. The main thread keeps the latest as its fallback:
   *  if the worker dies before "done", this is still a legal, sensible move. */
  | { id: number; kind: "progress"; depth: number; move: unknown }
  | { id: number; kind: "done"; move: unknown }
  /** `fromEngine` marks a throw out of the game logic — an assertion like
   *  "no legal move — check status first". Those messages are diagnostics, not
   *  copy, and must never be rendered to a player; only the client's own
   *  messages are written for one. */
  | { id: number; kind: "error"; message: string; fromEngine: boolean };
