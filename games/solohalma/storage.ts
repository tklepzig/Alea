// (De)serialisation for localStorage persistence. Pure string <-> object
// functions so they're testable without a DOM; ui.ts owns the localStorage key
// and read/write calls. Every deserialize is defensive: anything it can't fully
// validate (corrupt JSON, an older schema, a shape that doesn't match, or a board
// that isn't still in play) returns null, so the caller falls back to a fresh
// start. Solo-Halma has no players or settings, so only the board is persisted.

import { SIZE, isHole, statusOf, type Board, type Cell } from "./game.js";

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

function isCell(value: unknown): value is Cell {
  return value === null || value === "peg" || value === "empty";
}

/** A 7×7 grid whose corner cells are null and whose hole cells are peg/empty. */
function isBoard(value: unknown): value is Board {
  if (!Array.isArray(value) || value.length !== SIZE) return false;
  return value.every((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== SIZE) return false;
    return row.every((cell, colIndex) => {
      if (!isCell(cell)) return false;
      // Corners must be null; holes must be a peg or an empty hole.
      return isHole(rowIndex, colIndex) ? cell !== null : cell === null;
    });
  });
}

export function serializeGame(board: Board): string {
  return JSON.stringify({ v: SCHEMA_VERSION, data: board });
}

export function deserializeGame(raw: string | null): Board | null {
  const data = parseEnvelope(raw);
  if (!isBoard(data)) return null;
  // Only an in-progress puzzle is resumable (a solved/stuck one is cleared).
  return statusOf(data) === "playing" ? data : null;
}
