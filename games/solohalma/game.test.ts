import {
  SIZE,
  CENTER,
  isHole,
  createBoard,
  legalMoves,
  movesFrom,
  isLegalMove,
  applyMove,
  pegCount,
  statusOf,
  isCenterFinish,
  type Board,
  type Move,
} from "./game.js";

function emptyHoles(): Board {
  return Array.from({ length: SIZE }, (_unused, row) =>
    Array.from({ length: SIZE }, (_alsoUnused, col) => (isHole(row, col) ? ("empty" as const) : null)),
  );
}

describe("board shape", () => {
  it("cuts the four 2×2 corners, leaving 33 holes", () => {
    let holes = 0;
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) if (isHole(row, col)) holes++;
    }
    expect(holes).toBe(33);
    expect(isHole(0, 0)).toBe(false); // corner
    expect(isHole(0, 3)).toBe(true); // top arm
    expect(isHole(3, 3)).toBe(true); // centre
  });

  it("starts with 32 pegs and an empty centre", () => {
    const board = createBoard();
    expect(pegCount(board)).toBe(32);
    expect(board[CENTER.row][CENTER.col]).toBe("empty");
    expect(board[0][0]).toBeNull();
  });
});

describe("legalMoves", () => {
  it("offers exactly four opening jumps into the centre", () => {
    const moves = legalMoves(createBoard());
    expect(moves).toHaveLength(4);
    expect(moves.every((move) => move.to.row === CENTER.row && move.to.col === CENTER.col)).toBe(true);
  });

  it("only jumps orthogonally over a peg into an empty hole", () => {
    const board = emptyHoles();
    board[3][3] = "peg";
    board[3][4] = "peg"; // jump right: over (3,4) into (3,5)
    const moves = movesFrom(board, { row: 3, col: 3 });
    expect(moves).toEqual([
      { from: { row: 3, col: 3 }, over: { row: 3, col: 4 }, to: { row: 3, col: 5 } },
    ]);
  });
});

describe("applyMove", () => {
  it("removes the jumped peg and lands in the target hole", () => {
    const board = createBoard();
    const move: Move = { from: { row: 1, col: 3 }, over: { row: 2, col: 3 }, to: { row: 3, col: 3 } };
    expect(isLegalMove(board, move)).toBe(true);
    const next = applyMove(board, move);
    expect(next[1][3]).toBe("empty");
    expect(next[2][3]).toBe("empty");
    expect(next[3][3]).toBe("peg");
    expect(pegCount(next)).toBe(pegCount(board) - 1);
  });

  it("throws on an illegal move", () => {
    expect(() => applyMove(createBoard(), { from: { row: 0, col: 3 }, over: { row: 1, col: 3 }, to: { row: 2, col: 3 } })).toThrow();
  });
});

describe("statusOf", () => {
  it("is playing at the start", () => {
    expect(statusOf(createBoard())).toBe("playing");
  });

  it("is solved with a single peg, and flags a centre finish", () => {
    const board = emptyHoles();
    board[CENTER.row][CENTER.col] = "peg";
    expect(statusOf(board)).toBe("solved");
    expect(isCenterFinish(board)).toBe(true);

    const offCentre = emptyHoles();
    offCentre[0][3] = "peg";
    expect(statusOf(offCentre)).toBe("solved");
    expect(isCenterFinish(offCentre)).toBe(false);
  });

  it("is stuck when pegs remain but no jump is possible", () => {
    const board = emptyHoles();
    // Two pegs far apart with no shared line — no jump exists.
    board[0][3] = "peg";
    board[6][3] = "peg";
    expect(statusOf(board)).toBe("stuck");
  });
});
