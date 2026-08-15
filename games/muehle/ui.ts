// Mühle's DOM wiring and screen flow. The rules live in game.ts (pure, tested);
// this file renders the 24-point board (an SVG line layer plus absolutely
// positioned point buttons), handles the phase-aware input (place → move/fly →
// take-a-stone), runs the AI turn loop, and persists to localStorage. Element
// ids are prefixed `m-`.

import { APP_ID } from "../../shell/app.js";
import { safeGet, safeRemove, safeSet } from "../../shell/safe-storage.js";
import { isUndoAllowed, setUndoAllowed } from "../../shell/undo-lock.js";
import type { GameController, GameHost } from "../../shell/game-controller.js";
import {
  POINTS,
  createGame,
  applyMove,
  legalMoves,
  onBoardCount,
  phaseOf,
  otherPlayer,
  type GameState,
  type Mode,
  type Move,
  type Player,
} from "./game.js";
import {
  AiCancelledError,
  AiUnavailableError,
  cancelAiMoves,
  requestAiMove,
} from "../../shell/ai-client.js";
import {
  DEFAULT_SETTINGS,
  serializeGame,
  deserializeGame,
  serializeSettings,
  deserializeSettings,
  type Settings,
} from "./storage.js";

const GAME_KEY = `${APP_ID}.muehle.game`;
const SETTINGS_KEY = `${APP_ID}.muehle.settings`;
const UNDO_LOCK_KEY = `${APP_ID}.muehle.undo-lock`;

const AI_DELAY_MS = 550;
// Gap before the mill's capture step, so the placing/sliding animation (~0.7s,
// see `.moving` in style.scss) finishes before the board redraws to take a stone.
const CONTINUE_MS = 800;
const END_DELAY_MS = 1150;

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
// Point geometry — three rings, each with 8 points (percent coordinates on the
// square board). Index = ring*8 + position (0=TL … 7=LM, clockwise).
//
// The 24 points sit on a 7×7 lattice: the rings occupy columns/rows 0|6, 1|5 and
// 2|4, with the spokes on 3. Every point therefore owns one lattice cell, and no
// two points are closer than one cell apart — which is what lets the hit areas
// be a full cell wide without ever overlapping (the old geometry put the inner
// ring 6% apart while its hit boxes were 12% wide, so half of each inner point
// was covered by its neighbour and swallowed the tap).
// ---------------------------------------------------------------------------
// A small inset all round keeps the outer ring's corner stones off the board's
// rounded border; the lattice divides what's left.
const LATTICE_INSET_PCT = 1.5;
const CELL_PCT = (100 - 2 * LATTICE_INSET_PCT) / 7;
const cellCenter = (index: number): number => LATTICE_INSET_PCT + (index + 0.5) * CELL_PCT;
// How much of its cell a stone covers — the rest is the air between neighbours.
// Keep in sync with the .mp .muehle-stone width in style.scss.
const STONE_OF_CELL = 0.5;
const RING_EXTENT = [0, 1, 2].map((ring) => ({
  lo: cellCenter(ring),
  hi: cellCenter(6 - ring),
}));
const MID = 50;

function buildPositions(): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = [];
  for (const { lo, hi } of RING_EXTENT) {
    positions.push(
      { x: lo, y: lo }, // 0 TL
      { x: MID, y: lo }, // 1 TM
      { x: hi, y: lo }, // 2 TR
      { x: hi, y: MID }, // 3 RM
      { x: hi, y: hi }, // 4 BR
      { x: MID, y: hi }, // 5 BM
      { x: lo, y: hi }, // 6 BL
      { x: lo, y: MID }, // 7 LM
    );
  }
  return positions;
}
const POS = buildPositions();

/** The static board lines as an inline SVG (three rings + four spokes). */
function boardLinesSvg(): string {
  const [outer, middle, inner] = RING_EXTENT;
  const rect = ({ lo, hi }: { lo: number; hi: number }): string =>
    `<rect x="${lo}" y="${lo}" width="${hi - lo}" height="${hi - lo}" />`;
  const line = (x1: number, y1: number, x2: number, y2: number): string =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
  return (
    `<svg class="muehle-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">` +
    rect(outer) +
    rect(middle) +
    rect(inner) +
    line(MID, outer.lo, MID, inner.lo) + // top spoke
    line(MID, inner.hi, MID, outer.hi) + // bottom spoke
    line(outer.lo, MID, inner.lo, MID) + // left spoke
    line(inner.hi, MID, outer.hi, MID) + // right spoke
    `</svg>`
  );
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let settings: Settings = loadSettings();
let game: GameState | null = loadGame();
// The point the human has picked up (moving/flying phase), or null.
let selected: number | null = null;
// States at the start of each human turn, for undo: one pop reverts the whole
// turn (incl. a mill's take-a-stone step) plus the AI reply. Not persisted.
let history: GameState[] = [];
// Does the *running* game offer undo? Captured from the setting when the game
// starts and persisted alongside it, so flipping the setting mid-game — or
// relaunching the app — can't hand the button back.
let undoAllowed = isUndoAllowed(UNDO_LOCK_KEY);
let aiThinking = false;
// Why the AI didn't move, when it didn't. Without it a dead search is
// indistinguishable from a live one and the game is stuck for good.
let aiFailed: string | null = null;
// Bumped whenever a pending AI answer stops being wanted, so a late reply can
// be recognised as stale and dropped.
let aiGeneration = 0;
let aiTimer: ReturnType<typeof setTimeout> | undefined;
let endTimer: ReturnType<typeof setTimeout> | undefined;

// Move feedback so the AI's action is easy to follow: the last placement/slide
// stays glowing until the next move; a slid stone travels in from its origin (a
// placed one pops in, since it has no origin); and a captured stone leaves a
// fading ghost so you see which one was taken. `moveAnim` is consumed after one
// render so it plays exactly once.
let lastMove: { from: number | null; to: number } | null = null;
let moveAnim: { at: number; sx: number; sy: number; slide: boolean } | null = null;
let capturedGhost: { at: number; player: Player } | null = null;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
const CAPTURE_FLASH_MS = 720;
// The slide is expressed in % of the stone's own width, so a board-% distance
// has to be divided by the stone's board-% width — itself a fraction of a cell.
const SLIDE_PER_BOARD_PCT = 100 / (CELL_PCT * STONE_OF_CELL);

const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(`m-${id}`) as T;

function setCapturedGhost(ghost: { at: number; player: Player } | null): void {
  clearTimeout(flashTimer);
  capturedGhost = ghost;
  if (ghost) {
    flashTimer = setTimeout(() => {
      capturedGhost = null;
      renderGame();
    }, CAPTURE_FLASH_MS);
  }
}

function clearHighlights(): void {
  lastMove = null;
  moveAnim = null;
  setCapturedGhost(null);
}

/** Record what the just-applied move should show. A placement pops in; a slide
 *  travels from its origin; a removal ghosts the taken enemy stone while the
 *  mill-forming move stays lit. */
function noteMove(move: Move, mover: Player): void {
  if (move.kind === "place") {
    lastMove = { from: null, to: move.to };
    moveAnim = { at: move.to, sx: 0, sy: 0, slide: false };
    setCapturedGhost(null);
  } else if (move.kind === "move") {
    lastMove = { from: move.from, to: move.to };
    moveAnim = {
      at: move.to,
      sx: (POS[move.from].x - POS[move.to].x) * SLIDE_PER_BOARD_PCT,
      sy: (POS[move.from].y - POS[move.to].y) * SLIDE_PER_BOARD_PCT,
      slide: true,
    };
    setCapturedGhost(null);
  } else {
    setCapturedGhost({ at: move.at, player: otherPlayer(mover) });
  }
}

function aiPlayer(state: GameState): Player {
  return otherPlayer(state.humanPlayer);
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
  aiFailed = null;
  // A request already handed to the worker outlives its timer, so drop it too.
  aiGeneration++;
  cancelAiMoves();
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
// Board rendering
// ---------------------------------------------------------------------------
function renderBoard(container: HTMLElement, state: GameState, interactive: boolean): void {
  const locked = !interactive || aiThinking || state.status !== "playing" || isAiTurn(state);
  container.classList.toggle("locked", locked);
  container.replaceChildren();

  const linesLayer = document.createElement("div");
  linesLayer.className = "muehle-lines-layer";
  linesLayer.innerHTML = boardLinesSvg();
  container.append(linesLayer);

  const moves = interactive && !locked ? legalMoves(state) : [];
  const placing = state.inHand[state.currentPlayer] > 0 && !state.pendingCapture;

  // Highlight sets, derived from the legal moves for the current situation.
  const removable = new Set(
    state.pendingCapture ? moves.map((move) => (move.kind === "remove" ? move.at : -1)) : [],
  );
  const placeable = new Set(
    placing ? moves.map((move) => (move.kind === "place" ? move.to : -1)) : [],
  );
  const destinations = new Set(
    selected !== null
      ? moves
          .filter((move) => move.kind === "move" && move.from === selected)
          .map((move) => (move.kind === "move" ? move.to : -1))
      : [],
  );
  const movable = new Set(
    !state.pendingCapture && !placing && selected === null
      ? moves.map((move) => (move.kind === "move" ? move.from : -1))
      : [],
  );

  for (let index = 0; index < POINTS; index++) {
    const point = document.createElement(interactive ? "button" : "div");
    point.className = "mp";
    point.style.left = `${POS[index].x}%`;
    point.style.top = `${POS[index].y}%`;

    if (interactive) {
      const button = point as HTMLButtonElement;
      button.type = "button";
      button.disabled = locked;
      button.setAttribute("aria-label", `Punkt ${index + 1}`);
      button.addEventListener("click", () => onPointClick(index));
    }

    if (selected === index) point.classList.add("selected");
    if (removable.has(index)) point.classList.add("removable");
    if (placeable.has(index)) point.classList.add("placeable");
    if (destinations.has(index)) point.classList.add("target");
    if (movable.has(index)) point.classList.add("movable");
    if (interactive && lastMove) {
      if (lastMove.from === index) point.classList.add("last-from");
      if (lastMove.to === index) point.classList.add("last-to");
    }

    const owner = state.board[index];
    if (owner) {
      const stone = document.createElement("span");
      stone.className = `muehle-stone ${owner}`;
      if (interactive && moveAnim && moveAnim.at === index) {
        if (moveAnim.slide) {
          stone.classList.add("moving");
          stone.style.setProperty("--slide-x", `${moveAnim.sx}%`);
          stone.style.setProperty("--slide-y", `${moveAnim.sy}%`);
        } else {
          stone.classList.add("arrive");
        }
      }
      point.append(stone);
    } else if (interactive && capturedGhost && capturedGhost.at === index) {
      // The captured stone is already gone from state — ghost it so the player
      // sees exactly which one the mill took.
      const ghost = document.createElement("span");
      ghost.className = `muehle-stone ${capturedGhost.player} captured-ghost`;
      point.append(ghost);
    }
    container.append(point);
  }
}

// ---------------------------------------------------------------------------
// Game screen text
// ---------------------------------------------------------------------------
function whoText(state: GameState): string {
  if (state.mode === "local") return state.currentPlayer === "red" ? "Rot" : "Blau";
  return state.currentPlayer === state.humanPlayer ? "Du" : "KI";
}

function titleText(state: GameState): string {
  if (aiFailed) return "KI-Fehler";
  // Not `!aiThinking`: the flag used to be cleared at the top of the timer
  // callback, so the negation only mislabelled an imperceptible instant around a
  // blocking search that painted nothing anyway. It now stays true for the whole
  // worker round trip, and with the negation the title would read "KI setzt
  // (noch 9)" for seconds on end while the board sits locked — a live search and
  // a dead one looking identical, which is the ambiguity this all exists to end.
  if (state.mode === "ai" && state.currentPlayer !== state.humanPlayer) {
    return "KI denkt …";
  }
  const who = whoText(state);
  if (state.pendingCapture) return `${who}: Stein nehmen`;
  const phase = phaseOf(state, state.currentPlayer);
  if (phase === "placing") return `${who} setzt (noch ${state.inHand[state.currentPlayer]})`;
  if (phase === "flying") return `${who} fliegt`;
  return `${who} zieht`;
}

function annotText(state: GameState): string {
  if (aiFailed) return `${aiFailed} Tippe auf „Nochmal“.`;
  if (aiThinking) return "";
  if (state.pendingCapture) return "Mühle geschlossen — nimm einen gegnerischen Stein.";
  const phase = phaseOf(state, state.currentPlayer);
  if (phase === "placing") return "Tippe ein freies Feld, um einen Stein zu setzen.";
  if (phase === "flying") return "Du darfst auf jedes freie Feld ziehen.";
  return "Wähle einen Stein und dann sein Ziel.";
}

// Update only the title + hint — used when scheduling the AI, so its "denkt"
// text can change without a board rebuild cutting off an in-flight slide.
function paintStatus(): void {
  if (!game) return;
  const title = byId("game-title");
  title.textContent = titleText(game);
  title.className = `title turn ${game.currentPlayer}`;
  byId("game-annot").textContent = annotText(game);
  byId("board-actions").hidden = !undoAllowed;
  byId("ai-failed").hidden = aiFailed === null;
  (byId("btn-undo") as HTMLButtonElement).disabled =
    history.length === 0 || game.status !== "playing";
}

function renderGame(): void {
  if (!game) return;
  paintStatus();
  renderBoard(byId("board"), game, true);
  moveAnim = null; // consume: the slide plays on exactly one render
}

// ---------------------------------------------------------------------------
// Turn loop
// ---------------------------------------------------------------------------
function onPointClick(index: number): void {
  if (!game || game.status !== "playing" || aiThinking || isAiTurn(game)) return;
  setCapturedGhost(null); // a tap means the flash has served its purpose
  moveAnim = null;
  const moves = legalMoves(game);

  if (game.pendingCapture) {
    const remove = moves.find((move) => move.kind === "remove" && move.at === index);
    if (remove) step(remove);
    return;
  }

  if (game.inHand[game.currentPlayer] > 0) {
    const place = moves.find((move) => move.kind === "place" && move.to === index);
    if (place) step(place);
    return;
  }

  // Moving / flying: tap a highlighted destination, else (re)select an own stone.
  if (selected !== null) {
    const move = moves.find((candidate) => candidate.kind === "move" && candidate.from === selected && candidate.to === index);
    if (move) {
      step(move);
      return;
    }
  }
  const ownMovable = moves.some((move) => move.kind === "move" && move.from === index);
  selected = ownMovable ? index : null;
  renderGame();
}

function step(move: Move): void {
  if (!game) return;
  // Snapshot at the start of a human turn (not before the mill's capture step,
  // which belongs to the same turn), so one undo reverts turn + AI reply.
  const humanMover = game.mode === "local" || game.currentPlayer === game.humanPlayer;
  if (undoAllowed && humanMover && !game.pendingCapture) history.push(game);
  const mover = game.currentPlayer;
  game = applyMove(game, move);
  noteMove(move, mover);

  if (game.status !== "playing") {
    clearGame();
    selected = null;
    renderGame();
    endTimer = setTimeout(() => {
      renderEnd();
      showScreen("end");
    }, END_DELAY_MS);
    return;
  }

  saveGame(game);
  selected = null; // a fresh selection is made for the next move
  renderGame();
  maybeScheduleAi();
}

function undo(): void {
  const previous = history.pop();
  if (!previous) return;
  clearTimers(); // also cancels a pending AI reply or capture step
  clearHighlights();
  game = previous;
  selected = null;
  saveGame(game);
  renderGame();
}

function maybeScheduleAi(): void {
  if (!game || game.status !== "playing" || !isAiTurn(game)) return;
  aiThinking = true;
  selected = null;
  // Repaint only the status text — the board is already rendered (and locked)
  // from the move that led here; a rebuild would cut off its slide.
  paintStatus();
  // Before a mill's capture step, wait out the placing/sliding animation.
  const gap = game.pendingCapture ? CONTINUE_MS : AI_DELAY_MS;
  aiTimer = setTimeout(() => {
    if (!game || game.status !== "playing" || !isAiTurn(game)) {
      aiThinking = false;
      if (game) renderGame();
      return;
    }
    // Stamp the request: by the time the answer lands the player may have
    // undone, restarted or left, and a move for the old position would be
    // illegal in the new one.
    const asked = ++aiGeneration;
    const current = game;
    requestAiMove("muehle", current)
      .then((move) => {
        if (aiGeneration !== asked) return;
        aiThinking = false;
        step(move);
      })
      .catch((error: unknown) => {
        if (aiGeneration !== asked || error instanceof AiCancelledError) return;
        aiThinking = false;
        // Only AiUnavailableError carries copy meant for a player; anything
        // else is an engine assertion and must not reach a German UI.
        if (!(error instanceof AiUnavailableError)) console.error("Mühle AI:", error);
        aiFailed =
          error instanceof AiUnavailableError
            ? error.message
            : "Die KI konnte nicht ziehen.";
        renderGame();
      });
  }, gap);
}

/** Ask the AI again after a failure — the position is unchanged. */
function retryAi(): void {
  if (!game || game.status !== "playing" || !isAiTurn(game)) return;
  aiFailed = null;
  renderGame();
  maybeScheduleAi();
}

// ---------------------------------------------------------------------------
// End screen
// ---------------------------------------------------------------------------
function playerLabel(player: Player): string {
  return player === "red" ? "Rot" : "Blau";
}

function renderEnd(): void {
  if (!game || game.winner === null) return;
  const humanWon = game.mode === "ai" && game.winner === game.humanPlayer;
  const aiWon = game.mode === "ai" && game.winner !== game.humanPlayer;

  byId("end-bar").textContent = game.mode === "ai" ? (humanWon ? "Gewonnen" : "Verloren") : "Ergebnis";

  const glyph = byId("end-glyph");
  glyph.textContent = "★";
  glyph.className = `end-glyph ${game.winner}`;

  const title = byId("end-title");
  if (game.mode === "ai") {
    title.textContent = humanWon ? "DU GEWINNST" : "KI GEWINNT";
    title.className = `end-title ${humanWon ? "win" : "lose"}`;
  } else {
    title.textContent = `${playerLabel(game.winner).toUpperCase()} GEWINNT`;
    title.className = `end-title ${game.winner}`;
  }

  const loser = otherPlayer(game.winner);
  const stuck = onBoardCount(game.board, loser) >= 3; // still ≥3 stones ⇒ lost by being blocked
  byId("end-sub").textContent = aiWon
    ? "Die KI hat dich in die Enge getrieben. Revanche?"
    : humanWon
      ? "Stark gespielt — die KI ist geschlagen."
      : stuck
        ? `${playerLabel(loser)} kann nicht mehr ziehen.`
        : `${playerLabel(loser)} hat nur noch zwei Steine.`;

  renderBoard(byId("end-board"), game, false);
}

// ---------------------------------------------------------------------------
// Setup screen — both modes pass through it, so every option sits in one place;
// the KI-only panels are hidden in local mode.
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
  (byId("btn-continue") as HTMLButtonElement).hidden = game === null || game.status !== "playing";
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function startGame(mode: Mode, difficulty = settings.difficulty, humanFirst = true): void {
  clearTimers();
  clearHighlights();
  game = createGame({ mode, difficulty, humanPlayer: humanFirst ? "red" : "blue" });
  selected = null;
  history = [];
  // The only place the choice is captured — every new game (incl. restart and
  // rematch) comes through here, and nothing else writes the lock.
  undoAllowed = settings.allowUndo;
  setUndoAllowed(UNDO_LOCK_KEY, undoAllowed);
  saveGame(game);
  showScreen("game");
  renderGame();
  maybeScheduleAi();
}

function resumeGame(): void {
  if (!game) return;
  clearTimers();
  clearHighlights();
  selected = null;
  history = [];
  // Resumed mid mill-capture there's no turn-start state to snapshot, and the
  // remove step won't push one — seed the stack with the closest reachable
  // boundary so the first post-resume turn stays undoable.
  if (undoAllowed && game.pendingCapture) history.push(game);
  showScreen("game");
  renderGame();
  maybeScheduleAi();
}

function goHome(): void {
  clearTimers();
  clearHighlights();
  selected = null;
  renderHome();
  showScreen("home");
}

function openSetup(mode: Mode): void {
  setupMode = mode;
  renderSetup();
  showScreen("setup");
}

// ---------------------------------------------------------------------------
// Wiring + hub contract — called once at boot by the hub.
// ---------------------------------------------------------------------------
export function initMuehle(host: GameHost): GameController {
  const howto = byId<HTMLDialogElement>("howto");

  byId("home-hub").addEventListener("click", host.onExit);
  byId("btn-ai").addEventListener("click", () => openSetup("ai"));
  byId("btn-local").addEventListener("click", () => openSetup("local"));
  byId("btn-continue").addEventListener("click", resumeGame);
  byId("btn-howto").addEventListener("click", () => howto.showModal());

  byId("setup-back").addEventListener("click", goHome);
  byId("btn-start").addEventListener("click", () =>
    // In local mode "who starts" doesn't apply — red always opens.
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
  byId("btn-ai-retry").addEventListener("click", retryAi);
  byId("game-restart").addEventListener("click", () => {
    if (!game) return;
    startGame(game.mode, game.difficulty, game.humanPlayer === "red");
  });

  byId("end-back").addEventListener("click", goHome);
  byId("btn-home").addEventListener("click", goHome);
  byId("btn-again").addEventListener("click", () => {
    if (!game) return;
    startGame(game.mode, game.difficulty, game.humanPlayer === "red");
  });

  byId("howto-close").addEventListener("click", () => howto.close());
  howto.addEventListener("click", (event) => {
    if (event.target === howto) howto.close();
  });

  return {
    activate: goHome,
    deactivate: clearTimers,
    hasRunningGame: () => game !== null && game.status === "playing",
  };
}
