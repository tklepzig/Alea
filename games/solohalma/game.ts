// Pure game logic for Solo-Halma (peg solitaire / Steckhalma) — no DOM, no
// storage. The board is the classic English cross: a 7×7 grid with the four 2×2
// corners removed, leaving 33 holes. board[row][col] is a peg, an empty hole, or
// null for a corner that isn't part of the board. A move jumps a peg
// orthogonally over an adjacent peg into the empty hole beyond, removing the
// jumped peg. It's a single-player puzzle — no players, turns, or RNG — so the
// whole module is trivially deterministic and unit-testable.

export type Hole = "peg" | "empty";
/** A cell is a peg, an empty hole, or null where the board is cut away. */
export type Cell = Hole | null;
/** board[row][col]; 7×7 with the corners nulled out. */
export type Board = Cell[][];
export type Status = "playing" | "solved" | "stuck";

export interface Square {
  row: number;
  col: number;
}

export interface Move {
  from: Square;
  /** The jumped-over (removed) peg. */
  over: Square;
  to: Square;
}

export const SIZE = 7;
export const CENTER: Square = { row: 3, col: 3 };

const inBounds = (row: number, col: number): boolean =>
  row >= 0 && row < SIZE && col >= 0 && col < SIZE;

/** The four 2×2 corners are cut away; everything else in the 7×7 is a hole. */
export function isHole(row: number, col: number): boolean {
  if (!inBounds(row, col)) return false;
  const cornerRow = row < 2 || row > 4;
  const cornerCol = col < 2 || col > 4;
  return !(cornerRow && cornerCol);
}

/** Full board: every hole holds a peg except the centre, which starts empty. */
export function createBoard(): Board {
  return Array.from({ length: SIZE }, (_unused, row) =>
    Array.from({ length: SIZE }, (_alsoUnused, col): Cell => {
      if (!isHole(row, col)) return null;
      if (row === CENTER.row && col === CENTER.col) return "empty";
      return "peg";
    }),
  );
}

// Peg solitaire is orthogonal only — no diagonal jumps.
const DIRECTIONS: ReadonlyArray<Square> = [
  { row: -1, col: 0 },
  { row: 1, col: 0 },
  { row: 0, col: -1 },
  { row: 0, col: 1 },
];

export function pegCount(board: Board): number {
  return board.reduce(
    (total, row) => total + row.filter((cell) => cell === "peg").length,
    0,
  );
}

/** Every legal jump on the board. */
export function legalMoves(board: Board): Move[] {
  const moves: Move[] = [];
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      if (board[row][col] !== "peg") continue;
      for (const direction of DIRECTIONS) {
        const overRow = row + direction.row;
        const overCol = col + direction.col;
        const toRow = row + direction.row * 2;
        const toCol = col + direction.col * 2;
        if (!isHole(toRow, toCol)) continue;
        if (board[overRow][overCol] !== "peg") continue;
        if (board[toRow][toCol] !== "empty") continue;
        moves.push({
          from: { row, col },
          over: { row: overRow, col: overCol },
          to: { row: toRow, col: toCol },
        });
      }
    }
  }
  return moves;
}

/** Jumps available for the peg on `square` (used to highlight a picked-up peg). */
export function movesFrom(board: Board, square: Square): Move[] {
  return legalMoves(board).filter(
    (move) => move.from.row === square.row && move.from.col === square.col,
  );
}

const sameSquare = (first: Square, second: Square): boolean =>
  first.row === second.row && first.col === second.col;

export function isLegalMove(board: Board, move: Move): boolean {
  return legalMoves(board).some(
    (candidate) => sameSquare(candidate.from, move.from) && sameSquare(candidate.to, move.to),
  );
}

/** Apply a jump. Returns a new board, never mutates. Throws on an illegal move. */
export function applyMove(board: Board, move: Move): Board {
  const legal = legalMoves(board).find(
    (candidate) => sameSquare(candidate.from, move.from) && sameSquare(candidate.to, move.to),
  );
  if (!legal) throw new Error("illegal move");
  const next = board.map((row) => row.slice());
  next[legal.from.row][legal.from.col] = "empty";
  next[legal.over.row][legal.over.col] = "empty";
  next[legal.to.row][legal.to.col] = "peg";
  return next;
}

/**
 * Outcome of a board: "solved" once a single peg remains, "stuck" when more than
 * one peg is left but no jump exists, otherwise "playing".
 */
export function statusOf(board: Board): Status {
  if (pegCount(board) === 1) return "solved";
  return legalMoves(board).length === 0 ? "stuck" : "playing";
}

/** A perfect finish: the single remaining peg sits in the centre hole. */
export function isCenterFinish(board: Board): boolean {
  return pegCount(board) === 1 && board[CENTER.row][CENTER.col] === "peg";
}
