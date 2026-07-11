import {
  SIZE,
  createBoard,
  createGame,
  legalMoves,
  applyMove,
  isLegalMove,
  hasWon,
  targetCamp,
  getAiTurn,
  evaluate,
  otherPlayer,
  type Board,
  type GameState,
  type Move,
  type Player,
} from "./game.js";

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

function emptyBoard(): Board {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => null as Player | null));
}

function stateFrom(board: Board, currentPlayer: Player = "red", extra: Partial<GameState> = {}): GameState {
  return {
    board,
    currentPlayer,
    jumpingFrom: null,
    jumpChain: [],
    mode: "local",
    difficulty: "medium",
    humanPlayer: "red",
    status: "playing",
    winner: null,
    ...extra,
  };
}

function applyTurn(state: GameState, path: Move[]): GameState {
  return path.reduce((current, move) => applyMove(current, move), state);
}

describe("createBoard", () => {
  it("seeds two 10-piece corner camps", () => {
    const board = createBoard();
    expect(board.flat().filter((cell) => cell === "red")).toHaveLength(10);
    expect(board.flat().filter((cell) => cell === "blue")).toHaveLength(10);
    expect(board[0][0]).toBe("red"); // top-left corner
    expect(board[9][9]).toBe("blue"); // bottom-right corner
    expect(board[5][5]).toBeNull();
  });

  it("puts each camp opposite its target", () => {
    expect(targetCamp("red").has("9,9")).toBe(true);
    expect(targetCamp("blue").has("0,0")).toBe(true);
  });
});

describe("moves", () => {
  it("offers diagonal + orthogonal steps into empties", () => {
    const board = emptyBoard();
    board[5][5] = "red";
    const steps = legalMoves(stateFrom(board, "red")).filter((move) => move.kind === "step");
    expect(steps).toHaveLength(8); // all eight neighbours empty
  });

  it("jumps over an adjacent piece to the empty cell beyond", () => {
    const board = emptyBoard();
    board[5][5] = "red";
    board[5][6] = "blue"; // hop this
    const jumps = legalMoves(stateFrom(board, "red")).filter((move) => move.kind === "jump");
    expect(jumps).toContainEqual({ kind: "jump", from: { row: 5, col: 5 }, to: { row: 5, col: 7 } });
  });

  it("does not jump when the landing cell is blocked", () => {
    const board = emptyBoard();
    board[5][5] = "red";
    board[5][6] = "blue";
    board[5][7] = "blue"; // landing blocked
    const jumps = legalMoves(stateFrom(board, "red")).filter((move) => move.kind === "jump");
    expect(jumps.some((move) => move.kind === "jump" && move.to.col === 7)).toBe(false);
  });
});

describe("jump chains", () => {
  it("keeps the turn open after a jump and ends on 'end'", () => {
    const board = emptyBoard();
    board[5][5] = "red";
    board[5][6] = "blue";
    board[5][8] = "blue";
    board[9][9] = "blue"; // a spare so filling the camp isn't accidentally won
    let state = stateFrom(board, "red");

    state = applyMove(state, { kind: "jump", from: { row: 5, col: 5 }, to: { row: 5, col: 7 } });
    expect(state.currentPlayer).toBe("red"); // still red's turn
    expect(state.jumpingFrom).toEqual({ row: 5, col: 7 });

    const follow = legalMoves(state);
    expect(follow).toContainEqual({ kind: "end" });
    expect(follow).toContainEqual({ kind: "jump", from: { row: 5, col: 7 }, to: { row: 5, col: 9 } });

    state = applyMove(state, { kind: "jump", from: { row: 5, col: 7 }, to: { row: 5, col: 9 } });
    // No further jump available from (5,9) here → only "end" remains.
    expect(legalMoves(state)).toEqual([{ kind: "end" }]);
    state = applyMove(state, { kind: "end" });
    expect(state.currentPlayer).toBe("blue");
    expect(state.jumpingFrom).toBeNull();
  });

  it("a plain step ends the turn immediately", () => {
    const board = emptyBoard();
    board[5][5] = "red";
    board[9][9] = "blue";
    const state = applyMove(stateFrom(board, "red"), { kind: "step", from: { row: 5, col: 5 }, to: { row: 6, col: 6 } });
    expect(state.currentPlayer).toBe("blue");
  });
});

describe("winning", () => {
  it("wins when the last piece fills the opposite camp", () => {
    const board = emptyBoard();
    // Fill red's target (bottom-right) camp except the tip (6,9); park the 10th red beside it.
    for (const key of targetCamp("red")) {
      const [row, col] = key.split(",").map(Number);
      board[row][col] = "red";
    }
    board[6][9] = null; // leave the tip empty
    board[5][9] = "red"; // the 10th red, one step from the tip
    const state = stateFrom(board, "red");
    expect(hasWon(board, "red")).toBe(false);
    const won = applyMove(state, { kind: "step", from: { row: 5, col: 9 }, to: { row: 6, col: 9 } });
    expect(won.status).toBe("won");
    expect(won.winner).toBe("red");
  });
});

describe("getAiTurn", () => {
  it("returns a legal, turn-ending path from the opening", () => {
    const state = createGame({ mode: "ai", difficulty: "hard", humanPlayer: "blue" });
    const path = getAiTurn(state, seededRandom(1));
    expect(path.length).toBeGreaterThan(0);
    // Replaying it is legal at every step and hands the turn to blue.
    let current = state;
    for (const move of path) {
      expect(isLegalMove(current, move)).toBe(true);
      current = applyMove(current, move);
    }
    expect(current.currentPlayer).toBe("blue");
  });

  it("advances toward the goal (improves the evaluation)", () => {
    const state = createGame({ mode: "ai", difficulty: "hard", humanPlayer: "blue" });
    const before = evaluate(state.board, "red");
    const after = applyTurn(state, getAiTurn(state, seededRandom(2)));
    expect(evaluate(after.board, "red")).toBeGreaterThan(before);
  });

  it("prefers a long jump chain over a single step when it gains ground", () => {
    // A ladder of blue stones red can chain-jump straight toward its goal.
    const board = emptyBoard();
    board[1][1] = "red";
    board[2][2] = "blue";
    board[4][4] = "blue";
    board[0][0] = "blue"; // keep blue from being accidentally winnable/empty
    const state = stateFrom(board, "red", { mode: "ai", difficulty: "hard", humanPlayer: "blue" });
    const path = getAiTurn(state, seededRandom(5));
    expect(path.some((move) => move.kind === "jump")).toBe(true);
  });
});

describe("otherPlayer", () => {
  it("flips colours", () => {
    expect(otherPlayer("red")).toBe("blue");
    expect(otherPlayer("blue")).toBe("red");
  });
});
