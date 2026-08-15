import {
  SIZE,
  createBoard,
  createGame,
  legalMoves,
  isLegalMove,
  applyMove,
  getAiMove,
  getAiMoveIterative,
  otherPlayer,
  isPlayable,
  type Board,
  type GameState,
  type Move,
  type Piece,
  type Player,
  type PieceKind,
  type Square,
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
    flyingKings: false,
    maxCapture: false,
    mustContinueFrom: null,
    pendingCaptures: [],
    status: "playing",
    winner: null,
    ...extra,
  };
}

/** Stable ordering so a set of squares can be compared without caring about it. */
const bySquare = (first: Square, second: Square): number =>
  first.row - second.row || first.col - second.col;

const sameSquareAs = (square: Square, row: number, col: number): boolean =>
  square.row === row && square.col === col;

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

describe("Mehrschlagzwang (maxCapture)", () => {
  /** Two capture options: over (4,3) chains on to a second hop, over (4,5) stops. */
  function twoOptions(): Board {
    const board = emptyBoard();
    place(board, 5, 4, "red");
    place(board, 4, 3, "black");
    place(board, 2, 1, "black"); // the second hop of the long line
    place(board, 4, 5, "black"); // the short line
    return board;
  }

  it("is off by default — any capture may be chosen", () => {
    const moves = legalMoves(stateFrom(twoOptions(), "red"));
    expect(moves.map((candidate) => candidate.to).sort(bySquare)).toEqual([
      { row: 3, col: 2 },
      { row: 3, col: 6 },
    ]);
  });

  it("keeps only the captures that start the longest sequence", () => {
    const moves = legalMoves(stateFrom(twoOptions(), "red", { maxCapture: true }));
    expect(moves).toHaveLength(1);
    expect(moves[0].to).toEqual({ row: 3, col: 2 });
  });

  it("rejects a shorter capture as illegal", () => {
    const state = stateFrom(twoOptions(), "red", { maxCapture: true });
    expect(isLegalMove(state, move(5, 4, 3, 6))).toBe(false);
    expect(() => applyMove(state, move(5, 4, 3, 6))).toThrow();
  });

  it("keeps every line when two are equally long", () => {
    const board = emptyBoard();
    // Two mirrored double-capture lines — both take two men, so both stay legal.
    place(board, 5, 0, "red");
    place(board, 4, 1, "black");
    place(board, 2, 1, "black");
    place(board, 5, 4, "red");
    place(board, 4, 5, "black");
    place(board, 2, 5, "black");
    const state = stateFrom(board, "red", { maxCapture: true });
    const moves = legalMoves(state);
    expect(moves.map((candidate) => candidate.from).sort(bySquare)).toEqual([
      { row: 5, col: 0 },
      { row: 5, col: 4 },
    ]);
    expect(isLegalMove(state, move(5, 0, 3, 2))).toBe(true);
    expect(isLegalMove(state, move(5, 4, 3, 6))).toBe(true);
  });

  it("counts a crowning hop as the end of its sequence", () => {
    const board = emptyBoard();
    // The crowning line would jump on from (0,5) — but crowning ends the turn,
    // so it counts as one hop and the two-hop line elsewhere wins.
    place(board, 2, 7, "red");
    place(board, 1, 6, "black");
    place(board, 1, 4, "black");
    place(board, 5, 4, "red");
    place(board, 4, 3, "black");
    place(board, 2, 1, "black");
    const moves = legalMoves(stateFrom(board, "red", { maxCapture: true }));
    expect(moves).toHaveLength(1);
    expect(moves[0].from).toEqual({ row: 5, col: 4 });
  });

  it("also picks between the landing squares of a flying Dame", () => {
    const board = emptyBoard();
    place(board, 7, 0, "red", "king");
    place(board, 5, 2, "black");
    place(board, 3, 2, "black"); // only reachable when landing on (4,3)
    const state = stateFrom(board, "red", { flyingKings: true, maxCapture: true });
    const moves = legalMoves(state);
    expect(moves).toHaveLength(1);
    expect(moves[0].to).toEqual({ row: 4, col: 3 });
    // Without the rule every landing square beyond the jumped piece is legal.
    expect(legalMoves({ ...state, maxCapture: false })).toHaveLength(5);
  });

  it("narrows the continuation mid-chain too", () => {
    const board = emptyBoard();
    place(board, 5, 4, "red", "king");
    place(board, 4, 3, "black");
    // After landing on (3,2) two onward jumps exist, but only one chains further.
    place(board, 2, 1, "black");
    place(board, 2, 3, "black");
    place(board, 2, 5, "black");
    const state = applyMove(
      stateFrom(board, "red", { maxCapture: true }),
      move(5, 4, 3, 2),
    );
    expect(state.mustContinueFrom).toEqual({ row: 3, col: 2 });
    const forced = legalMoves(state);
    expect(forced).toHaveLength(1);
    expect(forced[0].to).toEqual({ row: 1, col: 4 }); // over (2,3), then on over (2,5)
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

  it("without the flying variant a king reaches exactly one square per diagonal", () => {
    const board = emptyBoard();
    place(board, 4, 3, "red", "king");
    const moves = legalMoves(stateFrom(board, "red"));
    expect(moves).toHaveLength(4);
    expect(moves.map((candidate) => candidate.to).sort(bySquare)).toEqual(
      [
        { row: 3, col: 2 },
        { row: 3, col: 4 },
        { row: 5, col: 2 },
        { row: 5, col: 4 },
      ].sort(bySquare),
    );
  });

  it("without the flying variant a king only jumps the adjacent square", () => {
    const board = emptyBoard();
    place(board, 7, 0, "red", "king");
    place(board, 5, 2, "black"); // two squares away — out of reach
    const moves = legalMoves(stateFrom(board, "red"));
    expect(moves.every((candidate) => candidate.captured === null)).toBe(true);
    expect(moves.map((candidate) => candidate.to)).toEqual([{ row: 6, col: 1 }]);
  });
});

describe("flying kings — movement", () => {
  const flying = { flyingKings: true } as const;

  it("slides a king along the whole free diagonal", () => {
    const board = emptyBoard();
    place(board, 7, 0, "red", "king");
    place(board, 3, 4, "red"); // own man blocks the diagonal
    const moves = legalMoves(stateFrom(board, "red", flying)).filter(
      (candidate) => candidate.from.row === 7,
    );
    expect(moves.map((candidate) => candidate.to)).toEqual([
      { row: 6, col: 1 },
      { row: 5, col: 2 },
      { row: 4, col: 3 },
    ]);
  });

  it("leaves men on a single step", () => {
    const board = emptyBoard();
    place(board, 7, 0, "red"); // a man, not a king
    const moves = legalMoves(stateFrom(board, "red", flying));
    expect(moves.map((candidate) => candidate.to)).toEqual([{ row: 6, col: 1 }]);
  });

  it("jumps a distant piece and may land on any free square beyond it", () => {
    const board = emptyBoard();
    place(board, 7, 0, "red", "king");
    place(board, 5, 2, "black");
    const moves = legalMoves(stateFrom(board, "red", flying));
    expect(moves.every((candidate) => candidate.captured !== null)).toBe(true);
    expect(moves.every((candidate) => sameSquareAs(candidate.captured!, 5, 2))).toBe(true);
    expect(moves.map((candidate) => candidate.to)).toEqual([
      { row: 4, col: 3 },
      { row: 3, col: 4 },
      { row: 2, col: 5 },
      { row: 1, col: 6 },
      { row: 0, col: 7 },
    ]);
  });

  it("cannot jump two pieces standing back to back, nor its own", () => {
    const backToBack = emptyBoard();
    place(backToBack, 7, 0, "red", "king");
    place(backToBack, 5, 2, "black");
    place(backToBack, 4, 3, "black"); // no free square behind the first one
    expect(
      legalMoves(stateFrom(backToBack, "red", flying)).every(
        (candidate) => candidate.captured === null,
      ),
    ).toBe(true);

    const ownPiece = emptyBoard();
    place(ownPiece, 7, 0, "red", "king");
    place(ownPiece, 5, 2, "red");
    place(ownPiece, 3, 4, "black"); // shielded by red's own man
    expect(
      legalMoves(stateFrom(ownPiece, "red", flying)).every(
        (candidate) => candidate.captured === null,
      ),
    ).toBe(true);
  });
});

describe("flying kings — multi-jump and deferred removal", () => {
  const flying = { flyingKings: true } as const;

  it("keeps a jumped piece on the board until the turn ends", () => {
    const board = emptyBoard();
    place(board, 5, 2, "red", "king");
    place(board, 4, 3, "black");
    place(board, 2, 5, "black");
    place(board, 0, 1, "black"); // spare so the game continues
    let state = stateFrom(board, "red", flying);

    state = applyMove(state, move(5, 2, 3, 4)); // jump (4,3), land short of (2,5)
    expect(state.currentPlayer).toBe("red");
    expect(state.mustContinueFrom).toEqual({ row: 3, col: 4 });
    expect(state.pendingCaptures).toEqual([{ row: 4, col: 3 }]);
    expect(state.board[4][3]).toEqual({ player: "black", kind: "man" }); // still there

    const forced = legalMoves(state);
    expect(forced.every((candidate) => sameSquareAs(candidate.captured!, 2, 5))).toBe(true);

    state = applyMove(state, move(3, 4, 1, 6)); // second jump ends the turn
    expect(state.currentPlayer).toBe("black");
    expect(state.pendingCaptures).toEqual([]);
    expect(state.board[4][3]).toBeNull(); // both swept off together
    expect(state.board[2][5]).toBeNull();
  });

  it("will not jump the same piece twice, even though its square looks empty", () => {
    // All on the (7,0)–(0,7) diagonal: Q(6,1) black, the red king (5,2),
    // A(4,3) black. Jumping A and landing on (3,4) leaves A in place, so the
    // way back to Q is blocked — with immediate removal the king could chain on.
    const board = emptyBoard();
    place(board, 6, 1, "black");
    place(board, 5, 2, "red", "king");
    place(board, 4, 3, "black");
    place(board, 0, 1, "black"); // spare so the game continues
    const state = applyMove(stateFrom(board, "red", flying), move(5, 2, 3, 4));

    expect(state.currentPlayer).toBe("black"); // turn ended, no continuation
    expect(state.board[4][3]).toBeNull(); // A swept
    expect(state.board[6][1]).toEqual({ player: "black", kind: "man" }); // Q survives
  });

  it("sweeps the captured piece when a crowning move cuts the chain short", () => {
    const board = emptyBoard();
    place(board, 2, 5, "red"); // a man — crowns on row 0
    place(board, 1, 4, "black");
    place(board, 1, 2, "black"); // a fresh king could jump this — must not
    const state = applyMove(stateFrom(board, "red", flying), move(2, 5, 0, 3));

    expect(state.board[0][3]).toEqual({ player: "red", kind: "king" });
    expect(state.board[1][4]).toBeNull();
    expect(state.pendingCaptures).toEqual([]);
    expect(state.board[1][2]).toEqual({ player: "black", kind: "man" });
  });

  it("still lets the AI find a legal move with the variant on", () => {
    const state = { ...createGame({ mode: "ai", difficulty: "expert", flyingKings: true }) };
    const board = state.board;
    board[4][3] = { player: "black", kind: "king" }; // a flying Dame in the open
    const chosen = getAiMove(state, seededRandom(7));
    expect(isLegalMove(state, chosen)).toBe(true);
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

// Iterative deepening exists so a killed search still leaves a playable move
// behind. It must not cost strength: the final depth is the same, so the move
// must be the same. Both entry points consume `random` identically up to the
// final tie-break, so a constant RNG makes them pick the *same* candidate out
// of the tied-best set — any divergence is a real change in what the AI plays.
describe("getAiMoveIterative — differential against getAiMove", () => {
  // A constant 0 would be worse than useless here: it satisfies
  // `random() < blunderRate` on easy (0.3) and medium (0.08), so BOTH functions
  // short-circuit to a random move and the comparison degenerates to
  // `moves[0] === moves[0]` — the search never runs. Roll high once to clear the
  // blunder check (both entry points consume that roll identically), then 0 for
  // every tie-break so each picks the first of the tied-best moves.
  const searchingRng = (difficulty: GameState["difficulty"]): (() => number) => {
    const rollsForBlunder = difficulty === "easy" || difficulty === "medium";
    let call = 0;
    return () => (rollsForBlunder && ++call === 1 ? 0.99 : 0);
  };

  /** Board from the frozen-tablet report: 14 pieces, no capture available, so
   *  nothing collapses the branching — the position that provoked all this. */
  function tabletPosition(): Board {
    const board = emptyBoard();
    place(board, 1, 2, "red", "king");
    for (const [row, col] of [[6, 7], [7, 0], [7, 2], [7, 4], [7, 6]]) {
      place(board, row, col, "red");
    }
    for (const [row, col] of [[0, 5], [0, 7], [3, 4], [3, 6], [4, 1], [5, 0], [5, 2], [5, 4]]) {
      place(board, row, col, "black");
    }
    return board;
  }

  function kingEndgame(): Board {
    const board = emptyBoard();
    place(board, 7, 0, "red", "king");
    place(board, 5, 2, "red", "king");
    place(board, 0, 1, "black", "king");
    place(board, 2, 3, "black", "king");
    return board;
  }

  const positions: [string, () => GameState][] = [
    ["opening", () => ({ ...createGame({ mode: "ai", humanPlayer: "red" }), currentPlayer: "black" })],
    ["tablet position", () => stateFrom(tabletPosition(), "black", { mode: "ai", humanPlayer: "red" })],
    ["king endgame", () => stateFrom(kingEndgame(), "red", { mode: "ai", humanPlayer: "black" })],
  ];

  for (const [label, build] of positions) {
    for (const difficulty of ["easy", "medium", "hard", "expert"] as const) {
      it(`picks the same move as getAiMove — ${label}, ${difficulty}`, () => {
        const state = { ...build(), difficulty };
        // Guard the guard: if the blunder path ever swallowed these again the
        // comparison would pass while proving nothing, so assert the ladder ran.
        const depths: number[] = [];
        const iterative = getAiMoveIterative(state, searchingRng(difficulty), {
          onDepth: (progress) => depths.push(progress.depth),
        });
        expect(depths.length).toBeGreaterThan(0);
        expect(iterative).toEqual(getAiMove(state, searchingRng(difficulty)));
      });
    }
  }

  it("matches getAiMove with flying kings on (ladder must still land on the target depth)", () => {
    const state = {
      ...stateFrom(kingEndgame(), "red", { mode: "ai", humanPlayer: "black" }),
      difficulty: "expert" as const,
      flyingKings: true,
    };
    expect(getAiMoveIterative(state, searchingRng("expert"))).toEqual(
      getAiMove(state, searchingRng("expert")),
    );
  });

  it("caps the ladder at maxDepth without touching the uncapped result", () => {
    const state = { ...stateFrom(tabletPosition(), "black", { mode: "ai", humanPlayer: "red" }), difficulty: "expert" as const };
    const depths: number[] = [];
    getAiMoveIterative(state, searchingRng("expert"), {
      maxDepth: 4,
      onDepth: (progress) => depths.push(progress.depth),
    });
    expect(depths).toEqual([2, 4]);
  });

  it("ignores a maxDepth deeper than the difficulty's own target", () => {
    const state = { ...stateFrom(tabletPosition(), "black", { mode: "ai", humanPlayer: "red" }), difficulty: "medium" as const };
    const depths: number[] = [];
    getAiMoveIterative(state, searchingRng("medium"), {
      maxDepth: 99,
      onDepth: (progress) => depths.push(progress.depth),
    });
    expect(depths).toEqual([2, 4]);
  });
});

describe("getAiMoveIterative — progress", () => {
  // 0.99 clears every blunderRate, so the search actually runs on easy/medium.
  const noBlunder = (): number => 0.99;

  const depthsFor = (state: GameState): number[] => {
    const depths: number[] = [];
    getAiMoveIterative(state, noBlunder, {
      onDepth: (progress) => depths.push(progress.depth),
    });
    return depths;
  };

  const aiOpening = (difficulty: GameState["difficulty"], flyingKings = false): GameState => ({
    ...createGame({ mode: "ai", humanPlayer: "red", difficulty, flyingKings }),
    currentPlayer: "black",
  });

  it.each([
    ["easy", [2]],
    ["medium", [2, 4]],
    ["hard", [2, 4, 6]],
    ["expert", [2, 4, 6, 8]],
  ] as const)("walks %s's ladder", (difficulty, expected) => {
    expect(depthsFor(aiOpening(difficulty))).toEqual(expected);
  });

  // Flying expert searches 5, which an even stride would step straight over —
  // the target has to be the last rung or the deepest result is never computed.
  it("ends on an odd target depth (flying expert = 5)", () => {
    expect(depthsFor(aiOpening("expert", true))).toEqual([2, 4, 5]);
  });

  it("reports a usable move at every depth, so a killed search leaves a fallback", () => {
    const state = aiOpening("hard");
    const reported: Move[] = [];
    getAiMoveIterative(state, noBlunder, {
      onDepth: (progress) => reported.push(progress.move),
    });
    expect(reported).toHaveLength(3);
    for (const candidate of reported) {
      expect(isLegalMove(state, candidate)).toBe(true);
    }
  });

  it("does not report progress when a blunder short-circuits the search", () => {
    const state = aiOpening("easy");
    const depths: number[] = [];
    getAiMoveIterative(state, () => 0, {
      onDepth: (progress) => depths.push(progress.depth),
    });
    expect(depths).toEqual([]);
  });
});

describe("otherPlayer", () => {
  it("flips colours", () => {
    expect(otherPlayer("red")).toBe("black");
    expect(otherPlayer("black")).toBe("red");
  });
});
