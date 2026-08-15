import {
  SIZE,
  applyMove,
  createBoard,
  createGame,
  emptyBoard,
  evaluate,
  findKing,
  getAiMove,
  getAiMoveIterative,
  isInCheck,
  isInsufficientMaterial,
  isLegalMove,
  isSquareAttacked,
  legalMoves,
  otherPlayer,
  squareName,
  type Board,
  type GameState,
  type Move,
  type Piece,
  type PieceKind,
  type Player,
  type PromotionKind,
  type Square,
} from "./game";

// --- fixture helpers -------------------------------------------------------

/** "e4" → {row, col}. */
const at = (name: string): Square => ({
  row: SIZE - Number(name[1]),
  col: "abcdefgh".indexOf(name[0]),
});

const put = (board: Board, name: string, player: Player, kind: PieceKind): void => {
  const square = at(name);
  board[square.row][square.col] = { player, kind };
};

/** A state with only the given pieces on the board — `spec` is "e1:white:king". */
function position(
  currentPlayer: Player,
  spec: string[],
  overrides: Partial<GameState> = {},
): GameState {
  const board = emptyBoard();
  for (const entry of spec) {
    const [name, player, kind] = entry.split(":");
    put(board, name, player as Player, kind as PieceKind);
  }
  return {
    board,
    currentPlayer,
    mode: "local",
    difficulty: "medium",
    humanPlayer: "white",
    castling: { white: { king: false, queen: false }, black: { king: false, queen: false } },
    enPassant: null,
    halfmoveClock: 0,
    positionHistory: [],
    status: "playing",
    winner: null,
    drawReason: null,
    ...overrides,
  };
}

const move = (from: string, to: string, promotion: PromotionKind | null = null): Move => ({
  from: at(from),
  to: at(to),
  captured: null,
  promotion,
  castle: null,
});

const targetsFrom = (state: GameState, from: string): string[] =>
  legalMoves(state)
    .filter((candidate) => candidate.from.row === at(from).row && candidate.from.col === at(from).col)
    .map((candidate) => squareName(candidate.to))
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort();

const pieceOn = (board: Board, name: string): Piece | null => board[at(name).row][at(name).col];

// --- setup -----------------------------------------------------------------

describe("initial position", () => {
  test("has 32 pieces with kings on e1/e8", () => {
    const board = createBoard();
    const count = board.flat().filter((cell) => cell !== null).length;
    expect(count).toBe(32);
    expect(pieceOn(board, "e1")).toEqual({ player: "white", kind: "king" });
    expect(pieceOn(board, "e8")).toEqual({ player: "black", kind: "king" });
    expect(pieceOn(board, "a1")).toEqual({ player: "white", kind: "rook" });
    expect(pieceOn(board, "d8")).toEqual({ player: "black", kind: "queen" });
  });

  test("White opens with 20 legal moves", () => {
    expect(legalMoves(createGame({ mode: "local" }))).toHaveLength(20);
  });
});

describe("move generation", () => {
  test("a knight on a rim square has fewer targets than a central one", () => {
    const rim = position("white", ["e1:white:king", "a1:white:knight"]);
    expect(targetsFrom(rim, "a1")).toEqual(["b3", "c2"]);
    const centre = position("white", ["e1:white:king", "d4:white:knight"]);
    expect(targetsFrom(centre, "d4")).toHaveLength(8);
  });

  test("a rook is blocked by its own piece and stops on an enemy", () => {
    const state = position("white", [
      "e1:white:king",
      "a1:white:rook",
      "a4:white:pawn",
      "d1:black:pawn",
    ]);
    expect(targetsFrom(state, "a1")).toEqual(["a2", "a3", "b1", "c1", "d1"]);
  });

  test("a pawn may double-step only from its start row", () => {
    const start = position("white", ["e1:white:king", "d2:white:pawn"]);
    expect(targetsFrom(start, "d2")).toEqual(["d3", "d4"]);
    const advanced = position("white", ["e1:white:king", "d3:white:pawn"]);
    expect(targetsFrom(advanced, "d3")).toEqual(["d4"]);
  });

  test("a pawn captures diagonally but not straight ahead", () => {
    const state = position("white", [
      "e1:white:king",
      "d4:white:pawn",
      "d5:black:pawn",
      "e5:black:knight",
    ]);
    expect(targetsFrom(state, "d4")).toEqual(["e5"]);
  });
});

describe("check", () => {
  test("isSquareAttacked sees every attacker type", () => {
    const knight = emptyBoard();
    put(knight, "d4", "black", "knight");
    expect(isSquareAttacked(knight, at("e6"), "black")).toBe(true);
    expect(isSquareAttacked(knight, at("e5"), "black")).toBe(false); // not a knight jump

    const pawn = emptyBoard();
    put(pawn, "d4", "black", "pawn"); // black pawns attack downward
    expect(isSquareAttacked(pawn, at("e3"), "black")).toBe(true);
    expect(isSquareAttacked(pawn, at("e5"), "black")).toBe(false);

    const sliders = emptyBoard();
    put(sliders, "a1", "white", "rook");
    put(sliders, "h8", "white", "bishop");
    put(sliders, "a4", "black", "pawn"); // blocks the rook's file
    expect(isSquareAttacked(sliders, at("a4"), "white")).toBe(true);
    expect(isSquareAttacked(sliders, at("a6"), "white")).toBe(false);
    expect(isSquareAttacked(sliders, at("d4"), "white")).toBe(true); // bishop on the long diagonal

    const king = emptyBoard();
    put(king, "e1", "white", "king");
    expect(isSquareAttacked(king, at("d2"), "white")).toBe(true);
    expect(isSquareAttacked(king, at("d3"), "white")).toBe(false);
  });

  test("a pinned piece cannot move away from the pin line", () => {
    const state = position("white", [
      "e1:white:king",
      "e2:white:bishop",
      "e8:black:rook",
    ]);
    // The bishop is pinned along the e-file — every bishop move leaves check.
    expect(targetsFrom(state, "e2")).toEqual([]);
  });

  test("in check, only moves that resolve it are legal", () => {
    const state = position("black", [
      "e1:white:king",
      "e8:black:king",
      "h5:white:queen",
      "f7:black:pawn",
    ]);
    expect(isInCheck(state.board, "black")).toBe(false);
    const checking = position("black", ["e1:white:king", "e8:black:king", "e4:white:rook"]);
    expect(isInCheck(checking.board, "black")).toBe(true);
    for (const candidate of legalMoves(checking)) {
      expect(candidate.to.col).not.toBe(4); // the king must leave the e-file
    }
  });

  test("a king may not move into check", () => {
    const state = position("white", ["e1:white:king", "a2:black:rook"]);
    expect(targetsFrom(state, "e1")).toEqual(["d1", "f1"]);
  });
});

describe("castling", () => {
  const rights = { white: { king: true, queen: true }, black: { king: false, queen: false } };
  const base = ["e1:white:king", "a1:white:rook", "h1:white:rook", "e8:black:king"];

  test("both sides are available and move the rook along", () => {
    const state = position("white", base, { castling: rights });
    expect(targetsFrom(state, "e1")).toEqual(["c1", "d1", "d2", "e2", "f1", "f2", "g1"]);

    const short = applyMove(state, move("e1", "g1"));
    expect(pieceOn(short.board, "g1")).toEqual({ player: "white", kind: "king" });
    expect(pieceOn(short.board, "f1")).toEqual({ player: "white", kind: "rook" });
    expect(pieceOn(short.board, "h1")).toBeNull();

    const long = applyMove(state, move("e1", "c1"));
    expect(pieceOn(long.board, "c1")).toEqual({ player: "white", kind: "king" });
    expect(pieceOn(long.board, "d1")).toEqual({ player: "white", kind: "rook" });
    expect(pieceOn(long.board, "a1")).toBeNull();
  });

  test("moving the king or a rook forfeits the rights", () => {
    const state = position("white", base, { castling: rights });
    const afterKing = applyMove(state, move("e1", "f1"));
    expect(afterKing.castling.white).toEqual({ king: false, queen: false });

    const afterRook = applyMove(state, move("h1", "h5"));
    expect(afterRook.castling.white).toEqual({ king: false, queen: true });
  });

  test("capturing a rook on its home square forfeits that right", () => {
    const state = position("black", [...base, "h5:black:rook"], {
      castling: { white: { king: true, queen: true }, black: { king: false, queen: false } },
    });
    const after = applyMove(state, move("h5", "h1"));
    expect(after.castling.white).toEqual({ king: false, queen: true });
  });

  test("a piece between king and rook blocks it", () => {
    const state = position("white", [...base, "f1:white:bishop"], { castling: rights });
    expect(targetsFrom(state, "e1")).not.toContain("g1");
    expect(targetsFrom(state, "e1")).toContain("c1");
  });

  test("castling out of check is illegal", () => {
    const state = position("white", [...base, "e5:black:rook"], { castling: rights });
    expect(targetsFrom(state, "e1")).toEqual(["d1", "d2", "f1", "f2"]);
    expect(targetsFrom(state, "e1")).not.toContain("c1");
  });

  test("castling through an attacked square is illegal", () => {
    const state = position("white", [...base, "f5:black:rook"], { castling: rights });
    expect(targetsFrom(state, "e1")).not.toContain("g1");
    expect(targetsFrom(state, "e1")).toContain("c1");
  });

  test("queenside is allowed even when b1 is attacked", () => {
    const state = position("white", [...base, "b5:black:rook"], { castling: rights });
    expect(targetsFrom(state, "e1")).toContain("c1");
  });
});

describe("en passant", () => {
  test("a double step opens the target for exactly one ply", () => {
    const state = position("white", [
      "e1:white:king",
      "e8:black:king",
      "d2:white:pawn",
      "c4:black:pawn",
      "h7:black:pawn",
    ]);
    const afterDouble = applyMove(state, move("d2", "d4"));
    expect(afterDouble.enPassant).toEqual(at("d3"));
    expect(targetsFrom(afterDouble, "c4")).toContain("d3");

    // Any other move clears it again.
    const later = applyMove(afterDouble, move("h7", "h6"));
    expect(later.enPassant).toBeNull();
  });

  test("the captured pawn is removed from beside, not from the target square", () => {
    const state = position(
      "black",
      ["e1:white:king", "e8:black:king", "d4:white:pawn", "c4:black:pawn"],
      { enPassant: at("d3") },
    );
    const after = applyMove(state, move("c4", "d3"));
    expect(pieceOn(after.board, "d3")).toEqual({ player: "black", kind: "pawn" });
    expect(pieceOn(after.board, "d4")).toBeNull();
    expect(pieceOn(after.board, "c4")).toBeNull();
  });

  test("generating an en passant leaves the board untouched for later moves", () => {
    // leavesKingInCheck plays each candidate on the live board and takes it
    // back. En passant is the only case where the captured pawn isn't on the
    // destination square, so it is the only leg whose restore actually matters:
    // if it leaks, the black pawn stays deleted and the king's moves are then
    // generated against a board that is missing a piece.
    const state = position(
      "white",
      ["f3:white:king", "e5:white:pawn", "d5:black:pawn", "e8:black:king"],
      { enPassant: at("d6") },
    );
    const before = JSON.stringify(state.board);
    // e4 is guarded by the d5 pawn — it may only disappear from the king's
    // targets, never appear, and it appears if the e.p. restore leaked.
    expect(targetsFrom(state, "f3")).not.toContain("e4");
    expect(JSON.stringify(state.board)).toBe(before); // generation is side-effect free
  });

  test("an en passant capture that exposes the own king is illegal", () => {
    // White king, black pawn and white pawn share rank 5 with a black rook —
    // taking en passant would clear both blockers off the rank at once.
    const state = position(
      "white",
      ["h5:white:king", "e5:white:pawn", "d5:black:pawn", "a5:black:rook", "e8:black:king"],
      { enPassant: at("d6") },
    );
    expect(targetsFrom(state, "e5")).toEqual(["e6"]);
  });
});

describe("promotion", () => {
  test("a pawn reaching the last rank offers all four pieces", () => {
    const state = position("white", ["e1:white:king", "e8:black:king", "b7:white:pawn"]);
    const promotions = legalMoves(state)
      .filter((candidate) => candidate.to.row === 0 && candidate.to.col === 1)
      .map((candidate) => candidate.promotion)
      .sort();
    expect(promotions).toEqual(["bishop", "knight", "queen", "rook"]);
  });

  test("the chosen piece is what lands on the square", () => {
    const state = position("white", ["e1:white:king", "e8:black:king", "b7:white:pawn"]);
    expect(pieceOn(applyMove(state, move("b7", "b8", "queen")).board, "b8")).toEqual({
      player: "white",
      kind: "queen",
    });
    expect(pieceOn(applyMove(state, move("b7", "b8", "knight")).board, "b8")).toEqual({
      player: "white",
      kind: "knight",
    });
  });

  test("a capture-promotion works too", () => {
    const state = position("white", [
      "e1:white:king",
      "e8:black:king",
      "b7:white:pawn",
      "c8:black:rook",
    ]);
    const after = applyMove(state, move("b7", "c8", "rook"));
    expect(pieceOn(after.board, "c8")).toEqual({ player: "white", kind: "rook" });
  });

  test("a promotion move without the piece named is not legal", () => {
    const state = position("white", ["e1:white:king", "e8:black:king", "b7:white:pawn"]);
    expect(isLegalMove(state, move("b7", "b8"))).toBe(false);
    expect(isLegalMove(state, move("b7", "b8", "queen"))).toBe(true);
  });
});

describe("game end", () => {
  test("back-rank mate ends the game", () => {
    const state = position("white", [
      "h8:black:king",
      "g7:black:pawn",
      "h7:black:pawn",
      "a1:white:rook",
      "e1:white:king",
    ]);
    const after = applyMove(state, move("a1", "a8"));
    expect(after.status).toBe("won");
    expect(after.winner).toBe("white");
    expect(legalMoves(after)).toEqual([]);
  });

  test("stalemate is a draw", () => {
    // Qg6 leaves the black king on h8 unattacked with every escape covered.
    const state = position("white", ["h8:black:king", "f7:white:queen", "f6:white:king"]);
    const after = applyMove(state, move("f7", "g6"));
    expect(after.status).toBe("draw");
    expect(after.drawReason).toBe("stalemate");
  });

  test("insufficient material is recognised", () => {
    const bareKings = emptyBoard();
    put(bareKings, "e1", "white", "king");
    put(bareKings, "e8", "black", "king");
    expect(isInsufficientMaterial(bareKings)).toBe(true);

    const withKnight = bareKings.map((row) => row.slice());
    put(withKnight, "b1", "white", "knight");
    expect(isInsufficientMaterial(withKnight)).toBe(true);

    const withRook = bareKings.map((row) => row.slice());
    put(withRook, "a1", "white", "rook");
    expect(isInsufficientMaterial(withRook)).toBe(false);

    const twoKnights = bareKings.map((row) => row.slice());
    put(twoKnights, "b1", "white", "knight");
    put(twoKnights, "g1", "white", "knight");
    expect(isInsufficientMaterial(twoKnights)).toBe(false);
  });

  test("opposing bishops draw only when they share a square colour", () => {
    const kings = emptyBoard();
    put(kings, "e1", "white", "king");
    put(kings, "e8", "black", "king");

    // c1 and f8 are both dark squares — neither side can ever mate.
    const sameShade = kings.map((row) => row.slice());
    put(sameShade, "c1", "white", "bishop");
    put(sameShade, "f8", "black", "bishop");
    expect(isInsufficientMaterial(sameShade)).toBe(true);

    // c1 (dark) against c8 (light) — mate stays possible, so play on.
    const opposite = kings.map((row) => row.slice());
    put(opposite, "c1", "white", "bishop");
    put(opposite, "c8", "black", "bishop");
    expect(isInsufficientMaterial(opposite)).toBe(false);
  });

  test("a capture down to bare kings ends in a material draw", () => {
    // Nxd5 leaves king+knight against a bare king — nobody can ever mate.
    const state = position("white", [
      "e1:white:king",
      "e8:black:king",
      "f4:white:knight",
      "d5:black:knight",
    ]);
    const after = applyMove(state, move("f4", "d5"));
    expect(after.status).toBe("draw");
    expect(after.drawReason).toBe("material");
  });

  test("the fifty-move rule draws once the clock runs out", () => {
    const state = position(
      "white",
      ["e1:white:king", "e8:black:king", "a1:white:rook", "h8:black:rook"],
      { halfmoveClock: 99 },
    );
    const after = applyMove(state, move("a1", "a2"));
    expect(after.halfmoveClock).toBe(100);
    expect(after.status).toBe("draw");
    expect(after.drawReason).toBe("fifty");
  });

  test("a capture resets the halfmove clock", () => {
    const state = position(
      "white",
      ["e1:white:king", "e8:black:king", "a1:white:rook", "a7:black:rook"],
      { halfmoveClock: 40 },
    );
    expect(applyMove(state, move("a1", "a7")).halfmoveClock).toBe(0);
  });

  test("threefold repetition draws", () => {
    let state = position("white", [
      "e1:white:king",
      "e8:black:king",
      "a1:white:rook",
      "h8:black:rook",
    ]);
    // Shuffle both rooks back and forth until the start position appears a third time.
    const cycle = [
      move("a1", "a2"),
      move("h8", "h7"),
      move("a2", "a1"),
      move("h7", "h8"),
    ];
    for (const step of [...cycle, ...cycle, ...cycle]) {
      if (state.status !== "playing") break;
      state = applyMove(state, step);
    }
    expect(state.status).toBe("draw");
    expect(state.drawReason).toBe("repetition");
  });

  test("a king/knight shuffle is not mistaken for a repetition", () => {
    // Both pieces encode as "k" if the position key uses kind[0], which merges
    // (Kc3,Nd5) with (Kd5,Nc3) and reaches three "repeats" of positions that
    // each occurred twice.
    let state = position("white", [
      "c3:white:king",
      "d5:white:knight",
      "h8:black:king",
      "a8:black:rook",
    ]);
    const shuffle = [
      move("c3", "c4"), move("a8", "a7"),
      move("d5", "c3"), move("a7", "a6"),
      move("c4", "d5"), move("a6", "a8"),
      move("d5", "c4"), move("a8", "a7"),
      move("c3", "d5"), move("a7", "a6"),
      move("c4", "c3"), move("a6", "a8"),
    ];
    for (const step of [...shuffle, ...shuffle]) {
      if (state.status !== "playing") break;
      state = applyMove(state, step);
    }
    // The real position only ever recurs twice per cycle here.
    expect(state.drawReason).not.toBe("repetition");
  });

  test("applyMove throws on an illegal move and on a finished game", () => {
    const state = createGame({ mode: "local" });
    expect(() => applyMove(state, move("e2", "e5"))).toThrow(/illegal/);
    const finished: GameState = { ...state, status: "won", winner: "white" };
    expect(() => applyMove(finished, move("e2", "e4"))).toThrow(/over/);
  });
});

describe("evaluation and AI", () => {
  test("evaluation is symmetric and material-led", () => {
    const board = createBoard();
    expect(evaluate(board, "white") + evaluate(board, "black")).toBe(0);

    const downAQueen = board.map((row) => row.slice());
    const queen = at("d8");
    downAQueen[queen.row][queen.col] = null;
    expect(evaluate(downAQueen, "white")).toBeGreaterThan(800);
  });

  test("the AI takes a free queen", () => {
    const state = position(
      "white",
      ["e1:white:king", "e8:black:king", "d1:white:rook", "d7:black:queen"],
      { difficulty: "hard" },
    );
    const chosen = getAiMove(state, () => 0);
    expect(squareName(chosen.to)).toBe("d7");
  });

  test("the AI finds mate in one", () => {
    const state = position(
      "white",
      ["h8:black:king", "g7:black:pawn", "h7:black:pawn", "a1:white:rook", "e1:white:king"],
      { difficulty: "hard" },
    );
    const after = applyMove(state, getAiMove(state, () => 0));
    expect(after.status).toBe("won");
    expect(after.winner).toBe("white");
  });

  test("the AI needs its evaluation, not just capture ordering", () => {
    // Rxd5 is the first move orderMoves offers (a free pawn) but loses the rook
    // to exd5. Only a search that actually evaluates the reply avoids it — with
    // evaluate() blinded to a constant this test fails.
    const state = position(
      "white",
      ["h1:white:king", "d1:white:rook", "a8:black:king", "d5:black:pawn", "e6:black:pawn"],
      { difficulty: "hard" },
    );
    expect(squareName(getAiMove(state, () => 0).to)).not.toBe("d5");
  });

  test("the blunder roll actually diverts the AI from its searched move", () => {
    // Without this the blunder branch could be deleted outright and every test
    // would still pass — "easy" would silently become an unbeatable-by-accident
    // depth-1 searcher that never throws a game away.
    const build = (): GameState =>
      position(
        "white",
        ["e1:white:king", "e8:black:king", "d1:white:rook", "d7:black:queen"],
        { difficulty: "easy" },
      );
    const searched = getAiMove(build(), () => 0.99); // above easy's blunder rate
    const blundered = getAiMove(build(), () => 0); // trips the roll, picks moves[0]
    expect(squareName(searched.to)).toBe("d7"); // the free queen
    expect(squareName(blundered.to)).not.toBe("d7");
  });

  test("the AI is deterministic given a fixed RandomFn", () => {
    const build = (): GameState => createGame({ mode: "ai", difficulty: "medium" });
    const first = getAiMove(build(), () => 0.99);
    const second = getAiMove(build(), () => 0.99);
    expect(second).toEqual(first);
  });

  test("a blunder roll plays a legal move too", () => {
    const state = createGame({ mode: "ai", difficulty: "easy" });
    const chosen = getAiMove(state, () => 0.01); // below easy's blunder rate
    expect(isLegalMove(state, chosen)).toBe(true);
  });
});

describe("helpers", () => {
  test("otherPlayer flips, findKing finds, squareName names", () => {
    expect(otherPlayer("white")).toBe("black");
    expect(findKing(createBoard(), "black")).toEqual(at("e8"));
    expect(squareName({ row: 7, col: 0 })).toBe("a1");
    expect(squareName({ row: 0, col: 7 })).toBe("h8");
  });
});

// Iterative deepening lets a killed search leave a playable move behind. It must
// not cost strength: the ladder ends on the same depth, so the move must match.
//
// Schach's root is the awkward one — it threads alpha and re-searches ties that
// only came back as upper bounds, so the tied-best set is computed differently
// from the other engines. That makes this differential the one most worth having.
//
// A constant-0 RNG would prove nothing: it satisfies `random() < blunderRate` on
// easy (0.35) and medium (0.08), short-circuiting BOTH functions to a random
// move. Clear the blunder roll once, then 0 for every tie-break.
describe("getAiMoveIterative — differential against getAiMove", () => {
  const searchingRng = (difficulty: GameState["difficulty"]): (() => number) => {
    const rollsForBlunder = difficulty === "easy" || difficulty === "medium";
    let call = 0;
    return () => (rollsForBlunder && ++call === 1 ? 0.99 : 0);
  };

  const positions: [string, () => GameState][] = [
    ["opening", () => createGame({ mode: "ai", humanPlayer: "white" })],
    [
      "free queen on offer",
      () =>
        position("white", ["e1:white:king", "e8:black:king", "d1:white:rook", "d7:black:queen"]),
    ],
    [
      "middlegame with several captures",
      () =>
        position("white", [
          "e1:white:king",
          "e8:black:king",
          "d4:white:queen",
          "f3:white:knight",
          "c6:black:knight",
          "g6:black:bishop",
          "a2:white:pawn",
          "h7:black:pawn",
        ]),
    ],
  ];

  for (const [label, build] of positions) {
    for (const difficulty of ["easy", "medium", "hard", "expert"] as const) {
      test(`picks the same move as getAiMove — ${label}, ${difficulty}`, () => {
        const state = { ...build(), difficulty };
        // Guard the guard: assert the ladder actually ran, so a future change
        // that short-circuits the search can't make this pass vacuously.
        const depths: number[] = [];
        const iterative = getAiMoveIterative(state, searchingRng(difficulty), {
          onDepth: (progress) => depths.push(progress.depth),
        });
        expect(depths.length).toBeGreaterThan(0);
        expect(iterative).toEqual(getAiMove(state, searchingRng(difficulty)));
      });
    }
  }

  // Pins every level's depth, not just expert. The differentials compare the two
  // entry points against each other, so they move together and can never notice
  // a depth change — reverting hard from 4 to 3 left all 72 schach tests green.
  // Expert's 5 is odd, so the target must be appended rather than strided onto;
  // its penultimate rung is 4, the depth this level had before the worker let it
  // go deeper, so a killed search falls back to exactly the old strength.
  test.each([
    ["easy", [1]],
    ["medium", [2]],
    ["hard", [2, 4]],
    ["expert", [2, 4, 5]],
  ] as const)("walks %s's ladder", (difficulty, expected) => {
    const state = { ...createGame({ mode: "ai", humanPlayer: "white" }), difficulty };
    const depths: number[] = [];
    getAiMoveIterative(state, searchingRng(difficulty), {
      onDepth: (progress) => depths.push(progress.depth),
    });
    expect(depths).toEqual(expected);
  });

  test("reports a legal move at every depth, so a killed search leaves a fallback", () => {
    const state = { ...createGame({ mode: "ai", humanPlayer: "white" }), difficulty: "expert" as const };
    const reported: Move[] = [];
    getAiMoveIterative(state, searchingRng("expert"), {
      onDepth: (progress) => reported.push(progress.move),
    });
    expect(reported.length).toBeGreaterThan(0);
    for (const candidate of reported) expect(isLegalMove(state, candidate)).toBe(true);
  });
});
