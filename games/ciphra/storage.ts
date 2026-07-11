// (De)serialisation for localStorage persistence. Pure string <-> object
// functions so they're testable without a DOM; ui.ts owns the localStorage
// keys and read/write calls. Every deserialize is defensive: anything it can't
// fully validate (corrupt JSON, an older schema, a shape that doesn't match the
// config) returns null so the caller falls back to a fresh start.

import {
  isConfigValid,
  type GameConfig,
  type GameState,
  type Guess,
} from "./game.js";

/** Bump when the persisted shape changes; old blobs then deserialize to null. */
export const SCHEMA_VERSION = 1;

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

function isColourArray(value: unknown, length: number, colours: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every(
      (peg) => Number.isInteger(peg) && peg >= 0 && peg < colours,
    )
  );
}

function isFeedback(value: unknown): value is Guess["feedback"] {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isInteger((value as Guess["feedback"]).exact) &&
    Number.isInteger((value as Guess["feedback"]).colour)
  );
}

function isGameState(value: unknown): value is GameState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as GameState;

  if (!state.config || !isConfigValid(state.config)) return false;
  const { codeLength, colours } = state.config;

  if (!isColourArray(state.secret, codeLength, colours)) return false;
  if (!["playing", "won", "lost"].includes(state.status)) return false;
  if (!Array.isArray(state.guesses)) return false;
  if (state.guesses.length > state.config.maxGuesses) return false;

  return state.guesses.every(
    (guess) =>
      isColourArray(guess?.pegs, codeLength, colours) && isFeedback(guess?.feedback),
  );
}

export function serializeConfig(config: GameConfig): string {
  return JSON.stringify({ v: SCHEMA_VERSION, data: config });
}

export function deserializeConfig(raw: string | null): GameConfig | null {
  const data = parseEnvelope(raw);
  if (data && isConfigValid(data as GameConfig)) return data as GameConfig;
  return null;
}

export function serializeGame(state: GameState): string {
  return JSON.stringify({ v: SCHEMA_VERSION, data: state });
}

export function deserializeGame(raw: string | null): GameState | null {
  const data = parseEnvelope(raw);
  return isGameState(data) ? data : null;
}
