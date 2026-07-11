import {
  createBoard,
  dropDisc,
  checkWin,
  isBoardFull,
  applyMove,
  createGame,
  getAiMove,
  validColumns,
  otherPlayer,
  COLUMNS,
  ROWS,
  type Board,
  type Player,
} from "./game.js";

/** Deterministic RNG (mulberry32) so AI tie-breaks are reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Drop a sequence of discs into columns, throwing on an illegal drop. */
function play(columns: number[], players: Player[]): Board {
  let board = createBoard();
  columns.forEach((column, index) => {
    const dropped = dropDisc(board, column, players[index]);
    if (!dropped) throw new Error(`illegal drop in column ${column}`);
    board = dropped.board;
  });
  return board;
}

// Shorthands so the win fixtures below read as a list of (column, colour) drops.
const R = "red";
const Y = "yellow";

describe("createBoard / dropDisc", () => {
  it("creates 7 empty columns of 6", () => {
    const board = createBoard();
    expect(board).toHaveLength(COLUMNS);
    expect(board.every((column) => column.length === ROWS)).toBe(true);
    expect(board.every((column) => column.every((cell) => cell === null))).toBe(true);
  });

  it("stacks discs from the bottom up", () => {
    const { board, row } = dropDisc(createBoard(), 3, R)!;
    expect(row).toBe(0);
    expect(board[3][0]).toBe(R);
    const second = dropDisc(board, 3, Y)!;
    expect(second.row).toBe(1);
    expect(second.board[3][1]).toBe(Y);
  });

  it("does not mutate the input board", () => {
    const board = createBoard();
    dropDisc(board, 0, R);
    expect(board[0][0]).toBeNull();
  });

  it("returns null for a full column", () => {
    let board = createBoard();
    for (let i = 0; i < ROWS; i++) {
      board = dropDisc(board, 2, i % 2 === 0 ? R : Y)!.board;
    }
    expect(dropDisc(board, 2, R)).toBeNull();
  });

  it("returns null for an out-of-range column", () => {
    expect(dropDisc(createBoard(), -1, R)).toBeNull();
    expect(dropDisc(createBoard(), COLUMNS, R)).toBeNull();
  });
});

describe("checkWin — all four directions", () => {
  it("detects a horizontal four", () => {
    // red on the bottom row across cols 0-3; yellow stacks harmlessly on col 6.
    const board = play([0, 6, 1, 6, 2, 6, 3], [R, Y, R, Y, R, Y, R]);
    expect(checkWin(board, { column: 3, row: 0 })).toHaveLength(4);
  });

  it("detects a vertical four", () => {
    const board = play([2, 3, 2, 3, 2, 3, 2], [R, Y, R, Y, R, Y, R]);
    expect(checkWin(board, { column: 2, row: 3 })).toHaveLength(4);
  });

  it("detects a diagonal / (up-right) four", () => {
    // red on (0,0),(1,1),(2,2),(3,3); every filler is yellow so no stray line.
    const board = play(
      [0, 1, 1, 2, 2, 2, 3, 3, 3, 3],
      [R, Y, R, Y, Y, R, Y, Y, Y, R],
    );
    expect(checkWin(board, { column: 3, row: 3 })).toHaveLength(4);
  });

  it("detects a diagonal \\ (down-right) four", () => {
    // red on (3,3),(4,2),(5,1),(6,0); fillers all yellow.
    const board = play(
      [6, 5, 5, 4, 4, 4, 3, 3, 3, 3],
      [R, Y, R, Y, Y, R, Y, Y, Y, R],
    );
    expect(checkWin(board, { column: 3, row: 3 })).toHaveLength(4);
  });

  it("returns null when there is no four", () => {
    const board = play([0, 1, 2], [R, R, R]);
    expect(checkWin(board, { column: 2, row: 0 })).toBeNull();
  });
});

describe("isBoardFull — draw detection", () => {
  it("is false for an empty or partial board", () => {
    expect(isBoardFull(createBoard())).toBe(false);
    expect(isBoardFull(play([0, 1], [R, Y]))).toBe(false);
  });

  it("is true once every slot is filled", () => {
    // Fill every slot with a colouring that avoids any line of four (shift the
    // pattern by row across pairs of columns).
    let board = createBoard();
    for (let column = 0; column < COLUMNS; column++) {
      for (let row = 0; row < ROWS; row++) {
        const player: Player = (row + Math.floor(column / 2)) % 2 === 0 ? R : Y;
        board = dropDisc(board, column, player)!.board;
      }
    }
    expect(isBoardFull(board)).toBe(true);
  });
});

describe("applyMove — state transitions", () => {
  it("flips the current player after a non-winning move", () => {
    const game = createGame({ mode: "local" });
    expect(game.currentPlayer).toBe(R);
    const next = applyMove(game, 0);
    expect(next.currentPlayer).toBe(Y);
    expect(next.status).toBe("playing");
  });

  it("marks a win and records the winner and cells", () => {
    let game = createGame({ mode: "local" });
    for (const column of [0, 1, 0, 1, 0, 1]) game = applyMove(game, column);
    game = applyMove(game, 0); // red completes a vertical four in col 0
    expect(game.status).toBe("won");
    expect(game.winner).toBe(R);
    expect(game.winningCells).toHaveLength(4);
  });

  it("does not mutate the input state", () => {
    const game = createGame({ mode: "local" });
    applyMove(game, 0);
    expect(game.board[0][0]).toBeNull();
    expect(game.currentPlayer).toBe(R);
  });

  it("throws when playing on a finished game", () => {
    let game = createGame({ mode: "local" });
    for (const column of [0, 1, 0, 1, 0, 1]) game = applyMove(game, column);
    game = applyMove(game, 0); // red wins
    expect(() => applyMove(game, 2)).toThrow();
  });

  it("throws on a full column", () => {
    let game = createGame({ mode: "local" });
    for (let i = 0; i < ROWS; i++) game = applyMove(game, 0);
    expect(() => applyMove(game, 0)).toThrow();
  });
});

describe("getAiMove", () => {
  it("returns a valid column for every difficulty", () => {
    const board = createBoard();
    for (const difficulty of ["easy", "medium", "hard", "expert"] as const) {
      const column = getAiMove(board, R, difficulty, seededRandom(1));
      expect(validColumns(board)).toContain(column);
    }
  });

  // Tactical guarantees only hold on the blunder-free levels — "easy" and
  // "medium" can roll a random blunder that deliberately ignores wins/blocks.
  it("takes an immediate winning move (blunder-free levels)", () => {
    // red has three across the bottom (cols 0,1,2); col 3 completes the four.
    const board = play([0, 0, 1, 1, 2, 2], [R, Y, R, Y, R, Y]);
    expect(getAiMove(board, R, "hard", seededRandom(1))).toBe(3);
    expect(getAiMove(board, R, "expert", seededRandom(1))).toBe(3);
  });

  it("blocks the opponent's immediate winning move (blunder-free levels)", () => {
    // yellow threatens a horizontal win across cols 0,1,2; red must block at 3.
    const board = play([0, 1, 2, 6], [Y, Y, Y, R]);
    expect(getAiMove(board, R, "hard", seededRandom(1))).toBe(3);
    expect(getAiMove(board, R, "expert", seededRandom(1))).toBe(3);
  });

  it("can blunder past a winning move on easy", () => {
    // Same winning position as above (col 3 wins). Force the blunder: first
    // random < 0.3 fires it; the second indexes into the playable columns
    // [3,2,4,1,5,0,6], so 0.5 → index 3 → column 1, deliberately ignoring the win.
    const board = play([0, 0, 1, 1, 2, 2], [R, Y, R, Y, R, Y]);
    const sequence = [0.1, 0.5];
    let call = 0;
    const random = () => sequence[call++];
    expect(getAiMove(board, R, "easy", random)).toBe(1);
  });
});

describe("otherPlayer", () => {
  it("swaps the colour", () => {
    expect(otherPlayer(R)).toBe(Y);
    expect(otherPlayer(Y)).toBe(R);
  });
});
