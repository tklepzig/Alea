// Pure game logic for Mühle (Nine Men's Morris) — no DOM, no storage. The 24
// points are three concentric 8-point rings; a point's index is ring*8 + p
// where p runs 0..7 clockwise from the top-left corner (0=TL, 1=top-mid, 2=TR,
// 3=right-mid, 4=BR, 5=bottom-mid, 6=BL, 7=left-mid). Adjacency is each ring's
// 8-cycle plus a spoke joining the three edge-midpoints in each direction.
// Everything here is deterministic given an injected RNG, so it's fully
// unit-testable.
//
// Rules: each side has 9 stones. Phase 1 places them alternately; phase 2 slides
// a stone to an adjacent empty point; once a side is down to 3 stones it may
// "fly" to any empty point. Completing a mill (three in a line) removes one
// enemy stone — one not itself in a mill, unless all of them are. A side that is
// reduced to 2 stones, or that cannot move, loses.

import {
  iterativeBest,
  pickBest,
  type IterativeOptions,
  type Scored,
} from "../../shell/iterative-search.js";

export type Player = "red" | "blue";
export type Point = Player | null;
/** 24 points, index = ring*8 + position. */
export type Board = Point[];
export type Phase = "placing" | "moving" | "flying";
export type Difficulty = "easy" | "medium" | "hard" | "expert";
export type Mode = "local" | "ai";
export type GameStatus = "playing" | "won";

export type Move =
  | { kind: "place"; to: number }
  | { kind: "move"; from: number; to: number }
  | { kind: "remove"; at: number };

export interface GameState {
  board: Board;
  /** Stones still to be placed, per player (9 → 0 during phase 1). */
  inHand: Record<Player, number>;
  currentPlayer: Player;
  /** The side to move just formed a mill and owes one enemy removal. */
  pendingCapture: boolean;
  mode: Mode;
  difficulty: Difficulty;
  humanPlayer: Player;
  status: GameStatus;
  winner: Player | null;
}

export const POINTS = 24;
export const STONES_PER_PLAYER = 9;
export const FIRST_PLAYER: Player = "red";

export type RandomFn = () => number;

export function otherPlayer(player: Player): Player {
  return player === "red" ? "blue" : "red";
}

// --- Board graph, built once ------------------------------------------------
function buildAdjacency(): number[][] {
  const adjacency: number[][] = Array.from({ length: POINTS }, () => []);
  const link = (first: number, second: number): void => {
    adjacency[first].push(second);
    adjacency[second].push(first);
  };
  for (let ring = 0; ring < 3; ring++) {
    for (let position = 0; position < 8; position++) {
      link(ring * 8 + position, ring * 8 + ((position + 1) % 8));
    }
  }
  for (const position of [1, 3, 5, 7]) {
    link(position, 8 + position);
    link(8 + position, 16 + position);
  }
  return adjacency;
}

function buildMills(): number[][] {
  const mills: number[][] = [];
  for (let ring = 0; ring < 3; ring++) {
    for (const start of [0, 2, 4, 6]) {
      mills.push([ring * 8 + start, ring * 8 + ((start + 1) % 8), ring * 8 + ((start + 2) % 8)]);
    }
  }
  for (const position of [1, 3, 5, 7]) {
    mills.push([position, 8 + position, 16 + position]);
  }
  return mills;
}

export const ADJACENCY: readonly number[][] = buildAdjacency();
export const MILLS: readonly number[][] = buildMills();

export function createBoard(): Board {
  return Array.from({ length: POINTS }, (): Point => null);
}

export function createGame(options: {
  mode: Mode;
  difficulty?: Difficulty;
  humanPlayer?: Player;
}): GameState {
  return {
    board: createBoard(),
    inHand: { red: STONES_PER_PLAYER, blue: STONES_PER_PLAYER },
    currentPlayer: FIRST_PLAYER,
    pendingCapture: false,
    mode: options.mode,
    difficulty: options.difficulty ?? "medium",
    humanPlayer: options.humanPlayer ?? "red",
    status: "playing",
    winner: null,
  };
}

export function onBoardCount(board: Board, player: Player): number {
  return board.reduce((count, point) => count + (point === player ? 1 : 0), 0);
}

/** Total stones a player still controls: on the board plus still in hand. */
function pieceTotal(state: GameState, player: Player): number {
  return onBoardCount(state.board, player) + state.inHand[player];
}

export function phaseOf(state: GameState, player: Player): Phase {
  if (state.inHand[player] > 0) return "placing";
  return onBoardCount(state.board, player) === 3 ? "flying" : "moving";
}

/** Does a stone of `player` at `at` complete a mill on the given board? */
export function formsMill(board: Board, at: number, player: Player): boolean {
  return MILLS.some(
    (line) => line.includes(at) && line.every((index) => board[index] === player),
  );
}

function isInMill(board: Board, at: number, player: Player): boolean {
  return MILLS.some(
    (line) => line.includes(at) && line.every((index) => board[index] === player),
  );
}

/** Enemy stones that may be captured: those outside a mill, unless every enemy
 *  stone is in a mill (then any of them may be taken). */
export function removableTargets(board: Board, opponent: Player): number[] {
  const owned: number[] = [];
  for (let index = 0; index < POINTS; index++) {
    if (board[index] === opponent) owned.push(index);
  }
  const free = owned.filter((index) => !isInMill(board, index, opponent));
  return free.length > 0 ? free : owned;
}

function emptyPoints(board: Board): number[] {
  const empties: number[] = [];
  for (let index = 0; index < POINTS; index++) {
    if (board[index] === null) empties.push(index);
  }
  return empties;
}

export function legalMoves(state: GameState): Move[] {
  if (state.status !== "playing") return [];
  const me = state.currentPlayer;

  if (state.pendingCapture) {
    return removableTargets(state.board, otherPlayer(me)).map((at) => ({ kind: "remove", at }));
  }

  if (state.inHand[me] > 0) {
    return emptyPoints(state.board).map((to) => ({ kind: "place", to }));
  }

  const flying = onBoardCount(state.board, me) === 3;
  const moves: Move[] = [];
  for (let from = 0; from < POINTS; from++) {
    if (state.board[from] !== me) continue;
    const dests = flying
      ? emptyPoints(state.board)
      : ADJACENCY[from].filter((index) => state.board[index] === null);
    for (const to of dests) moves.push({ kind: "move", from, to });
  }
  return moves;
}

const sameMove = (first: Move, second: Move): boolean => {
  if (first.kind !== second.kind) return false;
  if (first.kind === "place" && second.kind === "place") return first.to === second.to;
  if (first.kind === "move" && second.kind === "move")
    return first.from === second.from && first.to === second.to;
  if (first.kind === "remove" && second.kind === "remove") return first.at === second.at;
  return false;
};

export function isLegalMove(state: GameState, move: Move): boolean {
  return legalMoves(state).some((candidate) => sameMove(candidate, move));
}

/** Switch to the opponent and settle the game status: a side with no more stones
 *  to place and fewer than 3 on the board has lost, as has a side with no move. */
function finishTurn(state: GameState, board: Board, inHand: Record<Player, number>): GameState {
  const next = otherPlayer(state.currentPlayer);
  const base: GameState = {
    ...state,
    board,
    inHand,
    currentPlayer: next,
    pendingCapture: false,
    status: "playing",
    winner: null,
  };
  const nextTotal = onBoardCount(board, next) + inHand[next];
  const boardedOut = inHand[next] === 0 && onBoardCount(board, next) < 3;
  if (nextTotal < 3 || boardedOut || legalMoves(base).length === 0) {
    return { ...base, status: "won", winner: state.currentPlayer };
  }
  return base;
}

/**
 * Apply one action. Returns a new state, never mutates. Throws on an illegal
 * move. A placement or slide that completes a mill keeps the turn open (same
 * player, `pendingCapture` set) so the UI can take the enemy stone next.
 */
export function applyMove(state: GameState, move: Move): GameState {
  if (state.status !== "playing") throw new Error("game is already over");
  if (!isLegalMove(state, move)) throw new Error("illegal move");

  const me = state.currentPlayer;
  const board = state.board.slice();
  const inHand = { ...state.inHand };

  if (move.kind === "remove") {
    board[move.at] = null;
    return finishTurn(state, board, inHand);
  }

  let landedAt: number;
  if (move.kind === "place") {
    board[move.to] = me;
    inHand[me] -= 1;
    landedAt = move.to;
  } else {
    board[move.from] = null;
    board[move.to] = me;
    landedAt = move.to;
  }

  const millFormed = formsMill(board, landedAt, me);
  const opponentHasStones = onBoardCount(board, otherPlayer(me)) > 0;
  if (millFormed && opponentHasStones) {
    return { ...state, board, inHand, pendingCapture: true };
  }
  return finishTurn(state, board, inHand);
}

// ---------------------------------------------------------------------------
// AI — depth-limited negamax with alpha-beta over full turns. A "turn" that
// forms a mill continues (same player) through the removal before the opponent
// replies, so the search values the capture, not half of it. Knobs mirror the
// other games: depth of look-ahead, plus a blunder rate that (on easy only)
// occasionally skips the search for a random legal move.
// ---------------------------------------------------------------------------
interface LevelConfig {
  depth: number;
  blunderRate: number;
}
const LEVELS: Record<Difficulty, LevelConfig> = {
  easy: { depth: 1, blunderRate: 0.35 },
  medium: { depth: 2, blunderRate: 0.08 },
  hard: { depth: 4, blunderRate: 0 },
  expert: { depth: 5, blunderRate: 0 },
};

const WIN_SCORE = 100000;

function completeMills(board: Board, player: Player): number {
  return MILLS.filter((line) => line.every((index) => board[index] === player)).length;
}

function mobility(state: GameState, player: Player): number {
  if (state.currentPlayer === player && !state.pendingCapture) return legalMoves(state).length;
  return legalMoves({ ...state, currentPlayer: player, pendingCapture: false }).length;
}

/** Static evaluation from `player`'s perspective. Material dominates (a stone is
 *  worth far more than position), then completed mills and mobility. */
export function evaluate(state: GameState, player: Player): number {
  const opponent = otherPlayer(player);
  const material = pieceTotal(state, player) - pieceTotal(state, opponent);
  const mills = completeMills(state.board, player) - completeMills(state.board, opponent);
  const mobilityEdge = mobility(state, player) - mobility(state, opponent);
  return material * 14 + mills * 4 + mobilityEdge;
}

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

function negamax(state: GameState, depth: number, alpha: number, beta: number): number {
  if (state.status !== "playing") return -(WIN_SCORE + depth);
  if (depth === 0) return evaluate(state, state.currentPlayer);

  let best = -Infinity;
  for (const turn of resolvedTurns(state)) {
    const value = -negamax(turn, depth - 1, -beta, -alpha);
    if (value > best) best = value;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // prune
  }
  return best;
}

function scoreFirstStep(state: GameState, firstStep: Move, depth: number): number {
  const next = applyMove(state, firstStep);
  if (next.status !== "playing") {
    return next.winner === state.currentPlayer ? WIN_SCORE * 2 : -WIN_SCORE * 2;
  }
  if (next.currentPlayer === state.currentPlayer) {
    // Mill formed — still our turn (the removal). Keep the best onward line.
    return Math.max(...legalMoves(next).map((step) => scoreFirstStep(next, step, depth)));
  }
  return -negamax(next, depth - 1, -Infinity, Infinity);
}

/**
 * Pick one action for the side to move (a place, a slide, or — when a mill was
 * just formed — a removal). Returns a single step; a mill's removal comes on the
 * next call, since `pendingCapture` narrows the legal set to removals. On "easy"
 * it sometimes plays a random legal step instead of searching.
 */
export function getAiMove(state: GameState, random: RandomFn = Math.random): Move {
  const { moves, shortcut } = openingChoice(state, random);
  if (shortcut) return shortcut;
  return bestMoveAtDepth(state, moves, LEVELS[state.difficulty].depth, random).move;
}

/** Best of `moves` searched to exactly `depth`; `random` breaks ties, consumed
 *  exactly once, as the fixed-depth root always did. */
function bestMoveAtDepth(
  state: GameState,
  moves: Move[],
  depth: number,
  random: RandomFn,
): Scored<Move> {
  return pickBest(
    moves.map((move) => ({ move, score: scoreFirstStep(state, move, depth) })),
    random,
  );
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
