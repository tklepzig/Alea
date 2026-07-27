// (De)serialisation for localStorage persistence. Pure string <-> object
// functions so they're testable without a DOM; ui.ts owns the localStorage keys
// and read/write calls. Every deserialize is defensive: anything it can't fully
// validate (corrupt JSON, an older schema, a shape that doesn't match) returns
// null, so the caller falls back to a fresh start.

import {
  SIZE,
  isPlayable,
  otherPlayer,
  type Board,
  type Cell,
  type Difficulty,
  type GameState,
  type Mode,
  type Piece,
  type PieceKind,
  type Player,
  type Square,
} from "./game.js";

/** Bump when the persisted shape changes; old blobs then deserialize to null.
 *  v2 added the rule variants (`flyingKings`, `maxCapture`, `pendingCaptures`). */
export const SCHEMA_VERSION = 2;

export interface Settings {
  mode: Mode;
  difficulty: Difficulty;
  /** In AI mode, does the human take the (red) first move? */
  humanFirst: boolean;
  /** Variant: the Dame moves and captures along the whole diagonal. */
  flyingKings: boolean;
  /** Variant: Mehrschlagzwang — only the longest capture sequences are legal. */
  maxCapture: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "ai",
  difficulty: "medium",
  humanFirst: true,
  flyingKings: false,
  maxCapture: false,
};

interface Envelope<T> {
  v: number;
  data: T;
}

function parseEnvelope(raw: string | null): unknown {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Envelope<unknown>>;
    if (!parsed || parsed.v !== SCHEMA_VERSION) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

const MODES: readonly Mode[] = ["local", "ai"];
const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard", "expert"];
const KINDS: readonly PieceKind[] = ["man", "king"];

function isPlayer(value: unknown): value is Player {
  return value === "red" || value === "black";
}

function isCell(value: unknown): value is Cell {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const piece = value as Piece;
  return isPlayer(piece.player) && KINDS.includes(piece.kind);
}

/** A board is 8×8, and any piece must sit on a dark (playable) square. */
function isBoard(value: unknown): value is Board {
  if (!Array.isArray(value) || value.length !== SIZE) return false;
  return value.every((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== SIZE) return false;
    return row.every((cell, colIndex) => {
      if (!isCell(cell)) return false;
      if (cell !== null && !isPlayable(rowIndex, colIndex)) return false;
      return true;
    });
  });
}

function isSquare(value: unknown): value is Square {
  if (typeof value !== "object" || value === null) return false;
  const square = value as Square;
  return (
    Number.isInteger(square.row) &&
    Number.isInteger(square.col) &&
    square.row >= 0 &&
    square.row < SIZE &&
    square.col >= 0 &&
    square.col < SIZE
  );
}

export function isSettings(value: unknown): value is Settings {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Settings;
  return (
    MODES.includes(settings.mode) &&
    DIFFICULTIES.includes(settings.difficulty) &&
    typeof settings.humanFirst === "boolean" &&
    typeof settings.flyingKings === "boolean" &&
    typeof settings.maxCapture === "boolean"
  );
}

function isGameState(value: unknown): value is GameState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as GameState;

  if (!isBoard(state.board)) return false;
  if (!isPlayer(state.currentPlayer)) return false;
  if (!MODES.includes(state.mode)) return false;
  if (!DIFFICULTIES.includes(state.difficulty)) return false;
  if (!isPlayer(state.humanPlayer)) return false;
  if (typeof state.flyingKings !== "boolean") return false;
  if (typeof state.maxCapture !== "boolean") return false;
  if (!Array.isArray(state.pendingCaptures)) return false;
  if (!state.pendingCaptures.every(isSquare)) return false;
  // Pieces jumped this turn are still on the board and belong to the opponent;
  // outside a multi-jump nothing can be pending.
  if (state.pendingCaptures.length > 0 && state.mustContinueFrom === null) return false;
  if (
    !state.pendingCaptures.every(
      (square) => state.board[square.row][square.col]?.player === otherPlayer(state.currentPlayer),
    )
  ) {
    return false;
  }
  if (state.mustContinueFrom !== null && !isSquare(state.mustContinueFrom)) return false;
  // Mid multi-jump the continuing piece must belong to the side to move.
  if (
    state.mustContinueFrom !== null &&
    state.board[state.mustContinueFrom.row][state.mustContinueFrom.col]?.player !==
      state.currentPlayer
  ) {
    return false;
  }
  // Only in-progress games are ever persisted (a finished one is cleared).
  if (state.status !== "playing") return false;
  if (state.winner !== null) return false;

  return true;
}

export function serializeSettings(settings: Settings): string {
  return JSON.stringify({ v: SCHEMA_VERSION, data: settings });
}

export function deserializeSettings(raw: string | null): Settings | null {
  const data = parseEnvelope(raw);
  return isSettings(data) ? data : null;
}

export function serializeGame(state: GameState): string {
  return JSON.stringify({ v: SCHEMA_VERSION, data: state });
}

export function deserializeGame(raw: string | null): GameState | null {
  const data = parseEnvelope(raw);
  return isGameState(data) ? data : null;
}
