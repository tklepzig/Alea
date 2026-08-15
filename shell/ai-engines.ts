// Which engine answers for which game, for both sides of the worker boundary:
// the worker dispatches on it, and the client uses it for the capped
// main-thread fallback.
//
// This is the one place where the wire's `unknown` payload is matched back to a
// concrete game type. Structured cloning erases types, so a cast has to happen
// somewhere; keeping it here means every caller above stays typed, and a new
// game is one entry rather than a new branch in two files.

import type { AiGameId } from "./ai-protocol.js";
import type { IterativeOptions } from "./iterative-search.js";

import * as dame from "../games/dame/game.js";
import * as quadra from "../games/quadra/game.js";
import * as muehle from "../games/muehle/game.js";
import * as schach from "../games/schach/game.js";
import * as halma from "../games/halma/game.js";

type RandomFn = () => number;

/** Quadra's engine predates the GameState convention and takes its inputs
 *  loose, so its payload spells them out. */
export interface QuadraPayload {
  board: quadra.Board;
  player: quadra.Player;
  difficulty: quadra.Difficulty;
}

type AiSearch = (
  payload: unknown,
  random: RandomFn,
  options: IterativeOptions<unknown>,
) => unknown;

/** Narrow the erased options back to a game's own move type. Sound in practice:
 *  the only consumer is the caller that supplied the callback, and it gets its
 *  own moves back. */
const forMove = <TMove>(options: IterativeOptions<unknown>): IterativeOptions<TMove> =>
  options as IterativeOptions<TMove>;

export const AI_ENGINES: Record<AiGameId, AiSearch> = {
  dame: (payload, random, options) =>
    dame.getAiMoveIterative(payload as dame.GameState, random, forMove(options)),

  muehle: (payload, random, options) =>
    muehle.getAiMoveIterative(payload as muehle.GameState, random, forMove(options)),

  schach: (payload, random, options) =>
    schach.getAiMoveIterative(payload as schach.GameState, random, forMove(options)),

  // Returns a whole turn (Move[]), not a single move — the UI replays it.
  halma: (payload, random, options) =>
    halma.getAiTurnIterative(payload as halma.GameState, random, forMove(options)),

  quadra: (payload, random, options) => {
    const { board, player, difficulty } = payload as QuadraPayload;
    return quadra.getAiMoveIterative(board, player, difficulty, random, forMove(options));
  },
};
