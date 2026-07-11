// Pure game logic for Dame (English draughts, 8×8) — no DOM, no storage.
// Board is board[row][col] with row 0 at the top. Pieces live on the dark
// squares only ((row+col) odd). Red starts at the bottom and moves up (row
// decreasing); Black starts at the top and moves down. Everything here is
// deterministic given an injected RNG, so it's fully unit-testable.
//
// Ruleset (English draughts): capture is mandatory (Schlagzwang); men capture
// forward only; a king ("Dame") moves and captures one square in any diagonal
// (non-flying); a man that reaches the far row is crowned and its turn ends,
// even if a further jump would otherwise be available.

export type Player = "red" | "black";
export type PieceKind = "man" | "king";
export interface Piece {
  player: Player;
  kind: PieceKind;
}
export type Cell = Piece | null;
/** board[row][col]; 8×8, row 0 is the top. */
export type Board = Cell[][];
export type Difficulty = "easy" | "medium" | "hard" | "expert";
export type Mode = "local" | "ai";
export type GameStatus = "playing" | "won";

export interface Square {
  row: number;
  col: number;
}

/** A single diagonal step. A multi-jump is a chain of capture moves, one per
 *  hop — the UI plays them out and the engine keeps the turn open via
 *  `mustContinueFrom` while more jumps remain. */
export interface Move {
  from: Square;
  to: Square;
  /** The jumped-over square for a capture, else null for a plain slide. */
  captured: Square | null;
}

export interface GameState {
  board: Board;
  currentPlayer: Player;
  mode: Mode;
  difficulty: Difficulty;
  /** The colour the human controls (only meaningful in "ai" mode). */
  humanPlayer: Player;
  /** Mid multi-jump: only this piece may move, and only by capturing. */
  mustContinueFrom: Square | null;
  status: GameStatus;
  /** Set when status === "won". */
  winner: Player | null;
}

export const SIZE = 8;
/** Red always opens. */
export const FIRST_PLAYER: Player = "red";

export type RandomFn = () => number;

export function otherPlayer(player: Player): Player {
  return player === "red" ? "black" : "red";
}

const inBounds = (row: number, col: number): boolean =>
  row >= 0 && row < SIZE && col >= 0 && col < SIZE;

/** Dark squares (playable) are the ones where row+col is odd. */
export function isPlayable(row: number, col: number): boolean {
  return inBounds(row, col) && (row + col) % 2 === 1;
}

export function pieceAt(board: Board, square: Square): Cell {
  if (!inBounds(square.row, square.col)) return null;
  return board[square.row][square.col];
}

const sameSquare = (first: Square, second: Square): boolean =>
  first.row === second.row && first.col === second.col;

export function createBoard(): Board {
  return Array.from({ length: SIZE }, (_unused, row) =>
    Array.from({ length: SIZE }, (_alsoUnused, col): Cell => {
      if (!isPlayable(row, col)) return null;
      if (row <= 2) return { player: "black", kind: "man" };
      if (row >= 5) return { player: "red", kind: "man" };
      return null;
    }),
  );
}

// Diagonal steps. Men move only "forward" (toward the far row); kings use all
// four. Red's forward is up the board (row decreasing), Black's is down.
const RED_FORWARD: ReadonlyArray<Square> = [
  { row: -1, col: -1 },
  { row: -1, col: 1 },
];
const BLACK_FORWARD: ReadonlyArray<Square> = [
  { row: 1, col: -1 },
  { row: 1, col: 1 },
];
const ALL_DIAGONALS: ReadonlyArray<Square> = [...RED_FORWARD, ...BLACK_FORWARD];

function moveDirections(piece: Piece): ReadonlyArray<Square> {
  if (piece.kind === "king") return ALL_DIAGONALS;
  return piece.player === "red" ? RED_FORWARD : BLACK_FORWARD;
}

/** Row a man of `player` is crowned on when reached. */
function crownRow(player: Player): number {
  return player === "red" ? 0 : SIZE - 1;
}

/** All capture steps available from `square` for the piece sitting there. */
function capturesFrom(board: Board, square: Square): Move[] {
  const piece = pieceAt(board, square);
  if (!piece) return [];
  const moves: Move[] = [];
  for (const step of moveDirections(piece)) {
    const overRow = square.row + step.row;
    const overCol = square.col + step.col;
    const landRow = square.row + step.row * 2;
    const landCol = square.col + step.col * 2;
    if (!inBounds(landRow, landCol)) continue;
    const jumped = board[overRow][overCol];
    if (!jumped || jumped.player === piece.player) continue;
    if (board[landRow][landCol] !== null) continue;
    moves.push({
      from: square,
      to: { row: landRow, col: landCol },
      captured: { row: overRow, col: overCol },
    });
  }
  return moves;
}

/** All plain (non-capturing) slides from `square`. */
function slidesFrom(board: Board, square: Square): Move[] {
  const piece = pieceAt(board, square);
  if (!piece) return [];
  const moves: Move[] = [];
  for (const step of moveDirections(piece)) {
    const toRow = square.row + step.row;
    const toCol = square.col + step.col;
    if (!inBounds(toRow, toCol)) continue;
    if (board[toRow][toCol] !== null) continue;
    moves.push({ from: square, to: { row: toRow, col: toCol }, captured: null });
  }
  return moves;
}

function ownSquares(board: Board, player: Player): Square[] {
  const squares: Square[] = [];
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      if (board[row][col]?.player === player) squares.push({ row, col });
    }
  }
  return squares;
}

/**
 * The legal moves for the side to move. Capture is mandatory: if any capture
 * exists, only captures are returned. Mid multi-jump (`mustContinueFrom` set)
 * only that piece's further captures are legal.
 */
export function legalMoves(state: GameState): Move[] {
  if (state.status !== "playing") return [];

  if (state.mustContinueFrom) {
    return capturesFrom(state.board, state.mustContinueFrom);
  }

  const squares = ownSquares(state.board, state.currentPlayer);
  const captures = squares.flatMap((square) => capturesFrom(state.board, square));
  if (captures.length > 0) return captures;
  return squares.flatMap((square) => slidesFrom(state.board, square));
}

function hasAnyMove(board: Board, player: Player): boolean {
  const state: GameState = {
    board,
    currentPlayer: player,
    mode: "local",
    difficulty: "medium",
    humanPlayer: "red",
    mustContinueFrom: null,
    status: "playing",
    winner: null,
  };
  return legalMoves(state).length > 0;
}

export function createGame(options: {
  mode: Mode;
  difficulty?: Difficulty;
  humanPlayer?: Player;
}): GameState {
  return {
    board: createBoard(),
    currentPlayer: FIRST_PLAYER,
    mode: options.mode,
    difficulty: options.difficulty ?? "medium",
    humanPlayer: options.humanPlayer ?? "red",
    mustContinueFrom: null,
    status: "playing",
    winner: null,
  };
}

/** Is `move` among the legal moves for `state`? */
export function isLegalMove(state: GameState, move: Move): boolean {
  return legalMoves(state).some(
    (candidate) =>
      sameSquare(candidate.from, move.from) && sameSquare(candidate.to, move.to),
  );
}

/**
 * Apply one diagonal step (slide or single jump). Returns a new state, never
 * mutates the input. Throws on an illegal move. A capture that neither crowns
 * the piece nor exhausts its further jumps keeps the turn open (same player,
 * `mustContinueFrom` set) so the UI can chain the multi-jump.
 */
export function applyMove(state: GameState, move: Move): GameState {
  if (state.status !== "playing") throw new Error("game is already over");
  const legal = legalMoves(state).find(
    (candidate) =>
      sameSquare(candidate.from, move.from) && sameSquare(candidate.to, move.to),
  );
  if (!legal) throw new Error("illegal move");

  const piece = pieceAt(state.board, legal.from)!;
  const reachedCrown = piece.kind === "man" && legal.to.row === crownRow(piece.player);
  const landed: Piece = reachedCrown ? { ...piece, kind: "king" } : piece;

  const board = state.board.map((cells) => cells.slice());
  board[legal.from.row][legal.from.col] = null;
  if (legal.captured) board[legal.captured.row][legal.captured.col] = null;
  board[legal.to.row][legal.to.col] = landed;

  // A crowning move always ends the turn, even with a further jump available.
  const canContinue =
    legal.captured !== null &&
    !reachedCrown &&
    capturesFrom(board, legal.to).length > 0;

  if (canContinue) {
    return { ...state, board, mustContinueFrom: legal.to };
  }

  const next = otherPlayer(state.currentPlayer);
  if (!hasAnyMove(board, next)) {
    return {
      ...state,
      board,
      mustContinueFrom: null,
      status: "won",
      winner: state.currentPlayer,
    };
  }
  return { ...state, board, currentPlayer: next, mustContinueFrom: null };
}

// ---------------------------------------------------------------------------
// AI — depth-limited negamax with alpha-beta pruning over full turns.
// ---------------------------------------------------------------------------
// A "ply" here is one complete turn: a multi-jump (which keeps `currentPlayer`
// the same) is followed to its end before the opponent replies, so the search
// values whole captures, not half of one. The two knobs mirror Quadra:
//   • depth       — turns of look-ahead.
//   • blunderRate — chance per move of skipping the search and playing a random
//                   legal move; the only thing that makes "easy" beatable.
interface LevelConfig {
  depth: number;
  blunderRate: number;
}
const LEVELS: Record<Difficulty, LevelConfig> = {
  easy: { depth: 2, blunderRate: 0.3 },
  medium: { depth: 4, blunderRate: 0.08 },
  hard: { depth: 6, blunderRate: 0 },
  expert: { depth: 8, blunderRate: 0 },
};

const WIN_SCORE = 100000;
const MAN_VALUE = 100;
const KING_VALUE = 175;

/** Static evaluation from `player`'s perspective. Material dominates; men earn a
 *  small bonus for advancing toward promotion and for hugging the back row
 *  (a full back rank the opponent can't crown behind). */
export function evaluate(board: Board, player: Player): number {
  let score = 0;
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const piece = board[row][col];
      if (!piece) continue;
      const sign = piece.player === player ? 1 : -1;
      if (piece.kind === "king") {
        score += sign * KING_VALUE;
      } else {
        // Distance advanced toward the crown row (0 at start … 6 near promotion).
        const advanced = piece.player === "red" ? SIZE - 1 - row : row;
        score += sign * (MAN_VALUE + advanced * 4);
        const backRow = piece.player === "red" ? SIZE - 1 : 0;
        if (row === backRow) score += sign * 6;
      }
    }
  }
  return score;
}

/** Complete a turn from `state` by walking every capture continuation to its
 *  end. Returns the states in which the opponent is to move (or the game is
 *  over) — i.e. one entry per full legal turn. */
function resolvedTurns(state: GameState): GameState[] {
  const results: GameState[] = [];
  const walk = (current: GameState): void => {
    for (const move of legalMoves(current)) {
      const next = applyMove(current, move);
      const stillSameTurn =
        next.status === "playing" && next.currentPlayer === current.currentPlayer;
      if (stillSameTurn) walk(next);
      else results.push(next);
    }
  };
  walk(state);
  return results;
}

/** Negamax value of `state` for the side to move. A `state` whose status is
 *  already "won" means the side to move has no reply and has lost. */
function negamax(state: GameState, depth: number, alpha: number, beta: number): number {
  if (state.status !== "playing") return -(WIN_SCORE + depth);
  if (depth === 0) return evaluate(state.board, state.currentPlayer);

  let best = -Infinity;
  for (const turn of resolvedTurns(state)) {
    const value = -negamax(turn, depth - 1, -beta, -alpha);
    if (value > best) best = value;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // prune
  }
  return best;
}

/** Value, from the mover's perspective, of playing `firstStep` now and then
 *  completing the turn optimally. Continuations (same player) recurse and take
 *  the best; a turn-ending step hands off to the opponent via negamax. */
function scoreFirstStep(state: GameState, firstStep: Move, depth: number): number {
  const next = applyMove(state, firstStep);
  if (next.status !== "playing") {
    // The step ended the game — a win for the mover dominates everything.
    return next.winner === state.currentPlayer ? WIN_SCORE * 2 : -WIN_SCORE * 2;
  }
  if (next.currentPlayer === state.currentPlayer) {
    // Multi-jump continues: still our turn, keep the best onward line.
    return Math.max(
      ...legalMoves(next).map((step) => scoreFirstStep(next, step, depth)),
    );
  }
  return -negamax(next, depth - 1, -Infinity, Infinity);
}

/**
 * Pick one diagonal step for the side to move. Returns a single step (from→to,
 * possibly a capture); when a multi-jump is in progress the UI simply calls
 * again, since `mustContinueFrom` narrows the legal set to the continuing piece.
 * With probability `blunderRate` (easy only) plays a random legal step instead
 * of searching — that's what lets a beginner win.
 */
export function getAiMove(
  state: GameState,
  random: RandomFn = Math.random,
): Move {
  const moves = legalMoves(state);
  if (moves.length === 0) throw new Error("no legal move — check status first");
  if (moves.length === 1) return moves[0];

  const { depth, blunderRate } = LEVELS[state.difficulty];
  if (blunderRate > 0 && random() < blunderRate) {
    return moves[Math.floor(random() * moves.length)];
  }

  const scored = moves.map((move) => ({
    move,
    score: scoreFirstStep(state, move, depth),
  }));
  const bestScore = Math.max(...scored.map((entry) => entry.score));
  const best = scored.filter((entry) => entry.score === bestScore);
  return best[Math.floor(random() * best.length)].move;
}
