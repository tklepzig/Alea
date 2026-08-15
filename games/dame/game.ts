// Pure game logic for Dame (English draughts, 8×8) — no DOM, no storage.
// Board is board[row][col] with row 0 at the top. Pieces live on the dark
// squares only ((row+col) odd). Red starts at the bottom and moves up (row
// decreasing); Black starts at the top and moves down. Everything here is
// deterministic given an injected RNG, so it's fully unit-testable.
//
// Ruleset (English draughts): capture is mandatory (Schlagzwang); men capture
// forward only; a man that reaches the far row is crowned and its turn ends,
// even if a further jump would otherwise be available.
//
// Two variants are switchable per game. `maxCapture` (Mehrschlagzwang) forces
// the capture sequence that takes the most pieces; off, any capture may be
// chosen (English draughts).
//
// `flyingKings`: off, a king ("Dame")
// moves and captures one square in any diagonal (English); on, it slides any
// distance along a free diagonal and jumps an enemy at any distance, landing on
// any free square beyond it (German/International "fliegende Dame").
//
// Captured pieces are swept off the board only when the turn ends: mid
// multi-jump they stay put, so they still block a diagonal and can't be jumped
// a second time (`pendingCaptures`, the International rule).

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

/** A single diagonal move. A multi-jump is a chain of capture moves, one per
 *  hop — the UI plays them out and the engine keeps the turn open via
 *  `mustContinueFrom` while more jumps remain. With flying kings `from` and `to`
 *  can be several squares apart. */
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
  /** Variant: a king moves and captures along the whole diagonal. */
  flyingKings: boolean;
  /** Variant: of all capture sequences, only the longest ones are legal. */
  maxCapture: boolean;
  /** Mid multi-jump: only this piece may move, and only by capturing. */
  mustContinueFrom: Square | null;
  /** Jumped this turn, still on the board: they block and can't be jumped
   *  again. Swept off — and emptied — when the turn ends. */
  pendingCaptures: Square[];
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

const squareKey = (square: Square): string => `${square.row},${square.col}`;

const NO_PENDING: ReadonlySet<string> = new Set();

const pendingKeys = (squares: Square[]): ReadonlySet<string> =>
  squares.length === 0 ? NO_PENDING : new Set(squares.map(squareKey));

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

/** The squares along `step` from `square`, nearest first, out to the edge. */
function rayFrom(square: Square, step: Square): Square[] {
  const squares: Square[] = [];
  for (let distance = 1; ; distance++) {
    const row = square.row + step.row * distance;
    const col = square.col + step.col * distance;
    if (!inBounds(row, col)) return squares;
    squares.push({ row, col });
  }
}

/** The leading run of empty squares of `squares` (stops at the first piece). */
function emptyPrefix(board: Board, squares: Square[]): Square[] {
  const blocked = squares.findIndex((square) => board[square.row][square.col] !== null);
  return blocked === -1 ? squares : squares.slice(0, blocked);
}

/** A flying king ranges over the whole diagonal; everything else one square. */
function isFlying(piece: Piece, flyingKings: boolean): boolean {
  return flyingKings && piece.kind === "king";
}

/** Already jumped this turn? Skipping the key-building for the common empty set
 *  matters: this sits in the AI search's innermost loop. */
function isPending(pending: ReadonlySet<string>, square: Square): boolean {
  return pending.size > 0 && pending.has(squareKey(square));
}

/**
 * The single jump of a man or a non-flying king: over the neighbour, onto the
 * square right behind it. Index arithmetic, no ray allocation — `legalMoves` is
 * the innermost loop of the search and this is the path every default game takes.
 */
function shortCaptureAlong(
  board: Board,
  from: Square,
  piece: Piece,
  step: Square,
  pending: ReadonlySet<string>,
): Move[] {
  const overRow = from.row + step.row;
  const overCol = from.col + step.col;
  const toRow = from.row + step.row * 2;
  const toCol = from.col + step.col * 2;
  if (!inBounds(toRow, toCol)) return [];
  const jumped = board[overRow][overCol];
  if (!jumped || jumped.player === piece.player) return [];
  if (board[toRow][toCol] !== null) return [];
  const over = { row: overRow, col: overCol };
  if (isPending(pending, over)) return [];
  return [{ from, to: { row: toRow, col: toCol }, captured: over }];
}

/**
 * Captures from `square` along one diagonal. At most one piece per direction is
 * jumpable — the first one on the ray — so a flying king yields one move per
 * free landing square beyond it.
 */
function capturesAlong(
  board: Board,
  from: Square,
  piece: Piece,
  step: Square,
  flyingKings: boolean,
  pending: ReadonlySet<string>,
): Move[] {
  if (!isFlying(piece, flyingKings)) {
    return shortCaptureAlong(board, from, piece, step, pending);
  }

  const ray = rayFrom(from, step);
  const overIndex = ray.findIndex((square) => board[square.row][square.col] !== null);
  if (overIndex === -1) return [];

  const over = ray[overIndex];
  const jumped = board[over.row][over.col]!;
  if (jumped.player === piece.player) return [];
  if (isPending(pending, over)) return []; // already taken this turn

  return emptyPrefix(board, ray.slice(overIndex + 1)).map((to) => ({
    from,
    to,
    captured: over,
  }));
}

/** All captures available from `square` for the piece sitting there. */
function capturesFrom(
  board: Board,
  square: Square,
  flyingKings: boolean,
  pending: ReadonlySet<string>,
): Move[] {
  const piece = pieceAt(board, square);
  if (!piece) return [];
  return moveDirections(piece).flatMap((step) =>
    capturesAlong(board, square, piece, step, flyingKings, pending),
  );
}

/** All plain (non-capturing) slides from `square`. */
function slidesFrom(board: Board, square: Square, flyingKings: boolean): Move[] {
  const piece = pieceAt(board, square);
  if (!piece) return [];
  const flying = isFlying(piece, flyingKings);
  return moveDirections(piece).flatMap((step) => {
    if (flying) {
      return emptyPrefix(board, rayFrom(square, step)).map((to) => ({
        from: square,
        to,
        captured: null,
      }));
    }
    // One step — no ray, see `shortCaptureAlong`.
    const toRow = square.row + step.row;
    const toCol = square.col + step.col;
    if (!inBounds(toRow, toCol) || board[toRow][toCol] !== null) return [];
    return [{ from: square, to: { row: toRow, col: toCol }, captured: null }];
  });
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

/** The moves before Mehrschlagzwang narrows them down: capture is mandatory, and
 *  mid multi-jump only the continuing piece may move. */
function candidateMoves(state: GameState, pending: ReadonlySet<string>): Move[] {
  if (state.mustContinueFrom) {
    return capturesFrom(state.board, state.mustContinueFrom, state.flyingKings, pending);
  }

  const squares = ownSquares(state.board, state.currentPlayer);
  const captures = squares.flatMap((square) =>
    capturesFrom(state.board, square, state.flyingKings, pending),
  );
  if (captures.length > 0) return captures;
  return squares.flatMap((square) => slidesFrom(state.board, square, state.flyingKings));
}

/**
 * How many pieces the longest chain starting with `move` takes. Crowning cuts a
 * chain short, so it counts as the last hop. Walks `board` in place and restores
 * it — `board` must be a scratch copy, never a live state's.
 */
function chainLength(
  board: Board,
  move: Move,
  flyingKings: boolean,
  pending: Set<string>,
): number {
  const piece = board[move.from.row][move.from.col]!;
  if (piece.kind === "man" && move.to.row === crownRow(piece.player)) return 1;

  board[move.from.row][move.from.col] = null;
  board[move.to.row][move.to.col] = piece;
  const capturedKey = squareKey(move.captured!);
  pending.add(capturedKey);

  const onward = Math.max(
    0,
    ...capturesFrom(board, move.to, flyingKings, pending).map((next) =>
      chainLength(board, next, flyingKings, pending),
    ),
  );

  pending.delete(capturedKey);
  board[move.to.row][move.to.col] = null;
  board[move.from.row][move.from.col] = piece;
  return 1 + onward;
}

/**
 * The legal moves for the side to move. Capture is mandatory: if any capture
 * exists, only captures are returned. Mid multi-jump (`mustContinueFrom` set)
 * only that piece's further captures are legal. With `maxCapture` on, only the
 * captures that lead into a longest sequence survive — the hops already played
 * are common to every continuation, so comparing what is still to come is
 * enough.
 */
export function legalMoves(state: GameState): Move[] {
  if (state.status !== "playing") return [];

  // Outside a multi-jump nothing is pending, which is the case in nearly every
  // searched node — don't allocate a Set for it.
  const pending = pendingKeys(state.pendingCaptures);
  const candidates = candidateMoves(state, pending);
  if (!state.maxCapture || candidates.length < 2) return candidates;
  if (candidates[0].captured === null) return candidates; // slides: nothing to weigh

  const scratch = state.board.map((cells) => cells.slice());
  const scratchPending = new Set(pending); // chainLength marks and unmarks as it walks
  const scored = candidates.map((move) => ({
    move,
    hops: chainLength(scratch, move, state.flyingKings, scratchPending),
  }));
  const longest = Math.max(...scored.map((entry) => entry.hops));
  return scored.filter((entry) => entry.hops === longest).map((entry) => entry.move);
}

function hasAnyMove(board: Board, player: Player, flyingKings: boolean): boolean {
  const state: GameState = {
    board,
    currentPlayer: player,
    mode: "local",
    difficulty: "medium",
    humanPlayer: "red",
    flyingKings,
    maxCapture: false, // irrelevant: only "is there any move at all?" is asked
    mustContinueFrom: null,
    pendingCaptures: [],
    status: "playing",
    winner: null,
  };
  return legalMoves(state).length > 0;
}

export function createGame(options: {
  mode: Mode;
  difficulty?: Difficulty;
  humanPlayer?: Player;
  flyingKings?: boolean;
  maxCapture?: boolean;
}): GameState {
  return {
    board: createBoard(),
    currentPlayer: FIRST_PLAYER,
    mode: options.mode,
    difficulty: options.difficulty ?? "medium",
    humanPlayer: options.humanPlayer ?? "red",
    flyingKings: options.flyingKings ?? false,
    maxCapture: options.maxCapture ?? false,
    mustContinueFrom: null,
    pendingCaptures: [],
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
 * Apply one diagonal move (slide or single jump). Returns a new state, never
 * mutates the input. Throws on an illegal move. A capture that neither crowns
 * the piece nor exhausts its further jumps keeps the turn open (same player,
 * `mustContinueFrom` set) so the UI can chain the multi-jump; the jumped pieces
 * only leave the board once the turn actually ends.
 */
export function applyMove(state: GameState, move: Move): GameState {
  if (state.status !== "playing") throw new Error("game is already over");
  const legal = legalMoves(state).find(
    (candidate) =>
      sameSquare(candidate.from, move.from) && sameSquare(candidate.to, move.to),
  );
  if (!legal) throw new Error("illegal move");
  return applyLegalMove(state, legal);
}

/** The move transition itself. `legal` MUST come from `legalMoves` — the search
 *  calls this directly to avoid regenerating the legal set at every node. */
function applyLegalMove(state: GameState, legal: Move): GameState {
  const piece = pieceAt(state.board, legal.from)!;
  const reachedCrown = piece.kind === "man" && legal.to.row === crownRow(piece.player);
  const landed: Piece = reachedCrown ? { ...piece, kind: "king" } : piece;

  const board = state.board.map((cells) => cells.slice());
  board[legal.from.row][legal.from.col] = null;
  board[legal.to.row][legal.to.col] = landed;

  // The jumped piece stays put for now — see `pendingCaptures`.
  const pendingCaptures = legal.captured
    ? [...state.pendingCaptures, legal.captured]
    : state.pendingCaptures;

  // A crowning move always ends the turn, even with a further jump available.
  const canContinue =
    legal.captured !== null &&
    !reachedCrown &&
    capturesFrom(board, legal.to, state.flyingKings, pendingKeys(pendingCaptures)).length > 0;

  if (canContinue) {
    return { ...state, board, pendingCaptures, mustContinueFrom: legal.to };
  }

  // Turn over: sweep everything captured along the way off the board.
  for (const square of pendingCaptures) board[square.row][square.col] = null;

  const next = otherPlayer(state.currentPlayer);
  if (!hasAnyMove(board, next, state.flyingKings)) {
    return {
      ...state,
      board,
      mustContinueFrom: null,
      pendingCaptures: [],
      status: "won",
      winner: state.currentPlayer,
    };
  }
  return {
    ...state,
    board,
    currentPlayer: next,
    mustContinueFrom: null,
    pendingCaptures: [],
  };
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
// A flying Dame has ~13 destinations instead of 4, so a quiet king endgame at
// depth 8 takes seconds — on the main thread that's a frozen board. Search
// shallower when the variant is on: worst measured move is ~320ms for six kings
// on open diagonals (the branching peak), against ~17s at the full depth.
const FLYING_DEPTHS: Record<Difficulty, number> = {
  easy: 2,
  medium: 3,
  hard: 4,
  expert: 5,
};

function searchDepth(state: GameState): number {
  return state.flyingKings
    ? FLYING_DEPTHS[state.difficulty]
    : LEVELS[state.difficulty].depth;
}

const WIN_SCORE = 100000;
const MAN_VALUE = 100;
const KING_VALUE = 175;
// A flying Dame dominates the board from a distance — worth far more than a man.
const FLYING_KING_VALUE = 300;

/** Static evaluation from `player`'s perspective. Material dominates; men earn a
 *  small bonus for advancing toward promotion and for hugging the back row
 *  (a full back rank the opponent can't crown behind). */
export function evaluate(board: Board, player: Player, flyingKings = false): number {
  const kingValue = flyingKings ? FLYING_KING_VALUE : KING_VALUE;
  let score = 0;
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const piece = board[row][col];
      if (!piece) continue;
      const sign = piece.player === player ? 1 : -1;
      if (piece.kind === "king") {
        score += sign * kingValue;
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
      const next = applyLegalMove(current, move);
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
  if (depth === 0) return evaluate(state.board, state.currentPlayer, state.flyingKings);

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
  const next = applyLegalMove(state, firstStep);
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

/** Best of `moves` searched to exactly `depth`. Every move that ties the top
 *  score is a candidate and `random` picks between them, so the AI doesn't
 *  always answer a position the same way. Consumes exactly one `random()`. */
function bestMoveAtDepth(
  state: GameState,
  moves: Move[],
  depth: number,
  random: RandomFn,
): { move: Move; score: number } {
  const scored = moves.map((move) => ({
    move,
    score: scoreFirstStep(state, move, depth),
  }));
  const bestScore = Math.max(...scored.map((entry) => entry.score));
  const best = scored.filter((entry) => entry.score === bestScore);
  return best[Math.floor(random() * best.length)];
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
  const { moves, shortcut } = openingChoice(state, random);
  if (shortcut) return shortcut;
  return bestMoveAtDepth(state, moves, searchDepth(state), random).move;
}

/** The depths an iterative search walks before reaching `target`. The target is
 *  always last, even when the ladder's stride would skip it (flying expert = 5). */
function depthLadder(target: number): number[] {
  const ladder: number[] = [];
  for (let depth = 2; depth < target; depth += 2) ladder.push(depth);
  ladder.push(target);
  return ladder;
}

export interface SearchProgress {
  depth: number;
  move: Move;
  score: number;
}

/**
 * Same search as `getAiMove`, reached by walking increasing depths and calling
 * `onDepth` after each one completes. The final depth — and so the strength — is
 * identical; the intermediate results exist so a caller still holds a playable
 * move if the search never finishes.
 *
 * That matters on low-memory devices: a deep search can be killed outright
 * mid-flight, taking the whole JS execution context (pending timers included)
 * with it, so there is no way to recover a result after the fact. Run this in a
 * worker and keep the last reported move.
 *
 * Note it consumes one `random()` per depth for tie-breaking, so among moves
 * that score *equally* it may land on a different one than `getAiMove` — the
 * score of the move it returns is the same.
 */
export function getAiMoveIterative(
  state: GameState,
  random: RandomFn = Math.random,
  onDepth?: (progress: SearchProgress) => void,
): Move {
  const { moves, shortcut } = openingChoice(state, random);
  if (shortcut) return shortcut;

  let best = { move: moves[0], score: -Infinity };
  for (const depth of depthLadder(searchDepth(state))) {
    best = bestMoveAtDepth(state, moves, depth, random);
    onDepth?.({ depth, move: best.move, score: best.score });
  }
  return best.move;
}
