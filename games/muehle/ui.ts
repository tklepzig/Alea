// Mühle's DOM wiring and screen flow. The rules live in game.ts (pure, tested);
// this file renders the 24-point board (an SVG line layer plus absolutely
// positioned point buttons), handles the phase-aware input (place → move/fly →
// take-a-stone), runs the AI turn loop, and persists to localStorage. Element
// ids are prefixed `m-`.

import { APP_ID } from "../../shell/app.js";
import { safeGet, safeRemove, safeSet } from "../../shell/safe-storage.js";
import type { GameController, GameHost } from "../../shell/game-controller.js";
import {
  POINTS,
  createGame,
  applyMove,
  getAiMove,
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
  DEFAULT_SETTINGS,
  serializeGame,
  deserializeGame,
  serializeSettings,
  deserializeSettings,
  type Settings,
} from "./storage.js";

const GAME_KEY = `${APP_ID}.muehle.game`;
const SETTINGS_KEY = `${APP_ID}.muehle.settings`;

const AI_DELAY_MS = 550;
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
}

// ---------------------------------------------------------------------------
// Point geometry — three rings, each with 8 points (percent coordinates on the
// square board). Index = ring*8 + position (0=TL … 7=LM, clockwise).
// ---------------------------------------------------------------------------
const RING_EXTENT = [
  { lo: 9, hi: 91 },
  { lo: 29, hi: 71 },
  { lo: 44, hi: 56 },
];
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
let aiThinking = false;
let aiTimer: ReturnType<typeof setTimeout> | undefined;
let endTimer: ReturnType<typeof setTimeout> | undefined;

// Move feedback so the AI's action is easy to follow: the last placement/slide
// stays glowing until the next move, the affected stone pops in, and a captured
// stone leaves a fading ghost so you see which one was taken.
let lastMove: { from: number | null; to: number } | null = null;
let arriveAt: number | null = null; // consumed after one render
let capturedGhost: { at: number; player: Player } | null = null;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
const CAPTURE_FLASH_MS = 480;

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
  arriveAt = null;
  setCapturedGhost(null);
}

/** Record what the just-applied move should highlight. A placement/slide lights
 *  its path and pops the stone; a removal ghosts the taken enemy stone while the
 *  mill-forming move stays lit. */
function noteMove(move: Move, mover: Player): void {
  if (move.kind === "place") {
    lastMove = { from: null, to: move.to };
    arriveAt = move.to;
    setCapturedGhost(null);
  } else if (move.kind === "move") {
    lastMove = { from: move.from, to: move.to };
    arriveAt = move.to;
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
      if (interactive && arriveAt === index) stone.classList.add("arrive");
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
  if (state.mode === "ai" && state.currentPlayer !== state.humanPlayer && !aiThinking) {
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
  if (aiThinking) return "";
  if (state.pendingCapture) return "Mühle geschlossen — nimm einen gegnerischen Stein.";
  const phase = phaseOf(state, state.currentPlayer);
  if (phase === "placing") return "Tippe ein freies Feld, um einen Stein zu setzen.";
  if (phase === "flying") return "Du darfst auf jedes freie Feld ziehen.";
  return "Wähle einen Stein und dann sein Ziel.";
}

function renderGame(): void {
  if (!game) return;
  const title = byId("game-title");
  title.textContent = titleText(game);
  title.className = `title turn ${game.currentPlayer}`;
  byId("game-annot").textContent = annotText(game);
  renderBoard(byId("board"), game, true);
  arriveAt = null; // consume: the arrival plays on exactly one render
}

// ---------------------------------------------------------------------------
// Turn loop
// ---------------------------------------------------------------------------
function onPointClick(index: number): void {
  if (!game || game.status !== "playing" || aiThinking || isAiTurn(game)) return;
  setCapturedGhost(null); // a tap means the flash has served its purpose
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

function maybeScheduleAi(): void {
  if (!game || game.status !== "playing" || !isAiTurn(game)) return;
  aiThinking = true;
  selected = null;
  renderGame(); // lock the board, show "KI denkt …"
  aiTimer = setTimeout(() => {
    aiThinking = false;
    if (!game || game.status !== "playing" || !isAiTurn(game)) return;
    step(getAiMove(game));
  }, AI_DELAY_MS);
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
// Setup screen (AI mode only)
// ---------------------------------------------------------------------------
function markSegment(groupId: string, value: string): void {
  for (const button of byId(groupId).querySelectorAll<HTMLButtonElement>(".seg")) {
    button.classList.toggle("active", button.dataset.value === value);
    button.setAttribute("aria-pressed", String(button.dataset.value === value));
  }
}

function renderSetup(): void {
  markSegment("seg-difficulty", settings.difficulty);
  markSegment("seg-first", settings.humanFirst ? "human" : "ai");
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

function openSetup(): void {
  renderSetup();
  showScreen("setup");
}

// ---------------------------------------------------------------------------
// Wiring + hub contract — called once at boot by the hub.
// ---------------------------------------------------------------------------
export function initMuehle(host: GameHost): GameController {
  const howto = byId<HTMLDialogElement>("howto");

  byId("home-hub").addEventListener("click", host.onExit);
  byId("btn-ai").addEventListener("click", openSetup);
  byId("btn-local").addEventListener("click", () => startGame("local"));
  byId("btn-continue").addEventListener("click", resumeGame);
  byId("btn-howto").addEventListener("click", () => howto.showModal());

  byId("setup-back").addEventListener("click", goHome);
  byId("btn-start-ai").addEventListener("click", () =>
    startGame("ai", settings.difficulty, settings.humanFirst),
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

  byId("game-back").addEventListener("click", goHome);
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
