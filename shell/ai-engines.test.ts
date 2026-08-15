// The registry is the one place the wire's erased payload is cast back to a
// concrete game type, and until now nothing exercised it: every ai-client test
// used "dame", so four of the five paths had no coverage on either end. A
// renamed key in a ui (or a new AiGameId with no entry) would compile, ship, and
// fail only inside the worker — reaching the player as a generic "KI-Fehler".

import { AI_ENGINES, type AiPayloads } from "./ai-engines.js";
import type { AiGameId } from "./ai-protocol.js";
import { seededRandom } from "./seeded-random.js";

import * as dame from "../games/dame/game.js";
import * as quadra from "../games/quadra/game.js";
import * as muehle from "../games/muehle/game.js";
import * as schach from "../games/schach/game.js";
import * as halma from "../games/halma/game.js";

/** Built exactly as each game's ui.ts builds it — that correspondence is the
 *  thing under test, so these must not be "whatever the registry wants". */
const PAYLOADS: { [TGame in AiGameId]: () => AiPayloads[TGame] } = {
  dame: () => ({
    ...dame.createGame({ mode: "ai", humanPlayer: "red", difficulty: "hard" }),
    currentPlayer: "black",
  }),
  muehle: () => muehle.createGame({ mode: "ai", humanPlayer: "blue", difficulty: "hard" }),
  schach: () => schach.createGame({ mode: "ai", humanPlayer: "white", difficulty: "hard" }),
  halma: () => halma.createGame({ mode: "ai", humanPlayer: "blue", difficulty: "hard" }),
  // games/quadra/ui.ts posts board/player/difficulty, not a GameState.
  quadra: () => {
    const game = quadra.createGame({ mode: "ai", humanPlayer: "yellow", difficulty: "hard" });
    return { board: game.board, player: game.currentPlayer, difficulty: game.difficulty };
  },
};

const GAME_IDS = Object.keys(PAYLOADS) as AiGameId[];

describe("AI_ENGINES", () => {
  it("has an entry for every game id, and no extras", () => {
    expect(Object.keys(AI_ENGINES).sort()).toEqual([...GAME_IDS].sort());
  });

  it.each(GAME_IDS)("%s: payload survives structured cloning", (game) => {
    const payload = PAYLOADS[game]();
    // A function or class instance anywhere in here throws DataCloneError when
    // postMessage hands it to the worker.
    expect(() => structuredClone(payload)).not.toThrow();
    expect(structuredClone(payload)).toEqual(payload);
  });

  it.each(GAME_IDS)("%s: returns a move its own engine accepts", (game) => {
    const payload = PAYLOADS[game]();
    const answer = AI_ENGINES[game](payload, seededRandom(1), {});
    expect(answer).toBeDefined();
  });

  it.each(GAME_IDS)("%s: reports at least one completed depth", (game) => {
    const depths: number[] = [];
    AI_ENGINES[game](PAYLOADS[game](), seededRandom(1), {
      onDepth: (progress) => depths.push(progress.depth),
    });
    // Without progress there is nothing to fall back on when a search is killed.
    expect(depths.length).toBeGreaterThan(0);
    expect([...depths]).toEqual([...depths].sort((first, second) => first - second));
  });

  it.each(GAME_IDS)("%s: honours maxDepth", (game) => {
    const depths: number[] = [];
    AI_ENGINES[game](PAYLOADS[game](), seededRandom(1), {
      maxDepth: 2,
      onDepth: (progress) => depths.push(progress.depth),
    });
    for (const depth of depths) expect(depth).toBeLessThanOrEqual(2);
  });

  // Per-game legality — a cast that lined up structurally but meant something
  // else would still produce a "move" here, so check each against its own rules.
  it("dame returns a legal move", () => {
    const state = PAYLOADS.dame();
    expect(dame.isLegalMove(state, AI_ENGINES.dame(state, seededRandom(1), {}) as dame.Move)).toBe(true);
  });

  it("muehle returns a legal move", () => {
    const state = PAYLOADS.muehle();
    expect(muehle.isLegalMove(state, AI_ENGINES.muehle(state, seededRandom(1), {}) as muehle.Move)).toBe(true);
  });

  it("schach returns a legal move", () => {
    const state = PAYLOADS.schach();
    expect(schach.isLegalMove(state, AI_ENGINES.schach(state, seededRandom(1), {}) as schach.Move)).toBe(true);
  });

  it("halma returns a replayable turn, not a single move", () => {
    const state = PAYLOADS.halma();
    const path = AI_ENGINES.halma(state, seededRandom(1), {}) as halma.Move[];
    expect(Array.isArray(path)).toBe(true);
    expect(path.length).toBeGreaterThan(0);
    let current = state;
    for (const move of path) {
      expect(halma.isLegalMove(current, move)).toBe(true);
      current = halma.applyMove(current, move);
    }
  });

  it("quadra returns a playable column index", () => {
    const payload = PAYLOADS.quadra();
    const column = AI_ENGINES.quadra(payload, seededRandom(1), {}) as number;
    expect(typeof column).toBe("number");
    expect(quadra.validColumns(payload.board)).toContain(column);
  });
});
