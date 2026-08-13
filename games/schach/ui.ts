// Schach's DOM wiring and screen flow. All the rules live in game.ts (pure,
// tested); this file is the impure shell: rendering the 8×8 board, the
// select-then-move input, the promotion picker, the AI turn loop, and
// localStorage. Element ids are prefixed `x-` so the game coexists with its
// siblings in the hub's single document.

import { APP_ID } from "../../shell/app.js";
import { safeGet, safeRemove, safeSet } from "../../shell/safe-storage.js";
import { isUndoAllowed, setUndoAllowed } from "../../shell/undo-lock.js";
import type { GameController, GameHost } from "../../shell/game-controller.js";
import {
  SIZE,
  createGame,
  applyMove,
  getAiMove,
  isInCheck,
  legalMoves,
  otherPlayer,
  squareName,
  type GameState,
  type Mode,
  type Move,
  type Piece,
  type PieceKind,
  type Player,
  type PromotionKind,
  type Square,
} from "./game.js";
import {
  DEFAULT_SETTINGS,
  serializeGame,
  deserializeGame,
  serializeSettings,
  deserializeSettings,
  type Settings,
} from "./storage.js";

const GAME_KEY = `${APP_ID}.schach.game`;
const SETTINGS_KEY = `${APP_ID}.schach.settings`;
const UNDO_LOCK_KEY = `${APP_ID}.schach.undo-lock`;

// How long the AI "thinks" before its move — avoids an instant, jarring reply.
// It also has to outlast the slide it follows: the AI's move rebuilds the board,
// which would cut the human's piece off mid-flight.
const AI_DELAY_MS = 550;
const SLIDE_LEAD_MS = 150;
// A one-square step reads well at 0.55s, but a queen crossing seven files at the
// same duration looks teleported — so stretch the slide with the distance.
const SLIDE_BASE_MS = 550;
const SLIDE_PER_CELL_MS = 90;
const SLIDE_MAX_MS = 1100;
const slideMs = (cells: number): number =>
  Math.min(SLIDE_MAX_MS, SLIDE_BASE_MS + (cells - 1) * SLIDE_PER_CELL_MS);
// How long the final position stays visible before the end screen slides in.
const END_DELAY_MS = 1150;
// The ghost's swell-and-fade finishes just as the capturing piece lands on top
// of it — past that point the victim would only be a smudge behind the winner,
// and the hint line carries the information instead. Clearing it re-renders the
// board, so the state outlives the animation by a beat.
const CAPTURE_FADE_MS = 120;
// One board cell = 125% of a piece's own width (the piece is 80% of the cell), so
// translating a piece by this per column/row moves it exactly one cell.
const SLIDE_UNIT = 125;

function loadSettings(): Settings {
  return deserializeSettings(safeGet(SETTINGS_KEY)) ?? { ...DEFAULT_SETTINGS };
}
function saveSettings(next: Settings): void {
  safeSet(SETTINGS_KEY, serializeSettings(next));
}
function loadGame(): GameState | null {
  return deserializeGame(safeGet(GAME_KEY));
}
function saveGame(state: GameState): void {
  safeSet(GAME_KEY, serializeGame(state));
}
function clearGame(): void {
  safeRemove(GAME_KEY);
  // Release the lock with the game it belonged to. The in-memory flag stays as
  // it is on purpose: the finished board is still on screen, and its undo row
  // must not pop back in. startGame re-captures it for the next game.
  setUndoAllowed(UNDO_LOCK_KEY, true);
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let settings: Settings = loadSettings();
// Only an *in-progress* game is ever persisted, so a restored game is resumable.
let game: GameState | null = loadGame();
// The piece the human has picked up (its legal targets are highlighted).
let selected: Square | null = null;
// States at the start of each human move, for undo: one pop reverts that move
// plus the AI reply that followed. Not persisted.
let history: GameState[] = [];
// Does the *running* game offer undo? Captured from the setting when the game
// starts and persisted alongside it, so flipping the setting mid-game — or
// relaunching the app — can't hand the button back.
let undoAllowed = isUndoAllowed(UNDO_LOCK_KEY);
// True while the AI's move is pending — the board is locked against input.
let aiThinking = false;
let aiTimer: ReturnType<typeof setTimeout> | undefined;
let endTimer: ReturnType<typeof setTimeout> | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
// The destination the promotion dialog is currently asking about.
let pendingPromotion: { from: Square; to: Square } | null = null;

// Move feedback so the AI's action is easy to follow: the last move's origin and
// destination stay glowing until the next move, the moved piece slides in from
// its origin, and a captured piece leaves a fading ghost so you see what was
// taken. `moveAnims` carries the slide offsets (in % of a piece width) and is
// consumed after one render (Quadra's `lastDrop` trick), so it plays exactly
// once. It's a list because a castling move slides two pieces.
let lastMove: { from: Square; to: Square } | null = null;
// The last move in words, shown in the hint line until the next selection —
// the capture animation is over in under a second, this isn't.
let lastMoveText = "";
let moveAnims: { at: Square; sx: number; sy: number; ms: number }[] = [];
let slideDuration = SLIDE_BASE_MS;
// The captured piece is already gone from the state — draw a fading ghost of it.
// For en passant it doesn't even sit on the destination square.
let capturedGhost: { at: Square; piece: Piece } | null = null;

const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(`x-${id}`) as T;

const sameSquare = (first: Square | null, second: Square | null): boolean =>
  first !== null && second !== null && first.row === second.row && first.col === second.col;

const PIECE_NAMES: Record<PieceKind, string> = {
  pawn: "Bauer",
  knight: "Springer",
  bishop: "Läufer",
  rook: "Turm",
  queen: "Dame",
  king: "König",
};
const COLOUR_NAMES: Record<Player, string> = { white: "Weiß", black: "Schwarz" };

function setCapturedGhost(ghost: { at: Square; piece: Piece } | null): void {
  clearTimeout(flashTimer);
  capturedGhost = ghost;
  if (ghost) {
    flashTimer = setTimeout(
      () => {
        capturedGhost = null;
        renderGame();
      },
      slideDuration + CAPTURE_FADE_MS,
    );
  }
}

function clearHighlights(): void {
  lastMove = null;
  lastMoveText = "";
  moveAnims = [];
  setCapturedGhost(null);
}

function aiPlayer(state: GameState): Player {
  return otherPlayer(state.humanPlayer);
}

/** Playing Black against the KI, the board turns round — you look at your own
 *  pieces from behind, as at a real board. A local game keeps White at the
 *  bottom, since both players share the one screen. */
function isFlipped(state: GameState): boolean {
  return state.mode === "ai" && state.humanPlayer === "black";
}

function isAiTurn(state: GameState): boolean {
  return state.mode === "ai" && state.currentPlayer === aiPlayer(state);
}

function clearTimers(): void {
  clearTimeout(aiTimer);
  clearTimeout(endTimer);
  clearTimeout(flashTimer);
  aiTimer = undefined;
  endTimer = undefined;
  flashTimer = undefined;
  aiThinking = false;
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
type ScreenName = "home" | "setup" | "game" | "end";

function showScreen(name: ScreenName): void {
  for (const screen of ["home", "setup", "game", "end"] as const) {
    byId(`screen-${screen}`).hidden = screen !== name;
  }
}

// ---------------------------------------------------------------------------
// Board rendering — shared by the live board and the static end board.
// ---------------------------------------------------------------------------
function pieceElement(piece: Piece, extraClass = ""): HTMLElement {
  const span = document.createElement("span");
  span.className = `schach-piece ${piece.player}${extraClass ? ` ${extraClass}` : ""}`;
  span.innerHTML = `<svg aria-hidden="true"><use href="#pc-${piece.kind}" /></svg>`;
  return span;
}

function coordElement(kind: "file" | "rank", text: string): HTMLElement {
  const span = document.createElement("span");
  span.className = `coord ${kind}`;
  span.setAttribute("aria-hidden", "true");
  span.textContent = text;
  return span;
}

function cellLabel(square: Square, piece: Piece | null): string {
  const name = `Feld ${squareName(square)}`;
  if (!piece) return name;
  return `${name}, ${COLOUR_NAMES[piece.player]} ${PIECE_NAMES[piece.kind]}`;
}

function renderBoard(container: HTMLElement, state: GameState, interactive: boolean): void {
  container.replaceChildren();
  const locked = !interactive || aiThinking || state.status !== "playing" || isAiTurn(state);
  container.classList.toggle("locked", locked);

  const moves = interactive && !locked ? legalMoves(state) : [];
  const fromSelected = selected
    ? moves.filter((move) => sameSquare(move.from, selected))
    : [];
  const targets = new Set(fromSelected.map((move) => squareName(move.to)));
  // En passant lands on an empty square, so "is a piece standing there?" would
  // mark the one capture that doesn't look like one as a quiet move.
  const captureTargets = new Set(
    fromSelected.filter((move) => move.captured).map((move) => squareName(move.to)),
  );
  // With nothing picked up yet, hint which pieces can move at all.
  const movable = new Set(!selected ? moves.map((move) => squareName(move.from)) : []);
  // A king in check is ringed, so the player can't miss it.
  const checked =
    state.status === "playing" && isInCheck(state.board, state.currentPlayer)
      ? state.currentPlayer
      : null;

  const flipped = isFlipped(state);
  for (let rank = 0; rank < SIZE; rank++) {
    for (let file = 0; file < SIZE; file++) {
      // Board order vs. drawing order: flipping is a 180° turn of both axes.
      const row = flipped ? SIZE - 1 - rank : rank;
      const col = flipped ? SIZE - 1 - file : file;
      const square: Square = { row, col };
      const piece = state.board[row][col];
      const cell = document.createElement(interactive ? "button" : "div");
      cell.className = `sq ${(row + col) % 2 === 1 ? "dark" : "light"}`;

      if (interactive) {
        const button = cell as HTMLButtonElement;
        button.type = "button";
        button.disabled = locked;
        button.setAttribute("aria-label", cellLabel(square, piece));
        button.addEventListener("click", () => onCellClick(square));
      }

      if (sameSquare(selected, square)) cell.classList.add("selected");
      if (targets.has(squareName(square))) {
        cell.classList.add(captureTargets.has(squareName(square)) ? "capture-target" : "target");
      }
      if (movable.has(squareName(square))) cell.classList.add("movable");

      // Coordinates on the two outer edges of the board *as drawn*, so they
      // follow a flipped board. Hidden from screen readers — every square's
      // aria-label already names it.
      if (rank === SIZE - 1) cell.append(coordElement("file", squareName(square)[0]));
      if (file === 0) cell.append(coordElement("rank", squareName(square)[1]));

      if (interactive && lastMove) {
        if (sameSquare(lastMove.from, square)) cell.classList.add("last-from");
        if (sameSquare(lastMove.to, square)) cell.classList.add("last-to");
      }

      // The ghost goes in first, so the capturing piece glides in over it: in
      // chess the victim stands on the destination square, so the two share a
      // cell (the .sq grid stacks them — see .view-schach in style.scss).
      if (interactive && capturedGhost && sameSquare(capturedGhost.at, square)) {
        const ghost = pieceElement(capturedGhost.piece, "captured-ghost");
        ghost.style.setProperty("--ghost-ms", `${slideDuration}ms`);
        cell.append(ghost);
      }
      if (piece) {
        const inCheck = piece.kind === "king" && piece.player === checked;
        const element = pieceElement(piece, inCheck ? "checked" : "");
        const anim = interactive ? moveAnims.find((entry) => sameSquare(entry.at, square)) : undefined;
        if (anim) {
          element.classList.add("moving");
          element.style.setProperty("--slide-x", `${anim.sx}%`);
          element.style.setProperty("--slide-y", `${anim.sy}%`);
          element.style.setProperty("--slide-ms", `${anim.ms}ms`);
        }
        cell.append(element);
      }
      container.append(cell);
    }
  }
}

// ---------------------------------------------------------------------------
// Game screen
// ---------------------------------------------------------------------------
function turnText(state: GameState): string {
  if (state.mode === "local") return `${COLOUR_NAMES[state.currentPlayer]} ist dran`;
  return state.currentPlayer === state.humanPlayer ? "Du bist dran" : "KI denkt …";
}

/** Who just moved, from the pre-move state. */
function moverLabel(state: GameState): string {
  if (state.mode === "local") return COLOUR_NAMES[state.currentPlayer];
  return state.currentPlayer === state.humanPlayer ? "Du" : "KI";
}

/**
 * The move in words — "KI: Springer schlägt Läufer auf f6". The animation only
 * lasts a moment, so this is what still tells you *which* piece went after it's
 * over (and the only version a screen reader gets). Call before `applyMove`:
 * it reads the mover and the victim off the position they moved from.
 */
function describeMove(state: GameState, move: Move, victim: Piece | null): string {
  const mover = moverLabel(state);
  if (move.castle) return `${mover}: ${move.to.col === 6 ? "kurze" : "lange"} Rochade`;

  const piece = state.board[move.from.row][move.from.col]!;
  const target = squareName(move.to);
  if (move.promotion) {
    const promoted = PIECE_NAMES[move.promotion];
    if (victim) {
      return `${mover}: Bauer schlägt ${PIECE_NAMES[victim.kind]} auf ${target} und wird ${promoted}`;
    }
    return `${mover}: Bauer wird auf ${target} zur ${promoted}`;
  }
  if (victim) {
    // En passant takes a pawn that isn't standing on the destination square.
    const passing = sameSquare(move.captured, move.to) ? "" : " (en passant)";
    return `${mover}: ${PIECE_NAMES[piece.kind]} schlägt ${PIECE_NAMES[victim.kind]} auf ${target}${passing}`;
  }
  return `${mover}: ${PIECE_NAMES[piece.kind]} ${squareName(move.from)}–${target}`;
}

function annotText(state: GameState): string {
  // The board is locked and unfocusable meanwhile — the title says so visually,
  // but this is the only live region, so it has to say so too.
  if (aiThinking) return "KI denkt …";
  const inCheck = isInCheck(state.board, state.currentPlayer);
  if (selected) {
    if (inCheck) return "Schach! Wähle einen Zug, der ihn aufhebt.";
    return "Tippe ein markiertes Feld an — oder eine andere Figur.";
  }
  if (lastMoveText) return inCheck ? `${lastMoveText} — Schach!` : lastMoveText;
  if (inCheck) return "Schach! Der König muss aus der Bedrohung.";
  return "Wähle eine Figur und dann ihr Ziel.";
}

// Update only the title + hint. Used when the AI is scheduled so the "KI denkt"
// text can change without rebuilding the board — a rebuild would cut off an
// in-flight slide.
/** Writing the same string again still mutates the text node, which an
 *  aria-live region announces — and the ghost-clearing repaint would replay the
 *  whole move description a second time. */
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

function paintStatus(): void {
  if (!game) return;
  const title = byId("game-title");
  setText(title, turnText(game));
  title.className = `title turn ${game.currentPlayer}`;
  setText(byId("game-annot"), annotText(game));
  byId("board-actions").hidden = !undoAllowed;
  (byId("btn-undo") as HTMLButtonElement).disabled =
    history.length === 0 || game.status !== "playing";
}

function renderGame(): void {
  if (!game) return;
  paintStatus();
  renderBoard(byId("board"), game, true);
  moveAnims = []; // consume: the slide plays on exactly one render
}

// ---------------------------------------------------------------------------
// Turn loop
// ---------------------------------------------------------------------------
function onCellClick(square: Square): void {
  if (!game || game.status !== "playing" || aiThinking || pendingPromotion) return;
  if (isAiTurn(game)) return; // not the human's turn
  setCapturedGhost(null); // a tap means the flash has served its purpose

  const moves = legalMoves(game);
  const chosen = selected
    ? moves.filter((move) => sameSquare(move.from, selected) && sameSquare(move.to, square))
    : [];

  if (chosen.length > 0) {
    // Four moves share a promoting from/to — let the player pick the piece.
    if (chosen[0].promotion) askPromotion(chosen[0].from, square);
    else play(chosen[0]);
    return;
  }

  // Otherwise (re)select a piece that actually has a move.
  const owned = moves.some((move) => sameSquare(move.from, square));
  selected = owned ? square : null;
  renderGame();
}

function askPromotion(from: Square, to: Square): void {
  if (!game) return;
  pendingPromotion = { from, to };
  const dialog = byId<HTMLDialogElement>("promo");
  // Dress the four choices in the moving side's colour.
  for (const piece of dialog.querySelectorAll<HTMLElement>(".schach-piece")) {
    piece.classList.toggle("white", game.currentPlayer === "white");
    piece.classList.toggle("black", game.currentPlayer === "black");
  }
  dialog.showModal();
}

function finishPromotion(kind: PromotionKind): void {
  const target = pendingPromotion;
  pendingPromotion = null;
  byId<HTMLDialogElement>("promo").close();
  if (!game || !target) return;
  const move = legalMoves(game).find(
    (candidate) =>
      sameSquare(candidate.from, target.from) &&
      sameSquare(candidate.to, target.to) &&
      candidate.promotion === kind,
  );
  if (move) play(move);
}

/** Apply one move, then route what's next. */
function play(move: Move): void {
  if (!game) return;
  // Snapshot before a human move, so one undo reverts it and the AI's reply.
  const humanMover = game.mode === "local" || game.currentPlayer === game.humanPlayer;
  if (undoAllowed && humanMover) history.push(game);

  const captured = move.captured
    ? { at: move.captured, piece: game.board[move.captured.row][move.captured.col]! }
    : null;
  lastMoveText = describeMove(game, move, captured?.piece ?? null);
  game = applyMove(game, move);

  // Feedback: glow the path, slide the piece (and a castling rook) in from its
  // origin, ghost the piece that was taken.
  lastMove = { from: move.from, to: move.to };
  slideDuration = slideMs(
    Math.max(Math.abs(move.to.row - move.from.row), Math.abs(move.to.col - move.from.col)),
  );
  const direction = isFlipped(game) ? -1 : 1; // the slide follows the drawn board
  const slide = (from: Square, to: Square) => ({
    at: to,
    sx: (from.col - to.col) * SLIDE_UNIT * direction,
    sy: (from.row - to.row) * SLIDE_UNIT * direction,
    ms: slideDuration,
  });
  moveAnims = [slide(move.from, move.to)];
  if (move.castle) moveAnims.push(slide(move.castle.from, move.castle.to));
  setCapturedGhost(captured);

  selected = null;

  if (game.status !== "playing") {
    clearGame(); // finished — don't offer "Fortsetzen"
    renderGame(); // show the final position first
    endTimer = setTimeout(
      () => {
        renderEnd();
        showScreen("end");
      },
      // Never cut a long slide short.
      Math.max(END_DELAY_MS, slideDuration + 450),
    );
    return;
  }

  saveGame(game);
  renderGame();
  maybeScheduleAi();
}

/** Snapshots are only ever pushed *before a human move*, so an undo always
 *  lands back on the human's turn — including one pressed mid-think, which
 *  cancels the AI reply. Nothing to re-schedule, and the board never locks. */
function undo(): void {
  const previous = history.pop();
  if (!previous) return;
  clearTimers(); // also cancels a pending AI reply
  clearHighlights();
  game = previous;
  selected = null;
  saveGame(game);
  renderGame();
}

/** If it's the AI's turn, think and play. */
function maybeScheduleAi(): void {
  if (!game || game.status !== "playing" || !isAiTurn(game)) return;
  aiThinking = true;
  selected = null;
  // Only repaint the status text — the board is already rendered (and locked)
  // from the move that led here; a full rebuild would cut off its slide.
  paintStatus();
  const gap = Math.max(AI_DELAY_MS, slideDuration - SLIDE_LEAD_MS);
  aiTimer = setTimeout(() => {
    aiThinking = false;
    if (!game || game.status !== "playing" || !isAiTurn(game)) return;
    play(getAiMove(game));
  }, gap);
}

// ---------------------------------------------------------------------------
// End screen
// ---------------------------------------------------------------------------
const DRAW_TEXT: Record<string, string> = {
  stalemate: "Patt — der Spieler am Zug hat keinen Zug mehr, steht aber nicht im Schach.",
  fifty: "50 Züge ohne Bauernzug und ohne Schlagen — die Partie ist remis.",
  material: "Mit diesem Material kann keine Seite mehr mattsetzen.",
  repetition: "Dieselbe Stellung zum dritten Mal — die Partie ist remis.",
};

function endBarText(state: GameState, humanWon: boolean): string {
  if (state.mode !== "ai") return "Ergebnis";
  return humanWon ? "Gewonnen" : "Verloren";
}

function renderEnd(): void {
  if (!game || game.status === "playing") return;
  const glyph = byId("end-glyph");
  const title = byId("end-title");

  if (game.status === "draw") {
    byId("end-bar").textContent = "Remis";
    glyph.textContent = "=";
    glyph.className = "end-glyph draw";
    title.textContent = "REMIS";
    title.className = "end-title draw";
    byId("end-sub").textContent = DRAW_TEXT[game.drawReason ?? "stalemate"];
  } else {
    const winner = game.winner!;
    const humanWon = game.mode === "ai" && winner === game.humanPlayer;
    byId("end-bar").textContent = endBarText(game, humanWon);
    glyph.textContent = "★";
    glyph.className = `end-glyph ${winner}`;
    if (game.mode === "ai") {
      title.textContent = humanWon ? "DU GEWINNST" : "KI GEWINNT";
      title.className = `end-title ${humanWon ? "win" : "lose"}`;
    } else {
      title.textContent = `${COLOUR_NAMES[winner].toUpperCase()} GEWINNT`;
      title.className = `end-title ${winner}`;
    }
    byId("end-sub").textContent = humanWon
      ? "Schachmatt — stark gespielt!"
      : `Schachmatt: ${COLOUR_NAMES[winner]} setzt den König matt.`;
  }

  renderBoard(byId("end-board"), game, false);
}

// ---------------------------------------------------------------------------
// Setup screen — the KI-only panels are hidden in local mode.
// ---------------------------------------------------------------------------
let setupMode: Mode = "ai";

function markSegment(groupId: string, value: string): void {
  for (const button of byId(groupId).querySelectorAll<HTMLButtonElement>(".seg")) {
    button.classList.toggle("active", button.dataset.value === value);
    button.setAttribute("aria-pressed", String(button.dataset.value === value));
  }
}

function renderSetup(): void {
  const local = setupMode === "local";
  byId("setup-title").textContent = local ? "Lokal (2 Spieler)" : "Gegen KI";
  byId("panel-difficulty").hidden = local;
  byId("panel-first").hidden = local;
  markSegment("seg-difficulty", settings.difficulty);
  markSegment("seg-first", settings.humanFirst ? "human" : "ai");
  markSegment("seg-undo", settings.allowUndo ? "on" : "off");
}

// ---------------------------------------------------------------------------
// Home screen
// ---------------------------------------------------------------------------
function renderHome(): void {
  (byId("btn-continue") as HTMLButtonElement).hidden =
    game === null || game.status !== "playing";
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function startGame(mode: Mode, difficulty = settings.difficulty, humanFirst = true): void {
  clearTimers();
  clearHighlights();
  // White always opens; the human takes White when they choose to go first.
  game = createGame({ mode, difficulty, humanPlayer: humanFirst ? "white" : "black" });
  selected = null;
  history = [];
  // The only place the choice is captured — every new game (incl. restart and
  // rematch) comes through here, and nothing else writes the lock.
  undoAllowed = settings.allowUndo;
  setUndoAllowed(UNDO_LOCK_KEY, undoAllowed);
  saveGame(game);
  showScreen("game");
  renderGame();
  maybeScheduleAi(); // AI opens if the human chose to play Black
}

function resumeGame(): void {
  if (!game) return;
  clearTimers();
  clearHighlights();
  history = [];
  selected = null;
  showScreen("game");
  renderGame();
  maybeScheduleAi(); // re-trigger the AI if it was its turn when we left
}

/** Everything that must not outlive the game screen. The promotion dialog
 *  above all: `showModal()` puts it in the top layer, where it keeps swallowing
 *  every click through its backdrop even once its view is hidden — leaving the
 *  route mid-promotion would otherwise make the whole hub unclickable. */
function resetTransient(): void {
  clearTimers();
  clearHighlights();
  selected = null;
  pendingPromotion = null;
  byId<HTMLDialogElement>("promo").close();
}

function goHome(): void {
  resetTransient();
  renderHome();
  showScreen("home");
}

function openSetup(mode: Mode): void {
  setupMode = mode;
  renderSetup();
  showScreen("setup");
}

function restart(): void {
  if (!game) return;
  startGame(game.mode, game.difficulty, game.humanPlayer === "white");
}

// ---------------------------------------------------------------------------
// Wiring + hub contract — called once at boot by the hub.
// ---------------------------------------------------------------------------
export function initSchach(host: GameHost): GameController {
  const howto = byId<HTMLDialogElement>("howto");
  const promo = byId<HTMLDialogElement>("promo");

  byId("home-hub").addEventListener("click", host.onExit);
  byId("btn-ai").addEventListener("click", () => openSetup("ai"));
  byId("btn-local").addEventListener("click", () => openSetup("local"));
  byId("btn-continue").addEventListener("click", resumeGame);
  byId("btn-howto").addEventListener("click", () => howto.showModal());

  byId("setup-back").addEventListener("click", goHome);
  byId("btn-start").addEventListener("click", () =>
    // In local mode "who plays White" doesn't apply — the players share a board.
    startGame(setupMode, settings.difficulty, setupMode === "local" || settings.humanFirst),
  );

  byId("seg-difficulty").addEventListener("click", (event) => {
    const value = (event.target as HTMLElement).closest<HTMLButtonElement>(".seg")?.dataset.value;
    const difficulties = ["easy", "medium", "hard", "expert"] as const;
    if (!difficulties.includes(value as (typeof difficulties)[number])) return;
    settings = { ...settings, difficulty: value as Settings["difficulty"] };
    saveSettings(settings);
    renderSetup();
  });

  byId("seg-first").addEventListener("click", (event) => {
    const value = (event.target as HTMLElement).closest<HTMLButtonElement>(".seg")?.dataset.value;
    if (value !== "human" && value !== "ai") return;
    settings = { ...settings, humanFirst: value === "human" };
    saveSettings(settings);
    renderSetup();
  });

  byId("seg-undo").addEventListener("click", (event) => {
    const value = (event.target as HTMLElement).closest<HTMLButtonElement>(".seg")?.dataset.value;
    if (value !== "on" && value !== "off") return;
    settings = { ...settings, allowUndo: value === "on" };
    saveSettings(settings);
    renderSetup();
  });

  byId("game-back").addEventListener("click", goHome);
  byId("btn-undo").addEventListener("click", undo);
  byId("game-restart").addEventListener("click", restart);

  byId("end-back").addEventListener("click", goHome);
  byId("btn-home").addEventListener("click", goHome);
  byId("btn-again").addEventListener("click", restart);

  byId("promo-choices").addEventListener("click", (event) => {
    const value = (event.target as HTMLElement).closest<HTMLButtonElement>(".promo-choice")
      ?.dataset.value;
    const kinds = ["queen", "rook", "bishop", "knight"] as const;
    if (!kinds.includes(value as (typeof kinds)[number])) return;
    finishPromotion(value as PromotionKind);
  });
  // The picker isn't dismissable: a move is half-played until a piece is
  // chosen, so Escape re-opens it rather than leaving the board inconsistent.
  promo.addEventListener("cancel", (event) => {
    event.preventDefault();
  });

  byId("howto-close").addEventListener("click", () => howto.close());
  howto.addEventListener("click", (event) => {
    if (event.target === howto) howto.close();
  });

  return {
    activate: goHome,
    deactivate: resetTransient,
    hasRunningGame: () => game !== null && game.status === "playing",
  };
}
