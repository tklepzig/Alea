import { createGame, applyMove, createBoard, type GameState, type Board } from "./game.js";
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
    let game = createGame({ mode: "ai", difficulty: "hard", humanPlayer: "blue" });
    game = applyMove(game, { kind: "place", to: 4 });
    game = applyMove(game, { kind: "place", to: 5 });
    expect(deserializeGame(serializeGame(game))).toEqual(game);
  });

  it("round-trips a paused-capture state", () => {
    const board = createBoard();
    board[0] = "red";
    board[1] = "red";
    board[8] = "blue";
    let game: GameState = {
      board,
      inHand: { red: 7, blue: 8 },
      currentPlayer: "red",
      pendingCapture: false,
      mode: "local",
      difficulty: "medium",
      humanPlayer: "red",
      status: "playing",
      winner: null,
    };
    game = applyMove(game, { kind: "place", to: 2 }); // forms a mill → pendingCapture
    expect(game.pendingCapture).toBe(true);
    expect(deserializeGame(serializeGame(game))).toEqual(game);
  });

  it("rejects null, corrupt JSON, and the wrong schema version", () => {
    expect(deserializeGame(null)).toBeNull();
    expect(deserializeGame("nope")).toBeNull();
    expect(deserializeGame(JSON.stringify({ v: 99, data: {} }))).toBeNull();
  });

  it("rejects a finished game", () => {
    const game = createGame({ mode: "local" });
    const won = { ...game, status: "won" as const, winner: "red" as const };
    expect(deserializeGame(serializeGame(won))).toBeNull();
  });

  it("rejects a board of the wrong length", () => {
    const broken = { ...createGame({ mode: "local" }) };
    broken.board = broken.board.slice(0, 12) as Board;
    expect(deserializeGame(serializeGame(broken))).toBeNull();
  });

  it("rejects more than nine stones for a player", () => {
    const board = createBoard();
    for (let index = 0; index < 10; index++) board[index] = "red";
    const broken: GameState = {
      ...createGame({ mode: "local" }),
      board,
      inHand: { red: 0, blue: 9 },
    };
    expect(deserializeGame(serializeGame(broken))).toBeNull();
  });

  it("rejects a pendingCapture with nothing to capture", () => {
    const broken: GameState = {
      ...createGame({ mode: "local" }),
      pendingCapture: true, // but the board is empty of blue stones
    };
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
