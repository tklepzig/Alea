import { createBoard, applyMove, isHole, SIZE, type Board, type Move } from "./game.js";
import { serializeGame, deserializeGame } from "./storage.js";

function emptyHoles(): Board {
  return Array.from({ length: SIZE }, (_unused, row) =>
    Array.from({ length: SIZE }, (_alsoUnused, col) => (isHole(row, col) ? ("empty" as const) : null)),
  );
}

describe("board persistence", () => {
  it("round-trips an in-progress board", () => {
    const opening: Move = { from: { row: 1, col: 3 }, over: { row: 2, col: 3 }, to: { row: 3, col: 3 } };
    const board = applyMove(createBoard(), opening);
    expect(deserializeGame(serializeGame(board))).toEqual(board);
  });

  it("rejects null, corrupt JSON, and the wrong schema version", () => {
    expect(deserializeGame(null)).toBeNull();
    expect(deserializeGame("nope")).toBeNull();
    expect(deserializeGame(JSON.stringify({ v: 7, data: [] }))).toBeNull();
  });

  it("rejects a board where a corner isn't null", () => {
    const broken = createBoard();
    broken[0][0] = "peg"; // (0,0) is a cut corner
    expect(deserializeGame(serializeGame(broken))).toBeNull();
  });

  it("rejects a solved board (only in-progress puzzles are resumable)", () => {
    const solved = emptyHoles();
    solved[3][3] = "peg";
    expect(deserializeGame(serializeGame(solved))).toBeNull();
  });

  it("rejects a stuck board", () => {
    const stuck = emptyHoles();
    stuck[0][3] = "peg";
    stuck[6][3] = "peg";
    expect(deserializeGame(serializeGame(stuck))).toBeNull();
  });

  it("rejects the wrong dimensions", () => {
    const broken = createBoard().slice(0, 4) as Board;
    expect(deserializeGame(serializeGame(broken))).toBeNull();
  });
});
