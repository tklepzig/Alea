// Pure game logic — no DOM, no storage. The board is indexed [column][row] with
// row 0 at the bottom (discs fall down under gravity). Everything here is
// deterministic given an injected RNG, so it's fully unit-testable.

export type Player = "red" | "yellow";
export type Cell = Player | null;
/** board[column][row]; row 0 is the bottom slot. 7 columns × 6 rows. */
export type Board = Cell[][];
export type Difficulty = "easy" | "medium" | "hard" | "expert";
export type Mode = "local" | "ai";
export type GameStatus = "playing" | "won" | "draw";

export interface Move {
  column: number;
  row: number;
}

export interface GameState {
  board: Board;
  /** Whose turn it is. */
  currentPlayer: Player;
  mode: Mode;
  /** Only meaningful in "ai" mode. */
  difficulty: Difficulty;
  /** The colour the human controls (only meaningful in "ai" mode). */
  humanPlayer: Player;
  status: GameStatus;
  /** Set when status === "won". */
  winner: Player | null;
  /** The cells forming the win (>= 4), for highlighting. */
  winningCells: Move[] | null;
}

export const COLUMNS = 7;
export const ROWS = 6;
/** Red always moves first — the classic opening. */
export const FIRST_PLAYER: Player = "red";

const WIN_LENGTH = 4;

export type RandomFn = () => number;

export function otherPlayer(player: Player): Player {
  return player === "red" ? "yellow" : "red";
}

export function createBoard(): Board {
  return Array.from({ length: COLUMNS }, () =>
    Array.from({ length: ROWS }, (): Cell => null),
  );
}

/** The lowest empty row in a column, or -1 if the column is full / out of range. */
export function lowestEmptyRow(board: Board, column: number): number {
  if (column < 0 || column >= COLUMNS) return -1;
  const slots = board[column];
  for (let row = 0; row < ROWS; row++) {
    if (slots[row] === null) return row;
  }
  return -1;
}

export function isColumnPlayable(board: Board, column: number): boolean {
  return lowestEmptyRow(board, column) !== -1;
}

export function validColumns(board: Board): number[] {
  const columns: number[] = [];
  for (let column = 0; column < COLUMNS; column++) {
    if (isColumnPlayable(board, column)) columns.push(column);
  }
  return columns;
}

/**
 * Drop a disc into a column for `player`. Returns a new board and the row the
 * disc landed in, or null if the column is full / out of range. Never mutates
 * the input — only the target column is rebuilt, the rest is shared.
 */
export function dropDisc(
  board: Board,
  column: number,
  player: Player,
): { board: Board; row: number } | null {
  const row = lowestEmptyRow(board, column);
  if (row === -1) return null;

  const next = board.map((slots, index) =>
    index === column
      ? slots.map((cell, rowIndex) => (rowIndex === row ? player : cell))
      : slots,
  );
  return { board: next, row };
}

// The four line orientations to test, expressed as a (column, row) step. Each
// is checked in both directions from the last move, so one entry covers a full
// axis (e.g. {1,0} covers the whole horizontal row left and right).
const DIRECTIONS: ReadonlyArray<{ dc: number; dr: number }> = [
  { dc: 1, dr: 0 }, // horizontal —
  { dc: 0, dr: 1 }, // vertical |
  { dc: 1, dr: 1 }, // diagonal /
  { dc: 1, dr: -1 }, // diagonal \
];

/**
 * Does the disc just placed at `lastMove` complete a line of four? Returns the
 * winning cells (>= 4) or null. Only lines through `lastMove` are considered —
 * sufficient, because a win can only ever be created by the most recent move.
 */
export function checkWin(board: Board, lastMove: Move): Move[] | null {
  const player = board[lastMove.column]?.[lastMove.row];
  if (!player) return null;

  for (const { dc, dr } of DIRECTIONS) {
    const line: Move[] = [{ column: lastMove.column, row: lastMove.row }];

    // Extend forward along the axis.
    for (let step = 1; ; step++) {
      const column = lastMove.column + dc * step;
      const row = lastMove.row + dr * step;
      if (board[column]?.[row] !== player) break;
      line.push({ column, row });
    }
    // Extend backward along the same axis.
    for (let step = 1; ; step++) {
      const column = lastMove.column - dc * step;
      const row = lastMove.row - dr * step;
      if (board[column]?.[row] !== player) break;
      line.unshift({ column, row });
    }

    if (line.length >= WIN_LENGTH) return line;
  }
  return null;
}

/** A board is full when every column's top slot is occupied. */
export function isBoardFull(board: Board): boolean {
  return board.every((slots) => slots[ROWS - 1] !== null);
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
    difficulty: options.difficulty ?? "hard",
    humanPlayer: options.humanPlayer ?? "red",
    status: "playing",
    winner: null,
    winningCells: null,
  };
}

/**
 * Apply a move for the current player: drop the disc, detect win/draw, and flip
 * the turn. Returns a new state, never mutates the input. Throws on an illegal
 * move (full / out-of-range column, or an already-finished game) — the UI is
 * expected to only pass playable columns.
 *
 * Win beats draw: a move that completes a line *and* fills the last slot is a
 * win, not a draw.
 */
export function applyMove(state: GameState, column: number): GameState {
  if (state.status !== "playing") {
    throw new Error("game is already over");
  }
  const dropped = dropDisc(state.board, column, state.currentPlayer);
  if (!dropped) {
    throw new Error(`column ${column} is not playable`);
  }

  const { board, row } = dropped;
  const winningCells = checkWin(board, { column, row });
  if (winningCells) {
    return {
      ...state,
      board,
      status: "won",
      winner: state.currentPlayer,
      winningCells,
    };
  }
  if (isBoardFull(board)) {
    return { ...state, board, status: "draw", winner: null, winningCells: null };
  }
  return { ...state, board, currentPlayer: otherPlayer(state.currentPlayer) };
}

// ---------------------------------------------------------------------------
// AI — depth-limited minimax (negamax form) with alpha-beta pruning.
// ---------------------------------------------------------------------------
// Connect-four-style games are solved (perfect play from the centre wins), but
// a full solver needs bitboards and an opening book. This heuristic search is
// deliberately simpler and readable: strong enough to be a real opponent at
// depth 7, beatable at depth 2 with the odd blunder.
//
// Each level tunes TWO independent knobs, because the two things players want
// from "easier" are different:
//   • depth      — how many plies the search looks ahead. Lower depth can't see
//                  multi-move combinations (forks/double-threats), so a
//                  depth-limited-but-blunderless AI is the one that *teaches*
//                  strategy: it reliably blocks your one-move threats but loses
//                  to a setup it can't see coming.
//   • blunderRate — chance per move of skipping the search entirely and playing
//                  a random legal column. This is the ONLY thing that makes the
//                  AI genuinely beatable: even a 1-ply search always spots and
//                  blocks your immediate win, so depth alone never lets you
//                  punish it. Reserve a meaningful blunder rate for the lowest
//                  rung ("don't lose all the time"); keep it at 0 higher up
//                  ("learn the strategies" — wins should be earned, not gifted).
interface LevelConfig {
  depth: number;
  blunderRate: number;
}
const LEVELS: Record<Difficulty, LevelConfig> = {
  easy: { depth: 2, blunderRate: 0.3 },
  medium: { depth: 4, blunderRate: 0.08 },
  hard: { depth: 6, blunderRate: 0 },
  expert: { depth: 7, blunderRate: 0 },
};

// Far larger than any heuristic score, so a forced win/loss always dominates.
const WIN_SCORE = 1000000;

// Try central columns first: they're the strongest squares and order the
// alpha-beta search so it prunes far more aggressively.
const COLUMN_ORDER: readonly number[] = [3, 2, 4, 1, 5, 0, 6];

/** Score one length-4 window from `player`'s perspective. Mixed windows (both
 *  colours present) can never be completed, so they're worth nothing. */
function scoreWindow(window: readonly Cell[], player: Player): number {
  const opponent = otherPlayer(player);
  let own = 0;
  let foe = 0;
  let empty = 0;
  for (const cell of window) {
    if (cell === player) own++;
    else if (cell === opponent) foe++;
    else empty++;
  }
  if (own > 0 && foe > 0) return 0;
  if (own === 3 && empty === 1) return 50;
  if (own === 2 && empty === 2) return 10;
  // Weight the opponent's threats slightly heavier so the AI prefers blocking.
  if (foe === 3 && empty === 1) return -80;
  if (foe === 2 && empty === 2) return -8;
  return 0;
}

function* windows(board: Board): Generator<Cell[]> {
  // Horizontal
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column + WIN_LENGTH <= COLUMNS; column++) {
      yield [0, 1, 2, 3].map((offset) => board[column + offset][row]);
    }
  }
  // Vertical
  for (let column = 0; column < COLUMNS; column++) {
    for (let row = 0; row + WIN_LENGTH <= ROWS; row++) {
      yield [0, 1, 2, 3].map((offset) => board[column][row + offset]);
    }
  }
  // Diagonal /
  for (let column = 0; column + WIN_LENGTH <= COLUMNS; column++) {
    for (let row = 0; row + WIN_LENGTH <= ROWS; row++) {
      yield [0, 1, 2, 3].map((offset) => board[column + offset][row + offset]);
    }
  }
  // Diagonal \
  for (let column = 0; column + WIN_LENGTH <= COLUMNS; column++) {
    for (let row = WIN_LENGTH - 1; row < ROWS; row++) {
      yield [0, 1, 2, 3].map((offset) => board[column + offset][row - offset]);
    }
  }
}

function evaluate(board: Board, player: Player): number {
  let total = 0;
  // Centre-column control bonus.
  const centre = Math.floor(COLUMNS / 2);
  for (let row = 0; row < ROWS; row++) {
    if (board[centre][row] === player) total += 6;
    else if (board[centre][row] === otherPlayer(player)) total -= 6;
  }
  for (const window of windows(board)) {
    total += scoreWindow(window, player);
  }
  return total;
}

/** Negamax with alpha-beta. Returns the value of `board` for `player` (the side
 *  to move). Detects immediate wins for the side to move at any depth, so the
 *  search never misses a one-move win or, via the recursion, a needed block. */
function negamax(
  board: Board,
  player: Player,
  depth: number,
  alpha: number,
  beta: number,
): number {
  const moves = COLUMN_ORDER.filter((column) => isColumnPlayable(board, column));
  if (moves.length === 0) return 0; // board full — draw

  // If the side to move can win right now, that's the value (prefer faster wins).
  for (const column of moves) {
    const dropped = dropDisc(board, column, player)!;
    if (checkWin(dropped.board, { column, row: dropped.row })) {
      return WIN_SCORE + depth;
    }
  }

  if (depth === 0) return evaluate(board, player);

  let best = -Infinity;
  for (const column of moves) {
    const dropped = dropDisc(board, column, player)!;
    const value = -negamax(
      dropped.board,
      otherPlayer(player),
      depth - 1,
      -beta,
      -alpha,
    );
    if (value > best) best = value;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // prune
  }
  return best;
}

/**
 * Pick a column for `player`. With probability `blunderRate` (only non-zero on
 * "easy"), skips the search and plays a random legal column — this is what makes
 * the AI miss the occasional block/win so a beginner can actually beat it. The
 * rest of the time it searches: it always takes an immediate win, always blocks
 * an immediate loss, and otherwise plays the best move it can see within its
 * depth (random tie-break). Higher levels never blunder, so their only weakness
 * is the depth horizon — which is exactly what teaches forks and double-threats.
 */
export function getAiMove(
  board: Board,
  player: Player,
  difficulty: Difficulty,
  random: RandomFn = Math.random,
): number {
  const moves = COLUMN_ORDER.filter((column) => isColumnPlayable(board, column));
  if (moves.length === 0) {
    throw new Error("no playable column — check isBoardFull before calling");
  }
  if (moves.length === 1) return moves[0];

  const { depth, blunderRate } = LEVELS[difficulty];

  // Blunder: play a random legal column without searching. Deliberately allowed
  // to miss wins and blocks — that's the point of an easy opponent.
  if (blunderRate > 0 && random() < blunderRate) {
    return moves[Math.floor(random() * moves.length)];
  }

  const scored = moves.map((column) => {
    const dropped = dropDisc(board, column, player)!;
    // Take an outright win immediately, without searching deeper.
    if (checkWin(dropped.board, { column, row: dropped.row })) {
      return { column, score: WIN_SCORE * 2 };
    }
    const score = -negamax(
      dropped.board,
      otherPlayer(player),
      depth - 1,
      -Infinity,
      Infinity,
    );
    return { column, score };
  });

  const bestScore = Math.max(...scored.map((entry) => entry.score));

  if (difficulty === "easy") {
    // Accept any move within a small band of the best. A losing move (allowing
    // the opponent's win) scores around -WIN_SCORE, so it never enters the band
    // — blocking and winning are preserved.
    const TOLERANCE = 30;
    const acceptable = scored.filter((entry) => entry.score >= bestScore - TOLERANCE);
    return acceptable[Math.floor(random() * acceptable.length)].column;
  }

  const best = scored.filter((entry) => entry.score === bestScore);
  return best[Math.floor(random() * best.length)].column;
}
