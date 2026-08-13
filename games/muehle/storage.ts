// (De)serialisation for localStorage persistence. Pure string <-> object
// functions so they're testable without a DOM; ui.ts owns the localStorage keys
// and read/write calls. Every deserialize is defensive: anything it can't fully
// validate (corrupt JSON, an older schema, a shape that doesn't match) returns
// null, so the caller falls back to a fresh start.

import {
  POINTS,
  STONES_PER_PLAYER,
  onBoardCount,
  removableTargets,
  otherPlayer,
  type Board,
  type Difficulty,
  type GameState,
  type Mode,
  type Player,
  type Point,
} from "./game.js";

/** Bump when the persisted shape changes; old blobs then deserialize to null. */
export const SCHEMA_VERSION = 1;

export interface Settings {
  mode: Mode;
  difficulty: Difficulty;
  /** In AI mode, does the human take the (red) first placement? */
  humanFirst: boolean;
  /** Undo button available during the game? Chosen before it starts. */
  allowUndo: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "ai",
  difficulty: "medium",
  humanFirst: true,
  allowUndo: true,
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

function isPlayer(value: unknown): value is Player {
  return value === "red" || value === "blue";
}

function isPoint(value: unknown): value is Point {
  return value === null || isPlayer(value);
}

function isBoard(value: unknown): value is Board {
  return Array.isArray(value) && value.length === POINTS && value.every(isPoint);
}

function inRange(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= STONES_PER_PLAYER;
}

export function isSettings(value: unknown): value is Settings {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Settings;
  return (
    MODES.includes(settings.mode) &&
    DIFFICULTIES.includes(settings.difficulty) &&
    typeof settings.humanFirst === "boolean" &&
    typeof settings.allowUndo === "boolean"
  );
}

function isGameState(value: unknown): value is GameState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as GameState;

  if (!isBoard(state.board)) return false;
  if (typeof state.inHand !== "object" || state.inHand === null) return false;
  if (!inRange(state.inHand.red) || !inRange(state.inHand.blue)) return false;
  if (!isPlayer(state.currentPlayer)) return false;
  if (typeof state.pendingCapture !== "boolean") return false;
  if (!MODES.includes(state.mode)) return false;
  if (!DIFFICULTIES.includes(state.difficulty)) return false;
  if (!isPlayer(state.humanPlayer)) return false;
  // Only in-progress games are ever persisted (a finished one is cleared).
  if (state.status !== "playing") return false;
  if (state.winner !== null) return false;

  // Neither side may control more than its nine stones.
  for (const player of ["red", "blue"] as const) {
    if (onBoardCount(state.board, player) + state.inHand[player] > STONES_PER_PLAYER) return false;
  }
  // A paused capture must actually have something to capture.
  if (state.pendingCapture && removableTargets(state.board, otherPlayer(state.currentPlayer)).length === 0) {
    return false;
  }
  return true;
}

export function serializeSettings(settings: Settings): string {
  return JSON.stringify({ v: SCHEMA_VERSION, data: settings });
}

export function deserializeSettings(raw: string | null): Settings | null {
  const data = parseEnvelope(raw);
  // Blobs written before the no-undo option lack allowUndo — fill in that one
  // field (undo on) before validating, so the guard still proves every other.
  const filled =
    typeof data === "object" && data !== null && !("allowUndo" in data)
      ? { ...data, allowUndo: DEFAULT_SETTINGS.allowUndo }
      : data;
  return isSettings(filled) ? filled : null;
}

export function serializeGame(state: GameState): string {
  return JSON.stringify({ v: SCHEMA_VERSION, data: state });
}

export function deserializeGame(raw: string | null): GameState | null {
  const data = parseEnvelope(raw);
  return isGameState(data) ? data : null;
}
