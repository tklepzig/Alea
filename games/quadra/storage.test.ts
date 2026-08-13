import { createGame, applyMove, type GameState } from "./game.js";
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
    let game = createGame({ mode: "ai", difficulty: "hard", humanPlayer: "yellow" });
    game = applyMove(game, 3);
    game = applyMove(game, 3);
    const restored = deserializeGame(serializeGame(game));
    expect(restored).toEqual(game);
  });

  it("rejects null, corrupt JSON, and the wrong schema version", () => {
    expect(deserializeGame(null)).toBeNull();
    expect(deserializeGame("not json")).toBeNull();
    expect(deserializeGame(JSON.stringify({ v: 999, data: {} }))).toBeNull();
  });

  it("rejects a finished game (only in-progress games are persisted)", () => {
    let game = createGame({ mode: "local" });
    for (const column of [0, 1, 0, 1, 0, 1]) game = applyMove(game, column);
    game = applyMove(game, 0); // red wins
    expect(game.status).toBe("won");
    expect(deserializeGame(serializeGame(game))).toBeNull();
  });

  it("rejects a board with a floating disc (impossible gravity)", () => {
    const broken = {
      ...createGame({ mode: "local" }),
    } as GameState;
    // Place a disc at row 2 of column 0 with rows 0 and 1 empty.
    broken.board = broken.board.map((column, index) =>
      index === 0 ? [null, null, "red", null, null, null] : column,
    ) as GameState["board"];
    expect(deserializeGame(serializeGame(broken))).toBeNull();
  });

  it("rejects a board with the wrong dimensions", () => {
    const broken = { ...createGame({ mode: "local" }) } as GameState;
    broken.board = broken.board.slice(0, 5) as GameState["board"];
    expect(deserializeGame(serializeGame(broken))).toBeNull();
  });
});

describe("settings persistence", () => {
  it("round-trips settings", () => {
    const settings: Settings = { mode: "ai", difficulty: "easy", humanFirst: false, allowUndo: false };
    expect(deserializeSettings(serializeSettings(settings))).toEqual(settings);
  });

  it("round-trips the defaults", () => {
    expect(deserializeSettings(serializeSettings(DEFAULT_SETTINGS))).toEqual(
      DEFAULT_SETTINGS,
    );
  });

  it("rejects corrupt or incomplete settings", () => {
    expect(deserializeSettings(null)).toBeNull();
    expect(deserializeSettings("{")).toBeNull();
    expect(
      deserializeSettings(JSON.stringify({ v: 1, data: { mode: "ai" } })),
    ).toBeNull();
    expect(
      deserializeSettings(
        JSON.stringify({ v: 1, data: { mode: "x", difficulty: "hard", humanFirst: true } }),
      ),
    ).toBeNull();
  });

  it("reads a blob written before the no-undo option as undo-on", () => {
    const { allowUndo: _, ...legacy } = DEFAULT_SETTINGS;
    expect(deserializeSettings(JSON.stringify({ v: 1, data: legacy }))).toEqual(
      DEFAULT_SETTINGS,
    );
  });
});
