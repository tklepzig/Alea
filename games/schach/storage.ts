// (De)serialisation for localStorage persistence. Pure string <-> object
// functions so they're testable without a DOM; ui.ts owns the localStorage keys
// and read/write calls. Every deserialize is defensive: anything it can't fully
// validate (corrupt JSON, an older schema, an impossible position) returns null,
// so the caller falls back to a fresh start. Chess has more invariants than its
// siblings — exactly one king per side, no pawn on a promotion rank, castling
// rights that match where king and rooks actually stand — and they're all
// checked here, because a half-trusted position corrupts the resume silently.

import {
  SIZE,
  FIFTY_MOVE_PLIES,
  homeRow,
  isInCheck,
  otherPlayer,
  type Board,
  type CastlingRights,
  type Cell,
  type Difficulty,
  type GameState,
  type Mode,
  type Piece,
  type PieceKind,
  type Player,
  type Square,
} from "./game.js";

/** Bump when the persisted shape changes; old blobs then deserialize to null. */
export const SCHEMA_VERSION = 1;

export interface Settings {
  mode: Mode;
  difficulty: Difficulty;
  /** In AI mode, does the human play White (and therefore move first)? */
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
const KINDS: readonly PieceKind[] = ["pawn", "knight", "bishop", "rook", "queen", "king"];

function isPlayer(value: unknown): value is Player {
  return value === "white" || value === "black";
}

function isCell(value: unknown): value is Cell {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const piece = value as Piece;
  return isPlayer(piece.player) && KINDS.includes(piece.kind);
}

/** 8×8 of valid cells, with no pawn parked on a rank it must have promoted on. */
function isBoard(value: unknown): value is Board {
  if (!Array.isArray(value) || value.length !== SIZE) return false;
  return value.every((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== SIZE) return false;
    return row.every((cell) => {
      if (!isCell(cell)) return false;
      const onLastRank = rowIndex === 0 || rowIndex === SIZE - 1;
      return !(cell?.kind === "pawn" && onLastRank);
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

function isRights(value: unknown): value is CastlingRights {
  if (typeof value !== "object" || value === null) return false;
  const rights = value as CastlingRights;
  return typeof rights.king === "boolean" && typeof rights.queen === "boolean";
}

const countKings = (board: Board, player: Player): number =>
  board
    .flat()
    .filter((cell) => cell?.player === player && cell.kind === "king").length;

/** A right is only credible if the king still sits on e-file home and the
 *  matching rook on its corner. */
function rightsMatchBoard(board: Board, player: Player, rights: CastlingRights): boolean {
  if (!rights.king && !rights.queen) return true;
  const row = homeRow(player);
  const king = board[row][4];
  if (king?.player !== player || king.kind !== "king") return false;
  const rookOn = (col: number): boolean => {
    const rook = board[row][col];
    return rook?.player === player && rook.kind === "rook";
  };
  if (rights.king && !rookOn(7)) return false;
  if (rights.queen && !rookOn(0)) return false;
  return true;
}

/** The target belongs to the side that just double-stepped — the opponent of
 *  the side to move — so it sits on rank 3 (row 5) after a White step and on
 *  rank 6 (row 2) after a Black one, with that pawn still standing behind it. */
function enPassantIsPlausible(board: Board, target: Square, currentPlayer: Player): boolean {
  const mover = otherPlayer(currentPlayer);
  const expectedRow = mover === "white" ? 5 : 2;
  if (target.row !== expectedRow) return false;
  if (board[target.row][target.col] !== null) return false;
  const pawnRow = mover === "white" ? 4 : 3;
  const pawn = board[pawnRow][target.col];
  return pawn?.player === mover && pawn.kind === "pawn";
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
  if (countKings(state.board, "white") !== 1) return false;
  if (countKings(state.board, "black") !== 1) return false;
  if (!isPlayer(state.currentPlayer)) return false;
  // The side that just moved can never be left in check — leavesKingInCheck
  // guarantees it for every real game. Without this the resumed AI happily
  // "captures" the king, leaving a board game.ts can no longer reason about.
  if (isInCheck(state.board, otherPlayer(state.currentPlayer))) return false;
  if (!MODES.includes(state.mode)) return false;
  if (!DIFFICULTIES.includes(state.difficulty)) return false;
  if (!isPlayer(state.humanPlayer)) return false;

  if (typeof state.castling !== "object" || state.castling === null) return false;
  if (!isRights(state.castling.white) || !isRights(state.castling.black)) return false;
  if (!rightsMatchBoard(state.board, "white", state.castling.white)) return false;
  if (!rightsMatchBoard(state.board, "black", state.castling.black)) return false;

  if (state.enPassant !== null) {
    if (!isSquare(state.enPassant)) return false;
    if (!enPassantIsPlausible(state.board, state.enPassant, state.currentPlayer)) return false;
  }

  if (!Number.isInteger(state.halfmoveClock)) return false;
  if (state.halfmoveClock < 0 || state.halfmoveClock >= FIFTY_MOVE_PLIES) return false;

  if (!Array.isArray(state.positionHistory)) return false;
  if (!state.positionHistory.every((key) => typeof key === "string")) return false;
  // History and clock reset together and grow together, so the relation is
  // exact — a loose upper bound would accept a doctored history that then
  // reports a repetition draw on the very next move.
  if (state.positionHistory.length !== state.halfmoveClock + 1) return false;

  // Only in-progress games are ever persisted (a finished one is cleared).
  if (state.status !== "playing") return false;
  if (state.winner !== null) return false;
  if (state.drawReason !== null) return false;

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
