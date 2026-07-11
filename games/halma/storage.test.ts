import { createGame, applyMove, type GameState, type Board } from "./game.js";
import {
  serializeGame,
  deserializeGame,
  serializeSettings,
  deserializeSettings,
  DEFAULT_SETTINGS,
  type Settings,
} from "./storage.js";

describe("game persistence", () => {
  it("round-trips an in-progress game at a turn boundary", () => {
    let game = createGame({ mode: "ai", difficulty: "hard", humanPlayer: "blue" });
    game = applyMove(game, { kind: "step", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } });
    expect(game.jumpingFrom).toBeNull();
    expect(deserializeGame(serializeGame(game))).toEqual(game);
  });

  it("rejects null, corrupt JSON, and the wrong schema version", () => {
    expect(deserializeGame(null)).toBeNull();
    expect(deserializeGame("nope")).toBeNull();
    expect(deserializeGame(JSON.stringify({ v: 42, data: {} }))).toBeNull();
  });

  it("rejects a state paused mid jump-chain", () => {
    const broken = { ...createGame({ mode: "local" }), jumpingFrom: { row: 5, col: 5 }, jumpChain: [{ row: 5, col: 5 }] };
    expect(deserializeGame(serializeGame(broken))).toBeNull();
  });

  it("rejects a finished game", () => {
    const won: GameState = { ...createGame({ mode: "local" }), status: "won", winner: "red" };
    expect(deserializeGame(serializeGame(won))).toBeNull();
  });

  it("rejects a board with the wrong piece count", () => {
    const broken = { ...createGame({ mode: "local" }) };
    broken.board[0][0] = null; // now red has only nine
    expect(deserializeGame(serializeGame(broken))).toBeNull();
  });

  it("rejects a board of the wrong dimensions", () => {
    const broken = { ...createGame({ mode: "local" }) };
    broken.board = broken.board.slice(0, 6) as Board;
    expect(deserializeGame(serializeGame(broken))).toBeNull();
  });
});

describe("settings persistence", () => {
  it("round-trips settings and the defaults", () => {
    const settings: Settings = { mode: "ai", difficulty: "expert", humanFirst: false };
    expect(deserializeSettings(serializeSettings(settings))).toEqual(settings);
    expect(deserializeSettings(serializeSettings(DEFAULT_SETTINGS))).toEqual(DEFAULT_SETTINGS);
  });

  it("rejects corrupt or incomplete settings", () => {
    expect(deserializeSettings(null)).toBeNull();
    expect(deserializeSettings("{")).toBeNull();
    expect(deserializeSettings(JSON.stringify({ v: 1, data: { mode: "ai" } }))).toBeNull();
  });
});
