// Pure game logic for Schach (chess, 8×8) — no DOM, no storage. Board is
// board[row][col] with row 0 at the top (rank 8, Black's back rank); White sits
// on rows 6/7 and moves up the board (row decreasing). Everything here is
// deterministic given an injected RNG, so it's fully unit-testable.
//
// Full FIDE move rules: castling (both sides, with the four denials), en
// passant, promotion to any of the four pieces, and the draw conditions —
// stalemate, the 50-move rule, insufficient material and threefold repetition.
// Repetition only ever happens inside a run of reversible moves, so
// `positionHistory` is reset by exactly the same events as `halfmoveClock` and
// stays short enough to persist.
//
// Promotion is modelled as four separate moves sharing from/to (one per piece),
// so `applyMove` stays a single pure call and the search can weigh
// under-promotion. Every move lookup therefore has to compare `promotion` too.

import {
  iterativeBest,
  pickBest,
  type IterativeOptions,
  type Scored,
} from "../../shell/iterative-search.js";

export type Player = "white" | "black";
export type PieceKind = "pawn" | "knight" | "bishop" | "rook" | "queen" | "king";
export type PromotionKind = Exclude<PieceKind, "pawn" | "king">;

export interface Piece {
  player: Player;
  kind: PieceKind;
}
export type Cell = Piece | null;
/** board[row][col]; 8×8, row 0 is the top (rank 8). */
export type Board = Cell[][];
export type Difficulty = "easy" | "medium" | "hard" | "expert";
export type Mode = "local" | "ai";
export type GameStatus = "playing" | "won" | "draw";
export type DrawReason = "stalemate" | "fifty" | "material" | "repetition";

export interface Square {
  row: number;
  col: number;
}

/** Castling rights per side: `king` = short (0-0), `queen` = long (0-0-0). */
export interface CastlingRights {
  king: boolean;
  queen: boolean;
}

export interface Move {
  from: Square;
  to: Square;
  /** Square the captured piece sits on — differs from `to` for en passant. */
  captured: Square | null;
  /** Set only for a pawn reaching the far rank. */
  promotion: PromotionKind | null;
  /** The rook's journey when this is a castling move. */
  castle: { from: Square; to: Square } | null;
}

export interface GameState {
  board: Board;
  currentPlayer: Player;
  mode: Mode;
  difficulty: Difficulty;
  /** The colour the human controls (only meaningful in "ai" mode). */
  humanPlayer: Player;
  castling: Record<Player, CastlingRights>;
  /** The square a pawn may capture onto en passant, else null. */
  enPassant: Square | null;
  /** Plies since the last pawn move or capture — 100 means a 50-move draw. */
  halfmoveClock: number;
  /** Position keys since the last irreversible move, for threefold repetition. */
  positionHistory: string[];
  status: GameStatus;
  /** Set when status === "won". */
  winner: Player | null;
  /** Set when status === "draw". */
  drawReason: DrawReason | null;
}

export const SIZE = 8;
/** White always opens. */
export const FIRST_PLAYER: Player = "white";
/** Plies without a pawn move or capture that end the game in a draw. */
export const FIFTY_MOVE_PLIES = 100;

export type RandomFn = () => number;

export function otherPlayer(player: Player): Player {
  return player === "white" ? "black" : "white";
}

const inBounds = (row: number, col: number): boolean =>
  row >= 0 && row < SIZE && col >= 0 && col < SIZE;

export function pieceAt(board: Board, square: Square): Cell {
  if (!inBounds(square.row, square.col)) return null;
  return board[square.row][square.col];
}

export const sameSquare = (first: Square, second: Square): boolean =>
  first.row === second.row && first.col === second.col;

/** Row of a player's back rank (where king and rooks start). */
export function homeRow(player: Player): number {
  return player === "white" ? SIZE - 1 : 0;
}
/** Row a pawn of `player` promotes on. */
function promotionRow(player: Player): number {
  return player === "white" ? 0 : SIZE - 1;
}
/** Direction a pawn of `player` advances in (rows). */
function pawnStep(player: Player): number {
  return player === "white" ? -1 : 1;
}

const BACK_RANK: readonly PieceKind[] = [
  "rook",
  "knight",
  "bishop",
  "queen",
  "king",
  "bishop",
  "knight",
  "rook",
];

export function createBoard(): Board {
  return Array.from({ length: SIZE }, (_unused, row) =>
    Array.from({ length: SIZE }, (_alsoUnused, col): Cell => {
      if (row === 0) return { player: "black", kind: BACK_RANK[col] };
      if (row === 1) return { player: "black", kind: "pawn" };
      if (row === SIZE - 2) return { player: "white", kind: "pawn" };
      if (row === SIZE - 1) return { player: "white", kind: BACK_RANK[col] };
      return null;
    }),
  );
}

// ---------------------------------------------------------------------------
// Attack detection
// ---------------------------------------------------------------------------
const KNIGHT_STEPS: ReadonlyArray<Square> = [
  { row: -2, col: -1 },
  { row: -2, col: 1 },
  { row: -1, col: -2 },
  { row: -1, col: 2 },
  { row: 1, col: -2 },
  { row: 1, col: 2 },
  { row: 2, col: -1 },
  { row: 2, col: 1 },
];
const ROOK_DIRS: ReadonlyArray<Square> = [
  { row: -1, col: 0 },
  { row: 1, col: 0 },
  { row: 0, col: -1 },
  { row: 0, col: 1 },
];
const BISHOP_DIRS: ReadonlyArray<Square> = [
  { row: -1, col: -1 },
  { row: -1, col: 1 },
  { row: 1, col: -1 },
  { row: 1, col: 1 },
];
const KING_STEPS: ReadonlyArray<Square> = [...ROOK_DIRS, ...BISHOP_DIRS];

/** Is `square` attacked by any piece of `by`? A direct board scan outward from
 *  the square — generating the opponent's whole move list instead would be the
 *  hot spot of the search, since this runs once per generated move. */
export function isSquareAttacked(board: Board, square: Square, by: Player): boolean {
  // Pawns: a pawn of `by` attacks forward, so it must sit one step *back*.
  const pawnRow = square.row - pawnStep(by);
  for (const colOffset of [-1, 1]) {
    const col = square.col + colOffset;
    if (!inBounds(pawnRow, col)) continue;
    const piece = board[pawnRow][col];
    if (piece && piece.player === by && piece.kind === "pawn") return true;
  }

  for (const step of KNIGHT_STEPS) {
    const row = square.row + step.row;
    const col = square.col + step.col;
    if (!inBounds(row, col)) continue;
    const piece = board[row][col];
    if (piece && piece.player === by && piece.kind === "knight") return true;
  }

  for (const step of KING_STEPS) {
    const row = square.row + step.row;
    const col = square.col + step.col;
    if (!inBounds(row, col)) continue;
    const piece = board[row][col];
    if (piece && piece.player === by && piece.kind === "king") return true;
  }

  const slidingHits = (dirs: ReadonlyArray<Square>, longRange: PieceKind): boolean => {
    for (const dir of dirs) {
      let row = square.row + dir.row;
      let col = square.col + dir.col;
      while (inBounds(row, col)) {
        const piece = board[row][col];
        if (piece) {
          if (piece.player === by && (piece.kind === longRange || piece.kind === "queen")) {
            return true;
          }
          break; // blocked
        }
        row += dir.row;
        col += dir.col;
      }
    }
    return false;
  };

  return slidingHits(ROOK_DIRS, "rook") || slidingHits(BISHOP_DIRS, "bishop");
}

export function findKing(board: Board, player: Player): Square | null {
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const piece = board[row][col];
      if (piece && piece.player === player && piece.kind === "king") return { row, col };
    }
  }
  return null;
}

/** Is `player` in check right now? */
export function isInCheck(board: Board, player: Player): boolean {
  const king = findKing(board, player);
  return king !== null && isSquareAttacked(board, king, otherPlayer(player));
}

// ---------------------------------------------------------------------------
// Move generation
// ---------------------------------------------------------------------------
const PROMOTIONS: readonly PromotionKind[] = ["queen", "rook", "bishop", "knight"];

const plainMove = (from: Square, to: Square, captured: Square | null): Move => ({
  from,
  to,
  captured,
  promotion: null,
  castle: null,
});

function pawnMoves(board: Board, from: Square, player: Player, enPassant: Square | null): Move[] {
  const moves: Move[] = [];
  const step = pawnStep(player);
  const last = promotionRow(player);

  const push = (to: Square, captured: Square | null): void => {
    if (to.row === last) {
      for (const promotion of PROMOTIONS) {
        moves.push({ from, to, captured, promotion, castle: null });
      }
    } else {
      moves.push(plainMove(from, to, captured));
    }
  };

  const oneAhead = { row: from.row + step, col: from.col };
  if (inBounds(oneAhead.row, oneAhead.col) && board[oneAhead.row][oneAhead.col] === null) {
    push(oneAhead, null);
    // Double step only from the pawn's own start row, and only over empty ground.
    const startRow = player === "white" ? SIZE - 2 : 1;
    const twoAhead = { row: from.row + step * 2, col: from.col };
    if (from.row === startRow && board[twoAhead.row][twoAhead.col] === null) {
      push(twoAhead, null);
    }
  }

  for (const colOffset of [-1, 1]) {
    const to = { row: from.row + step, col: from.col + colOffset };
    if (!inBounds(to.row, to.col)) continue;
    const target = board[to.row][to.col];
    if (target) {
      if (target.player !== player) push(to, to);
      continue;
    }
    // En passant: the captured pawn sits beside the mover, not on the target.
    if (enPassant && sameSquare(enPassant, to)) {
      push(to, { row: from.row, col: to.col });
    }
  }
  return moves;
}

function steppingMoves(
  board: Board,
  from: Square,
  player: Player,
  steps: ReadonlyArray<Square>,
): Move[] {
  const moves: Move[] = [];
  for (const step of steps) {
    const row = from.row + step.row;
    const col = from.col + step.col;
    if (!inBounds(row, col)) continue;
    const target = board[row][col];
    if (target?.player === player) continue;
    moves.push(plainMove(from, { row, col }, target ? { row, col } : null));
  }
  return moves;
}

function slidingMoves(
  board: Board,
  from: Square,
  player: Player,
  dirs: ReadonlyArray<Square>,
): Move[] {
  const moves: Move[] = [];
  for (const dir of dirs) {
    let row = from.row + dir.row;
    let col = from.col + dir.col;
    while (inBounds(row, col)) {
      const target = board[row][col];
      if (target) {
        if (target.player !== player) {
          moves.push(plainMove(from, { row, col }, { row, col }));
        }
        break;
      }
      moves.push(plainMove(from, { row, col }, null));
      row += dir.row;
      col += dir.col;
    }
  }
  return moves;
}

/** The two castling moves, with every FIDE condition checked except the one
 *  `legalMoves` applies to all moves anyway (the king must not land in check). */
function castlingMoves(board: Board, player: Player, rights: CastlingRights): Move[] {
  if (!rights.king && !rights.queen) return [];
  const row = homeRow(player);
  const kingFrom = { row, col: 4 };
  const king = board[row][4];
  if (!king || king.player !== player || king.kind !== "king") return [];
  const enemy = otherPlayer(player);
  if (isSquareAttacked(board, kingFrom, enemy)) return []; // may not castle out of check

  const moves: Move[] = [];
  const sides = [
    { allowed: rights.king, rookCol: 7, empty: [5, 6], safe: [5, 6], kingCol: 6, rookTo: 5 },
    { allowed: rights.queen, rookCol: 0, empty: [1, 2, 3], safe: [2, 3], kingCol: 2, rookTo: 3 },
  ];
  for (const side of sides) {
    if (!side.allowed) continue;
    const rook = board[row][side.rookCol];
    if (!rook || rook.player !== player || rook.kind !== "rook") continue;
    if (side.empty.some((col) => board[row][col] !== null)) continue;
    // The king may not pass through an attacked square.
    if (side.safe.some((col) => isSquareAttacked(board, { row, col }, enemy))) continue;
    moves.push({
      from: kingFrom,
      to: { row, col: side.kingCol },
      captured: null,
      promotion: null,
      castle: { from: { row, col: side.rookCol }, to: { row, col: side.rookTo } },
    });
  }
  return moves;
}

/** Every move ignoring the "own king must not be left in check" rule. */
function pseudoLegalMoves(
  board: Board,
  player: Player,
  castling: CastlingRights,
  enPassant: Square | null,
): Move[] {
  const moves: Move[] = [];
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const piece = board[row][col];
      if (!piece || piece.player !== player) continue;
      const from = { row, col };
      if (piece.kind === "pawn") moves.push(...pawnMoves(board, from, player, enPassant));
      else if (piece.kind === "knight") moves.push(...steppingMoves(board, from, player, KNIGHT_STEPS));
      else if (piece.kind === "king") moves.push(...steppingMoves(board, from, player, KING_STEPS));
      else if (piece.kind === "rook") moves.push(...slidingMoves(board, from, player, ROOK_DIRS));
      else if (piece.kind === "bishop") moves.push(...slidingMoves(board, from, player, BISHOP_DIRS));
      else moves.push(...slidingMoves(board, from, player, [...ROOK_DIRS, ...BISHOP_DIRS]));
    }
  }
  moves.push(...castlingMoves(board, player, castling));
  return moves;
}

/**
 * Would `move` leave `player`'s own king attacked? Plays the move on `board` in
 * place and takes it back again, so the legality filter costs no allocation —
 * this runs once per generated move and is the innermost loop of the search.
 * `board` is restored exactly, so callers may pass a live state's board.
 */
function leavesKingInCheck(board: Board, move: Move, player: Player): boolean {
  const moved = board[move.from.row][move.from.col]!;
  const capturedPiece = move.captured
    ? board[move.captured.row][move.captured.col]
    : null;
  const targetPiece = board[move.to.row][move.to.col];

  if (move.captured) board[move.captured.row][move.captured.col] = null;
  board[move.from.row][move.from.col] = null;
  board[move.to.row][move.to.col] = move.promotion
    ? { player: moved.player, kind: move.promotion }
    : moved;
  let rook: Cell = null;
  if (move.castle) {
    rook = board[move.castle.from.row][move.castle.from.col];
    board[move.castle.from.row][move.castle.from.col] = null;
    board[move.castle.to.row][move.castle.to.col] = rook;
  }

  const king = moved.kind === "king" ? move.to : findKing(board, player);
  const attacked = king !== null && isSquareAttacked(board, king, otherPlayer(player));

  if (move.castle) {
    board[move.castle.to.row][move.castle.to.col] = null;
    board[move.castle.from.row][move.castle.from.col] = rook;
  }
  board[move.to.row][move.to.col] = targetPiece;
  board[move.from.row][move.from.col] = moved;
  if (move.captured) board[move.captured.row][move.captured.col] = capturedPiece;
  return attacked;
}

/** The board after `move`, with no bookkeeping. */
function boardAfter(board: Board, move: Move): Board {
  const next = board.map((cells) => cells.slice());
  const piece = next[move.from.row][move.from.col]!;
  if (move.captured) next[move.captured.row][move.captured.col] = null;
  next[move.from.row][move.from.col] = null;
  next[move.to.row][move.to.col] = move.promotion
    ? { player: piece.player, kind: move.promotion }
    : piece;
  if (move.castle) {
    const rook = next[move.castle.from.row][move.castle.from.col]!;
    next[move.castle.from.row][move.castle.from.col] = null;
    next[move.castle.to.row][move.castle.to.col] = rook;
  }
  return next;
}

/** The legal moves for the side to move: pseudo-legal minus everything that
 *  leaves (or leaves standing) the mover's own king in check. */
export function legalMoves(state: GameState): Move[] {
  if (state.status !== "playing") return [];
  return movesFor(state.board, state.currentPlayer, state.castling[state.currentPlayer], state.enPassant);
}

function movesFor(
  board: Board,
  player: Player,
  castling: CastlingRights,
  enPassant: Square | null,
): Move[] {
  return pseudoLegalMoves(board, player, castling, enPassant).filter(
    (move) => !leavesKingInCheck(board, move, player),
  );
}

export function createGame(options: {
  mode: Mode;
  difficulty?: Difficulty;
  humanPlayer?: Player;
}): GameState {
  const board = createBoard();
  return {
    board,
    currentPlayer: FIRST_PLAYER,
    mode: options.mode,
    difficulty: options.difficulty ?? "medium",
    humanPlayer: options.humanPlayer ?? "white",
    castling: {
      white: { king: true, queen: true },
      black: { king: true, queen: true },
    },
    enPassant: null,
    halfmoveClock: 0,
    positionHistory: [positionKey(board, FIRST_PLAYER, allRights(), null)],
    status: "playing",
    winner: null,
    drawReason: null,
  };
}

const allRights = (): Record<Player, CastlingRights> => ({
  white: { king: true, queen: true },
  black: { king: true, queen: true },
});

/** Two moves are the same move when origin, target and promotion agree —
 *  promotion matters because four moves share from/to. */
const isSameMove = (candidate: Move, move: Move): boolean =>
  sameSquare(candidate.from, move.from) &&
  sameSquare(candidate.to, move.to) &&
  candidate.promotion === (move.promotion ?? null);

export function isLegalMove(state: GameState, move: Move): boolean {
  return legalMoves(state).some((candidate) => isSameMove(candidate, move));
}

/**
 * Apply one move. Returns a new state, never mutates the input. Throws on an
 * illegal move. The caller may pass a bare {from, to, promotion} — the matching
 * legal move (with its capture square and rook journey) is looked up here.
 */
export function applyMove(state: GameState, move: Move): GameState {
  if (state.status !== "playing") throw new Error("game is already over");
  const legal = legalMoves(state).find((candidate) => isSameMove(candidate, move));
  if (!legal) throw new Error("illegal move");
  return applyLegalMove(state, legal);
}

/** Castling rights after `move`: the mover loses them by moving king or rook,
 *  the opponent loses one when their rook is captured on its home square. */
function rightsAfter(
  castling: Record<Player, CastlingRights>,
  move: Move,
  piece: Piece,
): Record<Player, CastlingRights> {
  const next: Record<Player, CastlingRights> = {
    white: { ...castling.white },
    black: { ...castling.black },
  };
  const mover = piece.player;
  if (piece.kind === "king") {
    next[mover] = { king: false, queen: false };
  } else if (piece.kind === "rook" && move.from.row === homeRow(mover)) {
    if (move.from.col === 7) next[mover].king = false;
    if (move.from.col === 0) next[mover].queen = false;
  }
  const enemy = otherPlayer(mover);
  if (move.captured && move.captured.row === homeRow(enemy)) {
    if (move.captured.col === 7) next[enemy].king = false;
    if (move.captured.col === 0) next[enemy].queen = false;
  }
  return next;
}

/** A compact key of everything that defines a position for repetition: the
 *  pieces, the side to move, castling rights and the en-passant target. */
// SAN letters, so "knight" doesn't collide with "king" — `kind[0]` gives both a
// `k`, which merges two different positions into one repetition key.
const KIND_LETTER: Record<PieceKind, string> = {
  pawn: "p",
  knight: "n",
  bishop: "b",
  rook: "r",
  queen: "q",
  king: "k",
};

function positionKey(
  board: Board,
  player: Player,
  castling: Record<Player, CastlingRights>,
  enPassant: Square | null,
): string {
  const cells = board
    .map((row) =>
      row
        .map((cell) => (cell ? `${cell.player[0]}${KIND_LETTER[cell.kind]}` : "-"))
        .join(""),
    )
    .join("/");
  const rights = `${castling.white.king ? "K" : ""}${castling.white.queen ? "Q" : ""}${
    castling.black.king ? "k" : ""
  }${castling.black.queen ? "q" : ""}`;
  const target = enPassant ? `${enPassant.row}${enPassant.col}` : "-";
  return `${cells} ${player[0]} ${rights || "-"} ${target}`;
}

/** Neither side can ever mate: bare kings, king+bishop, king+knight, or two
 *  kings with bishops on same-coloured squares. */
export function isInsufficientMaterial(board: Board): boolean {
  const minor: { player: Player; kind: PieceKind; shade: number }[] = [];
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const piece = board[row][col];
      if (!piece || piece.kind === "king") continue;
      if (piece.kind === "pawn" || piece.kind === "rook" || piece.kind === "queen") return false;
      minor.push({ player: piece.player, kind: piece.kind, shade: (row + col) % 2 });
    }
  }
  if (minor.length <= 1) return true;
  if (minor.length === 2) {
    const [first, second] = minor;
    const bishopPair = first.kind === "bishop" && second.kind === "bishop";
    return bishopPair && first.player !== second.player && first.shade === second.shade;
  }
  return false;
}

/**
 * The move transition without the end-of-game bookkeeping: board, side to move,
 * castling rights, en-passant target and the halfmove clock. The search calls
 * this directly — it discovers mate and stalemate at the next node from the move
 * list it generates there anyway, so paying for a reply scan and a position key
 * per node would just double the work.
 */
function advance(state: GameState, legal: Move): GameState {
  const piece = pieceAt(state.board, legal.from)!;
  // A double pawn step opens the en-passant square right behind it.
  const doubleStep = piece.kind === "pawn" && Math.abs(legal.to.row - legal.from.row) === 2;
  return {
    ...state,
    board: boardAfter(state.board, legal),
    currentPlayer: otherPlayer(state.currentPlayer),
    castling: rightsAfter(state.castling, legal, piece),
    enPassant: doubleStep
      ? { row: (legal.from.row + legal.to.row) / 2, col: legal.from.col }
      : null,
    halfmoveClock: piece.kind === "pawn" || legal.captured !== null ? 0 : state.halfmoveClock + 1,
  };
}

/** The full transition: `advance` plus repetition history and the game's
 *  outcome. `legal` MUST come from `legalMoves`. */
function applyLegalMove(state: GameState, legal: Move): GameState {
  const advanced = advance(state, legal);
  const key = positionKey(
    advanced.board,
    advanced.currentPlayer,
    advanced.castling,
    advanced.enPassant,
  );
  // Repetition can only recur within a run of reversible moves, so the history
  // resets exactly when the clock does — and stays short enough to persist.
  const base: GameState = {
    ...advanced,
    positionHistory: advanced.halfmoveClock === 0 ? [key] : [...state.positionHistory, key],
  };

  const next = base.currentPlayer;
  const replies = movesFor(base.board, next, base.castling[next], base.enPassant);
  if (replies.length === 0) {
    return isInCheck(base.board, next)
      ? { ...base, status: "won", winner: state.currentPlayer, drawReason: null }
      : { ...base, status: "draw", winner: null, drawReason: "stalemate" };
  }
  const drawReason = drawByRule(base);
  if (drawReason) return { ...base, status: "draw", winner: null, drawReason };
  return base;
}

/** The non-stalemate draws — checked after the reply set is known to be
 *  non-empty, since mate always outranks them. */
function drawByRule(state: GameState): DrawReason | null {
  if (isInsufficientMaterial(state.board)) return "material";
  if (state.halfmoveClock >= FIFTY_MOVE_PLIES) return "fifty";
  const current = state.positionHistory[state.positionHistory.length - 1];
  const repeats = state.positionHistory.filter((key) => key === current).length;
  return repeats >= 3 ? "repetition" : null;
}

// ---------------------------------------------------------------------------
// AI — depth-limited negamax with alpha-beta pruning.
// ---------------------------------------------------------------------------
// Chess branches ~35 wide (against Dame's ~8), and this runs on the main
// thread, so the depths are modest and moves are ordered (captures first,
// MVV-LVA) to make the pruning bite. `blunderRate` — a chance per move of
// playing a random legal move instead of searching — is what keeps "easy"
// beatable, exactly as in Quadra and Dame.
interface LevelConfig {
  depth: number;
  blunderRate: number;
}
// Measured worst case per move on an open middlegame (the branching peak, not
// the opening — that one lies): 2ms / 27ms / 263ms / 443ms. Depth 5 was the
// wall at ~5s, so expert stops at 4.
const LEVELS: Record<Difficulty, LevelConfig> = {
  easy: { depth: 1, blunderRate: 0.35 },
  medium: { depth: 2, blunderRate: 0.08 },
  hard: { depth: 3, blunderRate: 0 },
  expert: { depth: 4, blunderRate: 0 },
};

const WIN_SCORE = 100000;

const PIECE_VALUE: Record<PieceKind, number> = {
  pawn: 100,
  knight: 320,
  bishop: 330,
  rook: 500,
  queen: 900,
  king: 20000,
};

// Positional nudges from White's point of view, read from row 0 (rank 8) down;
// Black reads the same table mirrored. Standard "simplified evaluation"
// shaping: pawns want the centre and the far rank, knights hate the rim,
// the king wants to stay tucked behind its pawns in the middlegame.
const PAWN_TABLE: readonly number[][] = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [50, 50, 50, 50, 50, 50, 50, 50],
  [10, 10, 20, 30, 30, 20, 10, 10],
  [5, 5, 10, 25, 25, 10, 5, 5],
  [0, 0, 0, 20, 20, 0, 0, 0],
  [5, -5, -10, 0, 0, -10, -5, 5],
  [5, 10, 10, -20, -20, 10, 10, 5],
  [0, 0, 0, 0, 0, 0, 0, 0],
];
const KNIGHT_TABLE: readonly number[][] = [
  [-50, -40, -30, -30, -30, -30, -40, -50],
  [-40, -20, 0, 0, 0, 0, -20, -40],
  [-30, 0, 10, 15, 15, 10, 0, -30],
  [-30, 5, 15, 20, 20, 15, 5, -30],
  [-30, 0, 15, 20, 20, 15, 0, -30],
  [-30, 5, 10, 15, 15, 10, 5, -30],
  [-40, -20, 0, 5, 5, 0, -20, -40],
  [-50, -40, -30, -30, -30, -30, -40, -50],
];
const BISHOP_TABLE: readonly number[][] = [
  [-20, -10, -10, -10, -10, -10, -10, -20],
  [-10, 0, 0, 0, 0, 0, 0, -10],
  [-10, 0, 5, 10, 10, 5, 0, -10],
  [-10, 5, 5, 10, 10, 5, 5, -10],
  [-10, 0, 10, 10, 10, 10, 0, -10],
  [-10, 10, 10, 10, 10, 10, 10, -10],
  [-10, 5, 0, 0, 0, 0, 5, -10],
  [-20, -10, -10, -10, -10, -10, -10, -20],
];
const ROOK_TABLE: readonly number[][] = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [5, 10, 10, 10, 10, 10, 10, 5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [0, 0, 0, 5, 5, 0, 0, 0],
];
const QUEEN_TABLE: readonly number[][] = [
  [-20, -10, -10, -5, -5, -10, -10, -20],
  [-10, 0, 0, 0, 0, 0, 0, -10],
  [-10, 0, 5, 5, 5, 5, 0, -10],
  [-5, 0, 5, 5, 5, 5, 0, -5],
  [0, 0, 5, 5, 5, 5, 0, -5],
  [-10, 5, 5, 5, 5, 5, 0, -10],
  [-10, 0, 5, 0, 0, 0, 0, -10],
  [-20, -10, -10, -5, -5, -10, -10, -20],
];
const KING_TABLE: readonly number[][] = [
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-20, -30, -30, -40, -40, -30, -30, -20],
  [-10, -20, -20, -20, -20, -20, -20, -10],
  [20, 20, 0, 0, 0, 0, 20, 20],
  [20, 30, 10, 0, 0, 10, 30, 20],
];
const TABLES: Record<PieceKind, readonly number[][]> = {
  pawn: PAWN_TABLE,
  knight: KNIGHT_TABLE,
  bishop: BISHOP_TABLE,
  rook: ROOK_TABLE,
  queen: QUEEN_TABLE,
  king: KING_TABLE,
};

/** Static evaluation from `player`'s perspective: material plus placement. */
export function evaluate(board: Board, player: Player): number {
  let score = 0;
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const piece = board[row][col];
      if (!piece) continue;
      const sign = piece.player === player ? 1 : -1;
      // Black reads the table from the other end of the board.
      const tableRow = piece.player === "white" ? row : SIZE - 1 - row;
      score += sign * (PIECE_VALUE[piece.kind] + TABLES[piece.kind][tableRow][col]);
    }
  }
  return score;
}

/** Search order: captures first, most valuable victim by least valuable
 *  attacker, then promotions. Ordering is what makes alpha-beta prune. */
function orderMoves(board: Board, moves: Move[]): Move[] {
  const score = (move: Move): number => {
    let value = 0;
    if (move.captured) {
      const victim = board[move.captured.row][move.captured.col];
      const attacker = board[move.from.row][move.from.col]!;
      value += 10 * (victim ? PIECE_VALUE[victim.kind] : 0) - PIECE_VALUE[attacker.kind];
    }
    if (move.promotion) value += PIECE_VALUE[move.promotion];
    return value;
  };
  return moves
    .map((move) => ({ move, value: score(move) }))
    .sort((first, second) => second.value - first.value)
    .map((entry) => entry.move);
}

/** Negamax value of `state` for the side to move. Terminal positions are
 *  recognised here, from the move list this node generates anyway: no moves
 *  means mate (scored by depth, so a faster mate wins) or stalemate. Repetition
 *  and insufficient material are left to `applyLegalMove` — inside the search
 *  they'd cost a board scan and a position key per node for almost no strength.
 *
 *  A mate delivered on the *last* searched ply has to be caught before the
 *  horizon return, or it scores as plain material and the AI plays a capture
 *  instead of the mate. Only an in-check leaf can be mate, so the leaf pays one
 *  attack scan and generates moves only in that rare case. (A leaf *stalemate*
 *  is still scored as material — closing that would cost full movegen at every
 *  leaf, which the depth ladder can't afford.) */
function negamax(state: GameState, depth: number, alpha: number, beta: number): number {
  const player = state.currentPlayer;
  if (depth === 0) {
    if (!isInCheck(state.board, player)) return evaluate(state.board, player);
    const replies = movesFor(state.board, player, state.castling[player], state.enPassant);
    return replies.length === 0 ? -(WIN_SCORE + depth) : evaluate(state.board, player);
  }
  if (state.halfmoveClock >= FIFTY_MOVE_PLIES) return 0;

  const moves = movesFor(state.board, player, state.castling[player], state.enPassant);
  if (moves.length === 0) {
    return isInCheck(state.board, player) ? -(WIN_SCORE + depth) : 0;
  }

  let best = -Infinity;
  for (const move of orderMoves(state.board, moves)) {
    const value = -negamax(advance(state, move), depth - 1, -beta, -alpha);
    if (value > best) best = value;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // prune
  }
  return best;
}

/**
 * Pick a move for the side to move. With probability `blunderRate` (easy and,
 * rarely, medium) it plays a random legal move instead of searching — that's
 * what lets a beginner win.
 */
export function getAiMove(state: GameState, random: RandomFn = Math.random): Move {
  const { moves, shortcut } = openingChoice(state, random);
  if (shortcut) return shortcut;
  return bestMoveAtDepth(state, moves, LEVELS[state.difficulty].depth, random).move;
}

/** The moves the search opens with, and whether a blunder short-circuits it.
 *  Shared by both entry points so they consume `random` identically. */
function openingChoice(
  state: GameState,
  random: RandomFn,
): { moves: Move[]; shortcut: Move | null } {
  const moves = legalMoves(state);
  if (moves.length === 0) throw new Error("no legal move — check status first");
  if (moves.length === 1) return { moves, shortcut: moves[0] };

  const { blunderRate } = LEVELS[state.difficulty];
  if (blunderRate > 0 && random() < blunderRate) {
    return { moves, shortcut: moves[Math.floor(random() * moves.length)] };
  }
  return { moves, shortcut: null };
}

/**
 * Same search as `getAiMove`, walking increasing depths and reporting each one.
 * The final depth — and so the strength — is identical; the intermediate results
 * exist so a caller still holds a playable move if the search is killed before
 * it finishes. See shell/iterative-search.ts for why that can happen silently.
 */
export function getAiMoveIterative(
  state: GameState,
  random: RandomFn = Math.random,
  options: IterativeOptions<Move> = {},
): Move {
  const { moves, shortcut } = openingChoice(state, random);
  if (shortcut) return shortcut;
  return iterativeBest(
    LEVELS[state.difficulty].depth,
    (depth) => bestMoveAtDepth(state, moves, depth, random),
    options,
  );
}

/** Best of `moves` searched to exactly `depth`; `random` breaks ties, consumed
 *  exactly once, as the fixed-depth root always did. */
function bestMoveAtDepth(
  state: GameState,
  moves: Move[],
  depth: number,
  random: RandomFn,
): Scored<Move> {
  const ordered = orderMoves(state.board, moves);
  // Root pass with a propagating alpha — a full window per move would roughly
  // treble the cost at the deeper levels. Moves that fail low come back as an
  // upper bound, so anything that merely *looks* tied is re-searched exactly
  // below; that's usually one or two moves.
  let alpha = -Infinity;
  // The move that last raised alpha was searched inside its window, so its
  // score is exact; every other tie is only an upper bound and needs a real
  // re-search before it may share the pick.
  let exactOwner: Move | null = null;
  const scored = ordered.map((move) => {
    const score = -negamax(advance(state, move), depth - 1, -Infinity, -alpha);
    if (score > alpha) {
      alpha = score;
      exactOwner = move;
    }
    return { move, score };
  });

  const exact = scored
    .filter((entry) => entry.score >= alpha)
    .map((entry) =>
      entry.move === exactOwner
        ? entry
        : { move: entry.move, score: -negamax(advance(state, entry.move), depth - 1, -Infinity, Infinity) },
    );
  return pickBest(exact, random);
}

// ---------------------------------------------------------------------------
// Helpers for UI and tests
// ---------------------------------------------------------------------------
/** An empty board — test fixtures and `createGame` variants build on it. */
export function emptyBoard(): Board {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, (): Cell => null));
}

/** Algebraic name of a square ("e4"), used for aria-labels. */
export function squareName(square: Square): string {
  return `${"abcdefgh"[square.col]}${SIZE - square.row}`;
}
