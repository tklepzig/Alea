import { SIZE, applyMove, createGame, type Board, type GameState, type Square } from "./game";
import {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  deserializeGame,
  deserializeSettings,
  isSettings,
  serializeGame,
  serializeSettings,
} from "./storage";

const at = (name: string): Square => ({
  row: SIZE - Number(name[1]),
  col: "abcdefgh".indexOf(name[0]),
});

const clone = (board: Board): Board => board.map((row) => row.slice());

/** A mid-game state: 1. e4 e5 2. Nf3 — castling rights partly intact, a real
 *  position history, non-zero clock. */
function midGame(): GameState {
  let state = createGame({ mode: "ai", difficulty: "hard", humanPlayer: "white" });
  state = applyMove(state, { from: at("e2"), to: at("e4"), captured: null, promotion: null, castle: null });
  state = applyMove(state, { from: at("e7"), to: at("e5"), captured: null, promotion: null, castle: null });
  state = applyMove(state, { from: at("g1"), to: at("f3"), captured: null, promotion: null, castle: null });
  return state;
}

/** Round-trip a state through a hand-tweaked copy, as a stored blob would be. */
const store = (state: GameState): string =>
  JSON.stringify({ v: SCHEMA_VERSION, data: state });

describe("settings", () => {
  test("round-trips", () => {
    expect(deserializeSettings(serializeSettings(DEFAULT_SETTINGS))).toEqual(DEFAULT_SETTINGS);
  });

  test("rejects junk, a wrong version and a bad field", () => {
    expect(deserializeSettings(null)).toBeNull();
    expect(deserializeSettings("{oops")).toBeNull();
    expect(deserializeSettings(JSON.stringify({ v: 99, data: DEFAULT_SETTINGS }))).toBeNull();
    expect(
      deserializeSettings(
        JSON.stringify({ v: SCHEMA_VERSION, data: { ...DEFAULT_SETTINGS, difficulty: "insane" } }),
      ),
    ).toBeNull();
    expect(isSettings({ mode: "ai" })).toBe(false);
  });

  test("reads a blob written before the no-undo option as undo-on", () => {
    const { allowUndo: _, ...legacy } = DEFAULT_SETTINGS;
    expect(deserializeSettings(JSON.stringify({ v: 1, data: legacy }))).toEqual(
      DEFAULT_SETTINGS,
    );
  });
});

describe("game state", () => {
  test("round-trips a mid-game position", () => {
    const state = midGame();
    const restored = deserializeGame(serializeGame(state));
    expect(restored).toEqual(state);
  });

  test("rejects corrupt JSON and an old schema", () => {
    expect(deserializeGame(null)).toBeNull();
    expect(deserializeGame("not json")).toBeNull();
    expect(deserializeGame(JSON.stringify({ v: 0, data: midGame() }))).toBeNull();
  });

  test("rejects a board of the wrong shape", () => {
    const state = midGame();
    expect(deserializeGame(store({ ...state, board: state.board.slice(1) }))).toBeNull();
    expect(deserializeGame(store({ ...state, board: "nope" as unknown as Board }))).toBeNull();
  });

  test("rejects two kings of one colour and a missing king", () => {
    const state = midGame();
    const twoKings = clone(state.board);
    twoKings[at("d4").row][at("d4").col] = { player: "white", kind: "king" };
    expect(deserializeGame(store({ ...state, board: twoKings }))).toBeNull();

    const noKing = clone(state.board);
    noKing[at("e8").row][at("e8").col] = null;
    expect(deserializeGame(store({ ...state, board: noKing }))).toBeNull();
  });

  test("rejects a pawn parked on a promotion rank", () => {
    const state = midGame();
    const board = clone(state.board);
    board[at("a8").row][at("a8").col] = { player: "white", kind: "pawn" };
    expect(deserializeGame(store({ ...state, board }))).toBeNull();
  });

  test("rejects castling rights that the board contradicts", () => {
    const state = midGame();
    const board = clone(state.board);
    board[at("h1").row][at("h1").col] = null; // rook gone, right claims otherwise
    expect(deserializeGame(store({ ...state, board }))).toBeNull();

    const moved = clone(state.board);
    moved[at("e1").row][at("e1").col] = null;
    moved[at("e2").row][at("e2").col] = { player: "white", kind: "king" };
    expect(deserializeGame(store({ ...state, board: moved }))).toBeNull();
  });

  test("accepts a genuine en-passant target and rejects a fabricated one", () => {
    let state = createGame({ mode: "ai" });
    state = applyMove(state, { from: at("e2"), to: at("e4"), captured: null, promotion: null, castle: null });
    expect(state.enPassant).toEqual(at("e3"));
    expect(deserializeGame(serializeGame(state))).toEqual(state);

    expect(deserializeGame(store({ ...state, enPassant: at("d6") }))).toBeNull();
    expect(deserializeGame(store({ ...state, enPassant: { row: 9, col: 0 } }))).toBeNull();
  });

  test("rejects an en-passant target with no pawn behind it, or an occupied one", () => {
    let state = createGame({ mode: "ai" });
    state = applyMove(state, { from: at("e2"), to: at("e4"), captured: null, promotion: null, castle: null });
    // d3 is the right rank and empty, but no white pawn ever stepped past it.
    expect(deserializeGame(store({ ...state, enPassant: at("d3") }))).toBeNull();

    // The target square itself must be empty — a pawn cannot land on a piece.
    const occupied = clone(state.board);
    occupied[at("e3").row][at("e3").col] = { player: "black", kind: "knight" };
    expect(deserializeGame(store({ ...state, board: occupied }))).toBeNull();
  });

  test("rejects a position where the side that just moved is left in check", () => {
    // Impossible in a real game — leavesKingInCheck filters it — but a resumed
    // blob like this lets the AI "capture" the king and leave a kingless board.
    const state = midGame();
    const board = clone(state.board);
    board[at("e4").row][at("e4").col] = null; // clear the pawn blocking the e-file
    board[at("e5").row][at("e5").col] = { player: "black", kind: "rook" }; // now checks e1
    expect(deserializeGame(store({ ...state, board, currentPlayer: "black" }))).toBeNull();
  });

  test("rejects a history that does not line up with the halfmove clock", () => {
    // The two reset and grow together, so anything else is doctored — and a
    // seeded duplicate key would report a repetition draw on the next move.
    const state = midGame();
    expect(state.positionHistory).toHaveLength(state.halfmoveClock + 1);
    expect(deserializeGame(store({ ...state, positionHistory: [...state.positionHistory, "extra"] }))).toBeNull();
    expect(deserializeGame(store({ ...state, positionHistory: [] }))).toBeNull();
  });

  test("rejects an out-of-range halfmove clock and an oversized history", () => {
    const state = midGame();
    expect(deserializeGame(store({ ...state, halfmoveClock: -1 }))).toBeNull();
    expect(deserializeGame(store({ ...state, halfmoveClock: 100 }))).toBeNull();
    expect(
      deserializeGame(store({ ...state, positionHistory: new Array(200).fill("x") })),
    ).toBeNull();
    expect(
      deserializeGame(store({ ...state, positionHistory: [1 as unknown as string] })),
    ).toBeNull();
  });

  test("rejects a finished game — only in-progress games are persisted", () => {
    const state = midGame();
    expect(deserializeGame(store({ ...state, status: "won", winner: "white" }))).toBeNull();
    expect(deserializeGame(store({ ...state, status: "draw", drawReason: "fifty" }))).toBeNull();
  });
});
