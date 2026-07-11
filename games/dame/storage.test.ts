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
  it("round-trips an in-progress game", () => {
    let game = createGame({ mode: "ai", difficulty: "hard", humanPlayer: "black" });
    game = applyMove(game, { from: { row: 5, col: 0 }, to: { row: 4, col: 1 }, captured: null });
    const restored = deserializeGame(serializeGame(game));
    expect(restored).toEqual(game);
  });

  it("round-trips a state paused mid multi-jump", () => {
    const board: Board = Array.from({ length: 8 }, () => Array(8).fill(null));
    board[5][4] = { player: "red", kind: "man" };
    board[4][3] = { player: "black", kind: "man" };
    board[2][3] = { player: "black", kind: "man" };
    let game: GameState = {
      board,
      currentPlayer: "red",
      mode: "local",
      difficulty: "medium",
      humanPlayer: "red",
      mustContinueFrom: null,
      status: "playing",
      winner: null,
    };
    game = applyMove(game, { from: { row: 5, col: 4 }, to: { row: 3, col: 2 }, captured: { row: 4, col: 3 } });
    expect(game.mustContinueFrom).not.toBeNull();
    expect(deserializeGame(serializeGame(game))).toEqual(game);
  });

  it("rejects null, corrupt JSON, and the wrong schema version", () => {
    expect(deserializeGame(null)).toBeNull();
    expect(deserializeGame("not json")).toBeNull();
    expect(deserializeGame(JSON.stringify({ v: 999, data: {} }))).toBeNull();
  });

  it("rejects a finished game (only in-progress games are persisted)", () => {
    const board: Board = Array.from({ length: 8 }, () => Array(8).fill(null));
    board[5][4] = { player: "red", kind: "man" };
    board[4][3] = { player: "black", kind: "man" };
    const game = applyMove(
      { board, currentPlayer: "red", mode: "local", difficulty: "medium", humanPlayer: "red", mustContinueFrom: null, status: "playing", winner: null },
      { from: { row: 5, col: 4 }, to: { row: 3, col: 2 }, captured: { row: 4, col: 3 } },
    );
    expect(game.status).toBe("won");
    expect(deserializeGame(serializeGame(game))).toBeNull();
  });

  it("rejects a piece sitting on a light square", () => {
    const broken = createGame({ mode: "local" });
    broken.board[0][0] = { player: "black", kind: "man" }; // (0,0) is a light square
    expect(deserializeGame(serializeGame(broken))).toBeNull();
  });

  it("rejects a board with the wrong dimensions", () => {
    const broken = { ...createGame({ mode: "local" }) };
    broken.board = broken.board.slice(0, 5) as Board;
    expect(deserializeGame(serializeGame(broken))).toBeNull();
  });

  it("rejects mustContinueFrom pointing at the wrong player's piece", () => {
    const broken = createGame({ mode: "local" });
    broken.mustContinueFrom = { row: 2, col: 1 }; // a black man, but red is to move
    expect(deserializeGame(serializeGame(broken))).toBeNull();
  });
});

describe("settings persistence", () => {
  it("round-trips settings and the defaults", () => {
    const settings: Settings = { mode: "ai", difficulty: "easy", humanFirst: false };
    expect(deserializeSettings(serializeSettings(settings))).toEqual(settings);
    expect(deserializeSettings(serializeSettings(DEFAULT_SETTINGS))).toEqual(DEFAULT_SETTINGS);
  });

  it("rejects corrupt or incomplete settings", () => {
    expect(deserializeSettings(null)).toBeNull();
    expect(deserializeSettings("{")).toBeNull();
    expect(deserializeSettings(JSON.stringify({ v: 1, data: { mode: "ai" } }))).toBeNull();
    expect(
      deserializeSettings(JSON.stringify({ v: 1, data: { mode: "x", difficulty: "hard", humanFirst: true } })),
    ).toBeNull();
  });
});
