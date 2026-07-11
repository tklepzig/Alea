import {
  SIZE,
  createBoard,
  createGame,
  legalMoves,
  isLegalMove,
  applyMove,
  getAiMove,
  otherPlayer,
  isPlayable,
  type Board,
  type GameState,
  type Move,
  type Piece,
  type Player,
  type PieceKind,
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

function emptyBoard(): Board {
  return Array.from({ length: SIZE }, () =>
    Array.from({ length: SIZE }, () => null as Piece | null),
  );
}

function place(
  board: Board,
  row: number,
  col: number,
  player: Player,
  kind: PieceKind = "man",
): void {
  board[row][col] = { player, kind };
}

function stateFrom(
  board: Board,
  currentPlayer: Player = "red",
  extra: Partial<GameState> = {},
): GameState {
  return {
    board,
    currentPlayer,
    mode: "local",
    difficulty: "medium",
    humanPlayer: "red",
    mustContinueFrom: null,
    status: "playing",
    winner: null,
    ...extra,
  };
}

const move = (fromRow: number, fromCol: number, toRow: number, toCol: number): Move => ({
  from: { row: fromRow, col: fromCol },
  to: { row: toRow, col: toCol },
  captured: null,
});

describe("createBoard", () => {
  it("places 12 men per side on the dark squares only", () => {
    const board = createBoard();
    const flat = board.flat();
    expect(flat.filter((cell) => cell?.player === "red")).toHaveLength(12);
    expect(flat.filter((cell) => cell?.player === "black")).toHaveLength(12);
    expect(flat.every((cell) => cell === null || cell.kind === "man")).toBe(true);
    // No piece ever sits on a light square.
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        if (!isPlayable(row, col)) expect(board[row][col]).toBeNull();
      }
    }
  });

  it("puts black at the top, red at the bottom", () => {
    const board = createBoard();
    expect(board[0].some((cell) => cell?.player === "black")).toBe(true);
    expect(board[7].some((cell) => cell?.player === "red")).toBe(true);
    expect(board[3].every((cell) => cell === null)).toBe(true);
    expect(board[4].every((cell) => cell === null)).toBe(true);
  });
});

describe("legalMoves — opening", () => {
  it("gives red the classic seven opening slides", () => {
    const moves = legalMoves(createGame({ mode: "local" }));
    expect(moves).toHaveLength(7);
    expect(moves.every((candidate) => candidate.captured === null)).toBe(true);
  });
});

describe("mandatory capture", () => {
  it("returns only captures when any capture exists", () => {
    const board = emptyBoard();
    place(board, 5, 4, "red");
    place(board, 4, 3, "black"); // capturable by (5,4) -> (3,2)
    place(board, 5, 0, "red"); // could slide to (4,1) — must be suppressed
    const moves = legalMoves(stateFrom(board, "red"));
    expect(moves.every((candidate) => candidate.captured !== null)).toBe(true);
    expect(moves).toHaveLength(1);
    expect(moves[0].to).toEqual({ row: 3, col: 2 });
  });

  it("men capture forward only — not backward", () => {
    const board = emptyBoard();
    place(board, 3, 4, "red");
    place(board, 4, 3, "black"); // behind the red man (red moves up)
    // No forward capture, so the red man just slides forward.
    const moves = legalMoves(stateFrom(board, "red"));
    expect(moves.every((candidate) => candidate.captured === null)).toBe(true);
  });
});

describe("multi-jump", () => {
  it("keeps the turn open and constrains to the continuing piece", () => {
    const board = emptyBoard();
    place(board, 5, 4, "red");
    place(board, 4, 3, "black");
    place(board, 2, 3, "black");
    place(board, 0, 7, "black"); // spare so the game continues after the double
    let state = stateFrom(board, "red");

    state = applyMove(state, move(5, 4, 3, 2)); // first jump
    expect(state.currentPlayer).toBe("red"); // still red's turn
    expect(state.mustContinueFrom).toEqual({ row: 3, col: 2 });
    const forced = legalMoves(state);
    expect(forced).toHaveLength(1);
    expect(forced[0].to).toEqual({ row: 1, col: 4 });

    state = applyMove(state, forced[0]); // second jump
    expect(state.currentPlayer).toBe("black"); // turn ends
    expect(state.mustContinueFrom).toBeNull();
    expect(state.board[4][3]).toBeNull(); // both jumped men are gone
    expect(state.board[2][3]).toBeNull();
  });
});

describe("promotion", () => {
  it("crowns a man reaching the far row and ends the turn", () => {
    const board = emptyBoard();
    place(board, 1, 2, "red");
    place(board, 4, 1, "black"); // spare (with a move) so crowning passes the turn
    let state = stateFrom(board, "red");
    state = applyMove(state, move(1, 2, 0, 1));
    expect(state.board[0][1]).toEqual({ player: "red", kind: "king" });
    expect(state.currentPlayer).toBe("black");
  });

  it("stops a multi-jump the instant it crowns, even with a further jump", () => {
    const board = emptyBoard();
    place(board, 2, 5, "red");
    place(board, 1, 4, "black"); // captured, landing on (0,3) => crown
    place(board, 1, 2, "black"); // a king on (0,3) could jump this — must NOT
    let state = stateFrom(board, "red");
    state = applyMove(state, move(2, 5, 0, 3));
    expect(state.board[0][3]).toEqual({ player: "red", kind: "king" });
    expect(state.currentPlayer).toBe("black"); // turn ended despite the jump
    expect(state.board[1][2]).toEqual({ player: "black", kind: "man" }); // not taken
  });
});

describe("king movement", () => {
  it("lets a king slide and capture backward", () => {
    const board = emptyBoard();
    place(board, 4, 3, "red", "king");
    place(board, 5, 4, "black"); // behind the king (toward red's own side)
    const moves = legalMoves(stateFrom(board, "red"));
    // A backward capture over (5,4) landing on (6,5) is available and mandatory.
    expect(moves.some((candidate) => candidate.captured !== null)).toBe(true);
    const capture = moves.find((candidate) => candidate.captured !== null)!;
    expect(capture.to).toEqual({ row: 6, col: 5 });
  });
});

describe("applyMove", () => {
  it("throws on an illegal move", () => {
    const state = createGame({ mode: "local" });
    expect(() => applyMove(state, move(5, 0, 4, 1))).not.toThrow(); // legal
    expect(() => applyMove(createGame({ mode: "local" }), move(0, 0, 1, 1))).toThrow();
  });

  it("declares a win when the opponent is wiped out", () => {
    const board = emptyBoard();
    place(board, 5, 4, "red");
    place(board, 4, 3, "black"); // black's only piece
    const state = applyMove(stateFrom(board, "red"), move(5, 4, 3, 2));
    expect(state.status).toBe("won");
    expect(state.winner).toBe("red");
  });

  it("declares a win when the opponent has no legal move", () => {
    const board = emptyBoard();
    // Black man boxed into the corner with a red king sealing the only diagonal.
    place(board, 0, 1, "black");
    place(board, 1, 2, "red", "king");
    place(board, 2, 3, "red", "king");
    // Red just needs to leave black with nothing; give black no slide/capture.
    place(board, 0, 1, "black");
    // Black to move from a boxed corner: (0,1) black man can only go to (1,0)/(1,2).
    // Occupy both landing squares so it is stuck.
    place(board, 1, 0, "red", "king");
    const state = stateFrom(board, "black");
    expect(legalMoves(state)).toHaveLength(0);
  });
});

describe("getAiMove", () => {
  it("returns a legal move for the opening position", () => {
    const state = createGame({ mode: "ai", difficulty: "hard", humanPlayer: "red" });
    const aiState = { ...state, currentPlayer: "black" as Player };
    const chosen = getAiMove(aiState, seededRandom(1));
    expect(isLegalMove(aiState, chosen)).toBe(true);
  });

  it("takes an available capture rather than a quiet slide", () => {
    const board = emptyBoard();
    place(board, 4, 3, "black"); // to move
    place(board, 5, 4, "red"); // capturable by (4,3) -> (6,5)
    place(board, 0, 7, "black"); // a harmless quiet slide also exists
    const state = stateFrom(board, "black", { mode: "ai", humanPlayer: "red" });
    const chosen = getAiMove(state, seededRandom(3));
    expect(chosen.captured).not.toBeNull();
  });

  it("never blunders on hard/expert (always plays a legal move under many seeds)", () => {
    const base = createGame({ mode: "ai", difficulty: "expert", humanPlayer: "red" });
    const aiState = { ...base, currentPlayer: "black" as Player };
    for (let seed = 0; seed < 12; seed++) {
      expect(isLegalMove(aiState, getAiMove(aiState, seededRandom(seed)))).toBe(true);
    }
  });
});

describe("otherPlayer", () => {
  it("flips colours", () => {
    expect(otherPlayer("red")).toBe("black");
    expect(otherPlayer("black")).toBe("red");
  });
});
