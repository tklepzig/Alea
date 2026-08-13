// (De)serialisation for localStorage persistence. Pure string <-> object
// functions so they're testable without a DOM; ui.ts owns the localStorage keys
// and read/write calls. Every deserialize is defensive: anything it can't fully
// validate (corrupt JSON, an older schema, a shape that doesn't match) returns
// null, so the caller falls back to a fresh start.

import {
  COLUMNS,
  ROWS,
  type Board,
  type Cell,
  type Difficulty,
  type GameState,
  type Mode,
  type Player,
} from "./game.js";

/** Bump when the persisted shape changes; old blobs then deserialize to null. */
export const SCHEMA_VERSION = 1;

export interface Settings {
  mode: Mode;
  difficulty: Difficulty;
  /** In AI mode, does the human take the (red) first move? */
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
  return value === "red" || value === "yellow";
}

function isCell(value: unknown): value is Cell {
  return value === null || isPlayer(value);
}

/** A board is 7 columns × 6 rows of cells, with no disc floating above a gap
 *  (gravity must hold — a corrupt blob could otherwise resume an impossible
 *  position). */
function isBoard(value: unknown): value is Board {
  if (!Array.isArray(value) || value.length !== COLUMNS) return false;
  return value.every((column) => {
    if (!Array.isArray(column) || column.length !== ROWS) return false;
    if (!column.every(isCell)) return false;
    // Once an empty slot appears, everything above it must also be empty.
    let seenEmpty = false;
    for (const cell of column) {
      if (cell === null) seenEmpty = true;
      else if (seenEmpty) return false;
    }
    return true;
  });
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
  if (!isPlayer(state.currentPlayer)) return false;
  if (!MODES.includes(state.mode)) return false;
  if (!DIFFICULTIES.includes(state.difficulty)) return false;
  if (!isPlayer(state.humanPlayer)) return false;
  // Only in-progress games are ever persisted (a finished one is cleared), so a
  // restored game must be mid-play.
  if (state.status !== "playing") return false;
  if (state.winner !== null) return false;
  if (state.winningCells !== null) return false;

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
