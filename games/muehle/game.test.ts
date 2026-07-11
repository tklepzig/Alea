import {
  POINTS,
  ADJACENCY,
  MILLS,
  createBoard,
  createGame,
  legalMoves,
  isLegalMove,
  applyMove,
  formsMill,
  removableTargets,
  onBoardCount,
  phaseOf,
  getAiMove,
  otherPlayer,
  type Board,
  type GameState,
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

function stateFrom(
  board: Board,
  inHand: Record<Player, number>,
  currentPlayer: Player = "red",
  extra: Partial<GameState> = {},
): GameState {
  return {
    board,
    inHand,
    currentPlayer,
    pendingCapture: false,
    mode: "local",
    difficulty: "medium",
    humanPlayer: "red",
    status: "playing",
    winner: null,
    ...extra,
  };
}

describe("board graph", () => {
  it("has 24 points and a symmetric adjacency", () => {
    expect(ADJACENCY).toHaveLength(POINTS);
    for (let point = 0; point < POINTS; point++) {
      for (const neighbour of ADJACENCY[point]) {
        expect(ADJACENCY[neighbour]).toContain(point);
      }
    }
  });

  it("wires corners to two edges and edge-midpoints to four points", () => {
    expect([...ADJACENCY[0]].sort((first, second) => first - second)).toEqual([1, 7]); // outer TL corner
    expect([...ADJACENCY[9]].sort((first, second) => first - second)).toEqual([1, 8, 10, 17]); // middle top-mid (spoke)
  });

  it("has exactly 16 mills, each of three points", () => {
    expect(MILLS).toHaveLength(16);
    expect(MILLS.every((line) => line.length === 3)).toBe(true);
    expect(MILLS).toContainEqual([0, 1, 2]); // an outer ring mill
    expect(MILLS).toContainEqual([1, 9, 17]); // a spoke mill
  });
});

describe("placing phase", () => {
  it("offers every empty point as a placement", () => {
    const moves = legalMoves(createGame({ mode: "local" }));
    expect(moves).toHaveLength(POINTS);
    expect(moves.every((move) => move.kind === "place")).toBe(true);
  });

  it("forms a mill on placement and demands a capture", () => {
    const board = createBoard();
    board[0] = "red";
    board[1] = "red";
    board[8] = "blue";
    board[16] = "blue";
    let state = stateFrom(board, { red: 7, blue: 7 }, "red");
    state = applyMove(state, { kind: "place", to: 2 }); // completes 0-1-2
    expect(state.pendingCapture).toBe(true);
    expect(state.currentPlayer).toBe("red"); // still red's turn — the removal
    const removals = legalMoves(state);
    expect(removals.every((move) => move.kind === "remove")).toBe(true);
    expect(
      removals.map((move) => (move.kind === "remove" ? move.at : -1)).sort((first, second) => first - second),
    ).toEqual([8, 16]);

    state = applyMove(state, { kind: "remove", at: 8 });
    expect(state.board[8]).toBeNull();
    expect(state.currentPlayer).toBe("blue");
    expect(state.pendingCapture).toBe(false);
  });
});

describe("removableTargets", () => {
  it("protects stones inside a mill until only milled stones remain", () => {
    const board = createBoard();
    board[8] = "blue";
    board[9] = "blue";
    board[10] = "blue"; // a blue mill
    board[16] = "blue"; // loose stone
    expect(removableTargets(board, "blue")).toEqual([16]);

    board[16] = null; // now every blue stone is in the mill
    expect(removableTargets(board, "blue").sort((first, second) => first - second)).toEqual([8, 9, 10]);
  });
});

describe("phases", () => {
  it("moves to sliding once the hand is empty and flies at three stones", () => {
    const board = createBoard();
    board[0] = "red";
    board[1] = "red";
    board[2] = "red";
    board[3] = "red";
    const moving = stateFrom(board, { red: 0, blue: 0 }, "red");
    expect(phaseOf(moving, "red")).toBe("moving");

    board[3] = null; // down to three on the board
    const flying = stateFrom(board, { red: 0, blue: 0 }, "red");
    expect(phaseOf(flying, "red")).toBe("flying");
    // Flying: a stone may go to ANY empty point, not just neighbours.
    expect(legalMoves(flying).length).toBeGreaterThan(ADJACENCY[0].length);
  });

  it("restricts a moving stone to adjacent empties", () => {
    const board = createBoard();
    board[0] = "red";
    board[4] = "red";
    board[5] = "red";
    board[6] = "red"; // four stones so it slides rather than flies
    const state = stateFrom(board, { red: 0, blue: 0 }, "red");
    const fromZero = legalMoves(state).filter((move) => move.kind === "move" && move.from === 0);
    // Point 0 neighbours are 1 and 7, both empty here.
    expect(fromZero.map((move) => (move.kind === "move" ? move.to : -1)).sort()).toEqual([1, 7]);
  });
});

describe("win conditions", () => {
  it("wins by reducing the opponent below three stones", () => {
    const board = createBoard();
    board[0] = "red";
    board[1] = "red"; // red about to complete 0-1-2
    board[8] = "blue";
    board[9] = "blue";
    board[10] = "blue"; // blue mill (protected)
    // Blue has exactly 3 on the board and none in hand — one capture ends it.
    let state = stateFrom(board, { red: 6, blue: 0 }, "red");
    state = applyMove(state, { kind: "place", to: 2 });
    expect(state.pendingCapture).toBe(true);
    state = applyMove(state, { kind: "remove", at: 8 }); // all blue in a mill → any takeable
    expect(state.status).toBe("won");
    expect(state.winner).toBe("red");
  });

  it("wins when the opponent has no legal move", () => {
    const board = createBoard();
    // Blue corners boxed in by red edge stones.
    for (const corner of [0, 2, 4, 6]) board[corner] = "blue";
    for (const edge of [1, 3, 5, 7]) board[edge] = "red";
    board[16] = "red"; // a red stone with an empty neighbour, so red can move
    const state = stateFrom(board, { red: 0, blue: 0 }, "red");
    const next = applyMove(state, { kind: "move", from: 16, to: 17 });
    expect(next.currentPlayer).toBe("blue");
    expect(next.status).toBe("won");
    expect(next.winner).toBe("red");
  });
});

describe("getAiMove", () => {
  it("returns a legal opening placement", () => {
    const state = createGame({ mode: "ai", difficulty: "hard", humanPlayer: "blue" });
    const chosen = getAiMove(state, seededRandom(1));
    expect(isLegalMove(state, chosen)).toBe(true);
  });

  it("completes a mill when one placement away from it", () => {
    const board = createBoard();
    board[0] = "red";
    board[1] = "red";
    board[12] = "blue";
    board[20] = "blue";
    const state = stateFrom(board, { red: 7, blue: 7 }, "red", { mode: "ai", humanPlayer: "blue" });
    const chosen = getAiMove(state, seededRandom(4));
    expect(chosen).toEqual({ kind: "place", to: 2 });
  });
});

describe("otherPlayer / counts", () => {
  it("flips colours and counts the board", () => {
    expect(otherPlayer("red")).toBe("blue");
    const board = createBoard();
    board[0] = "red";
    board[5] = "red";
    expect(onBoardCount(board, "red")).toBe(2);
    expect(onBoardCount(board, "blue")).toBe(0);
  });
});
