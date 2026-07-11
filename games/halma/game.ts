// Pure game logic for Halma (compact 10×10) — no DOM, no storage. board[row][col];
// row 0 is the top. Red starts in the top-left corner camp and races to the
// bottom-right camp; Blue does the reverse. A turn is EITHER one step to an
// adjacent empty cell OR a chain of one-or-more jumps (each hopping a piece of
// either colour to the empty cell straight beyond); after any jump the mover may
// keep jumping or stop. A player wins when all ten of their pieces occupy the
// opposite camp. Everything here is deterministic given an injected RNG.

export type Player = "red" | "blue";
export type Cell = Player | null;
/** board[row][col]; 10×10, row 0 at the top. */
export type Board = Cell[][];
export type Difficulty = "easy" | "medium" | "hard" | "expert";
export type Mode = "local" | "ai";
export type GameStatus = "playing" | "won";

export interface Square {
  row: number;
  col: number;
}

export type Move =
  | { kind: "step"; from: Square; to: Square }
  | { kind: "jump"; from: Square; to: Square }
  | { kind: "end" };

export interface GameState {
  board: Board;
  currentPlayer: Player;
  /** Mid jump-chain: the piece that jumped and may jump again (or stop). */
  jumpingFrom: Square | null;
  /** Squares already occupied in the current chain — a jump may not revisit one
   *  (this is what makes a chain finite). Empty outside a chain. */
  jumpChain: Square[];
  mode: Mode;
  difficulty: Difficulty;
  humanPlayer: Player;
  status: GameStatus;
  winner: Player | null;
}

export const SIZE = 10;
export const PIECES_PER_PLAYER = 10;
export const FIRST_PLAYER: Player = "red";

export type RandomFn = () => number;

export function otherPlayer(player: Player): Player {
  return player === "red" ? "blue" : "red";
}

const inBounds = (row: number, col: number): boolean =>
  row >= 0 && row < SIZE && col >= 0 && col < SIZE;

const keyOf = (square: Square): string => `${square.row},${square.col}`;

// Corner camps: a 4-3-2-1 staircase of 10 cells. Top-left holds every cell with
// col ≤ 3 - row (rows 0..3); bottom-right is its point mirror.
function buildCamps(): { topLeft: Set<string>; bottomRight: Set<string> } {
  const topLeft = new Set<string>();
  const bottomRight = new Set<string>();
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col <= 3 - row; col++) {
      topLeft.add(keyOf({ row, col }));
      bottomRight.add(keyOf({ row: SIZE - 1 - row, col: SIZE - 1 - col }));
    }
  }
  return { topLeft, bottomRight };
}
const CAMPS = buildCamps();

/** The camp a player must fill to win (the opposite corner from their start). */
export function targetCamp(player: Player): Set<string> {
  return player === "red" ? CAMPS.bottomRight : CAMPS.topLeft;
}

const DIRECTIONS: ReadonlyArray<Square> = [
  { row: -1, col: -1 },
  { row: -1, col: 0 },
  { row: -1, col: 1 },
  { row: 0, col: -1 },
  { row: 0, col: 1 },
  { row: 1, col: -1 },
  { row: 1, col: 0 },
  { row: 1, col: 1 },
];

export function createBoard(): Board {
  const board: Board = Array.from({ length: SIZE }, () =>
    Array.from({ length: SIZE }, (): Cell => null),
  );
  for (const key of CAMPS.topLeft) {
    const [row, col] = key.split(",").map(Number);
    board[row][col] = "red";
  }
  for (const key of CAMPS.bottomRight) {
    const [row, col] = key.split(",").map(Number);
    board[row][col] = "blue";
  }
  return board;
}

export function createGame(options: {
  mode: Mode;
  difficulty?: Difficulty;
  humanPlayer?: Player;
}): GameState {
  return {
    board: createBoard(),
    currentPlayer: FIRST_PLAYER,
    jumpingFrom: null,
    jumpChain: [],
    mode: options.mode,
    difficulty: options.difficulty ?? "medium",
    humanPlayer: options.humanPlayer ?? "red",
    status: "playing",
    winner: null,
  };
}

function stepsFrom(board: Board, square: Square): Move[] {
  const moves: Move[] = [];
  for (const direction of DIRECTIONS) {
    const row = square.row + direction.row;
    const col = square.col + direction.col;
    if (inBounds(row, col) && board[row][col] === null) {
      moves.push({ kind: "step", from: square, to: { row, col } });
    }
  }
  return moves;
}

function jumpsFrom(board: Board, square: Square, visited: Square[] = []): Move[] {
  const seen = new Set(visited.map(keyOf));
  const moves: Move[] = [];
  for (const direction of DIRECTIONS) {
    const overRow = square.row + direction.row;
    const overCol = square.col + direction.col;
    const landRow = square.row + direction.row * 2;
    const landCol = square.col + direction.col * 2;
    if (!inBounds(landRow, landCol)) continue;
    if (board[overRow][overCol] === null) continue; // nothing to hop
    if (board[landRow][landCol] !== null) continue; // landing blocked
    if (seen.has(keyOf({ row: landRow, col: landCol }))) continue; // no revisiting
    moves.push({ kind: "jump", from: square, to: { row: landRow, col: landCol } });
  }
  return moves;
}

function ownSquares(board: Board, player: Player): Square[] {
  const squares: Square[] = [];
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      if (board[row][col] === player) squares.push({ row, col });
    }
  }
  return squares;
}

/** Every ten of a player's pieces sit in the opposite camp. */
export function hasWon(board: Board, player: Player): boolean {
  const target = targetCamp(player);
  for (const key of target) {
    const [row, col] = key.split(",").map(Number);
    if (board[row][col] !== player) return false;
  }
  return true;
}

/**
 * Legal moves for the side to move. Mid jump-chain (`jumpingFrom` set) the only
 * options are further jumps from that piece, plus ending the turn. Otherwise it
 * is every step and every starting jump across all of the player's pieces.
 */
export function legalMoves(state: GameState): Move[] {
  if (state.status !== "playing") return [];

  if (state.jumpingFrom) {
    return [
      ...jumpsFrom(state.board, state.jumpingFrom, state.jumpChain),
      { kind: "end" },
    ];
  }

  const squares = ownSquares(state.board, state.currentPlayer);
  return [
    ...squares.flatMap((square) => stepsFrom(state.board, square)),
    ...squares.flatMap((square) => jumpsFrom(state.board, square)),
  ];
}

const sameMove = (first: Move, second: Move): boolean => {
  if (first.kind !== second.kind) return false;
  if (first.kind === "end" || second.kind === "end") return first.kind === second.kind;
  return (
    first.from.row === (second as typeof first).from.row &&
    first.from.col === (second as typeof first).from.col &&
    first.to.row === (second as typeof first).to.row &&
    first.to.col === (second as typeof first).to.col
  );
};

export function isLegalMove(state: GameState, move: Move): boolean {
  return legalMoves(state).some((candidate) => sameMove(candidate, move));
}

/**
 * Apply one move. Returns a new state, never mutates. Throws on an illegal move.
 * A jump keeps the turn open (same player, `jumpingFrom` set); a step or an
 * explicit "end" hands over. A move that completes the target camp wins at once.
 */
export function applyMove(state: GameState, move: Move): GameState {
  if (state.status !== "playing") throw new Error("game is already over");
  if (!isLegalMove(state, move)) throw new Error("illegal move");

  const me = state.currentPlayer;

  if (move.kind === "end") {
    return { ...state, jumpingFrom: null, jumpChain: [], currentPlayer: otherPlayer(me) };
  }

  const board = state.board.map((cells) => cells.slice());
  board[move.from.row][move.from.col] = null;
  board[move.to.row][move.to.col] = me;

  if (hasWon(board, me)) {
    return { ...state, board, jumpingFrom: null, jumpChain: [], status: "won", winner: me };
  }
  if (move.kind === "step") {
    return { ...state, board, jumpingFrom: null, jumpChain: [], currentPlayer: otherPlayer(me) };
  }
  // Jump: same player keeps the turn and may jump again or end. Record the path
  // so a later hop can't land back on a square already used this turn.
  const chain = state.jumpChain.length > 0 ? state.jumpChain : [move.from];
  return { ...state, board, jumpingFrom: move.to, jumpChain: [...chain, move.to] };
}

// ---------------------------------------------------------------------------
// AI — shallow negamax over full turns against a distance-to-goal heuristic.
// Halma has a high branching factor and no "win in N" tactics, so material-style
// search doesn't apply; the eval measures how far a side's pieces still are from
// their target corner (and penalises a lagging straggler). getAiTurn returns the
// WHOLE chosen turn (a step, or a jump chain ending in "end"), so the UI can
// replay it without re-searching between hops.
// ---------------------------------------------------------------------------
interface LevelConfig {
  depth: number;
  blunderRate: number;
}
const LEVELS: Record<Difficulty, LevelConfig> = {
  easy: { depth: 1, blunderRate: 0.35 },
  medium: { depth: 1, blunderRate: 0.08 },
  hard: { depth: 2, blunderRate: 0 },
  expert: { depth: 3, blunderRate: 0 },
};

const WIN_SCORE = 100000;
// Halma's raw branching factor (~60 turns) makes an unpruned depth-3 search cost
// seconds. Since almost every good move advances toward the goal, we search only
// the BEAM most promising turns at each node (ranked by immediate evaluation) —
// a practical beam search that keeps expert responsive without visibly weakening
// its play.
const BEAM = 16;

function chebyshev(square: Square, goal: Square): number {
  return Math.max(Math.abs(square.row - goal.row), Math.abs(square.col - goal.col));
}

// Filling a target-camp cell is worth far more than any single step of distance,
// so the AI always prefers to complete the camp over shuffling toward the corner.
const CAMP_FILL_BONUS = 40;

/**
 * How close `player` is to winning. Each of its pieces already sitting on a
 * target-camp cell is worth a big flat bonus; every other piece contributes the
 * negative distance to the NEAREST still-unfilled camp cell. Measuring against
 * the unfilled cells (not the single deep corner) is what makes the AI march
 * pieces into the camp's far tips and actually complete it — the old
 * distance-to-corner heuristic rated a tip piece worse than a corner one, so the
 * AI crowded the corner and shuffled forever.
 */
function progress(board: Board, player: Player): number {
  const camp = targetCamp(player);
  const unfilled: Square[] = [];
  for (const cell of camp) {
    const [row, col] = cell.split(",").map(Number);
    if (board[row][col] !== player) unfilled.push({ row, col });
  }

  let filled = 0;
  let distance = 0;
  for (const square of ownSquares(board, player)) {
    if (camp.has(`${square.row},${square.col}`)) {
      filled += 1;
      continue;
    }
    let nearest = SIZE * 2;
    for (const target of unfilled) {
      const step = chebyshev(square, target);
      if (step < nearest) nearest = step;
    }
    distance += nearest;
  }
  return filled * CAMP_FILL_BONUS - distance;
}

export function evaluate(board: Board, player: Player): number {
  return progress(board, player) - progress(board, otherPlayer(player));
}

/** Complete turns reachable from `state`, each with the ordered moves that make
 *  it (so the caller can both score the outcome and replay the path). */
function resolvedTurns(state: GameState): { state: GameState; path: Move[] }[] {
  const results: { state: GameState; path: Move[] }[] = [];
  const walk = (current: GameState, path: Move[]): void => {
    for (const move of legalMoves(current)) {
      const next = applyMove(current, move);
      const stillSameTurn =
        next.status === "playing" && next.currentPlayer === current.currentPlayer;
      if (stillSameTurn) walk(next, [...path, move]);
      else results.push({ state: next, path: [...path, move] });
    }
  };
  walk(state, []);
  return results;
}

/** The BEAM most promising turns for the side to move, ranked by the immediate
 *  evaluation of each outcome (best first). Also orders moves for alpha-beta. */
function candidateTurns(state: GameState): { state: GameState; path: Move[] }[] {
  const mover = state.currentPlayer;
  return resolvedTurns(state)
    .map((turn) => ({
      turn,
      score:
        turn.state.status !== "playing"
          ? (turn.state.winner === mover ? Infinity : -Infinity)
          : evaluate(turn.state.board, mover),
    }))
    .sort((first, second) => second.score - first.score)
    .slice(0, BEAM)
    .map((entry) => entry.turn);
}

function negamax(state: GameState, depth: number, alpha: number, beta: number): number {
  if (state.status !== "playing") return -(WIN_SCORE + depth);
  if (depth === 0) return evaluate(state.board, state.currentPlayer);

  let best = -Infinity;
  for (const { state: turn } of candidateTurns(state)) {
    const value = -negamax(turn, depth - 1, -beta, -alpha);
    if (value > best) best = value;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // prune
  }
  return best;
}

/**
 * Choose a full turn for the side to move and return its ordered moves. On
 * "easy" it sometimes plays a random legal turn instead of searching.
 */
export function getAiTurn(state: GameState, random: RandomFn = Math.random): Move[] {
  const all = resolvedTurns(state);
  if (all.length === 0) throw new Error("no legal turn — check status first");

  const { depth, blunderRate } = LEVELS[state.difficulty];
  if (blunderRate > 0 && random() < blunderRate) {
    return all[Math.floor(random() * all.length)].path;
  }

  const scored = candidateTurns(state).map((turn) => {
    if (turn.state.status !== "playing") {
      return { path: turn.path, score: turn.state.winner === state.currentPlayer ? WIN_SCORE * 2 : -WIN_SCORE };
    }
    return { path: turn.path, score: -negamax(turn.state, depth - 1, -Infinity, Infinity) };
  });
  const bestScore = Math.max(...scored.map((entry) => entry.score));
  const best = scored.filter((entry) => entry.score === bestScore);
  return best[Math.floor(random() * best.length)].path;
}
