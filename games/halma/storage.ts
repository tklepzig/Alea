// (De)serialisation for localStorage persistence. Pure string <-> object
// functions so they're testable without a DOM; ui.ts owns the localStorage keys
// and read/write calls. Every deserialize is defensive: anything it can't fully
// validate (corrupt JSON, an older schema, a shape that doesn't match) returns
// null, so the caller falls back to a fresh start. Only clean turn boundaries
// are ever persisted (never a state paused mid jump-chain).

import {
  SIZE,
  PIECES_PER_PLAYER,
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
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "ai",
  difficulty: "medium",
  humanFirst: true,
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

function isCell(value: unknown): value is Cell {
  return value === null || isPlayer(value);
}

function isBoard(value: unknown): value is Board {
  if (!Array.isArray(value) || value.length !== SIZE) return false;
  return value.every((row) => Array.isArray(row) && row.length === SIZE && row.every(isCell));
}

function count(board: Board, player: Player): number {
  return board.reduce(
    (total, row) => total + row.filter((cell) => cell === player).length,
    0,
  );
}

export function isSettings(value: unknown): value is Settings {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Settings;
  return (
    MODES.includes(settings.mode) &&
    DIFFICULTIES.includes(settings.difficulty) &&
    typeof settings.humanFirst === "boolean"
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
  // Only clean turn boundaries are persisted — never a paused jump-chain.
  if (state.jumpingFrom !== null) return false;
  if (!Array.isArray(state.jumpChain) || state.jumpChain.length !== 0) return false;
  // Only in-progress games are ever persisted (a finished one is cleared).
  if (state.status !== "playing") return false;
  if (state.winner !== null) return false;
  // Each side must have exactly its ten pieces.
  if (count(state.board, "red") !== PIECES_PER_PLAYER) return false;
  if (count(state.board, "blue") !== PIECES_PER_PLAYER) return false;

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
