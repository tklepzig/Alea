// Dame's DOM wiring and screen flow. All the rules live in game.ts (pure,
// tested); this file is the impure shell: rendering the 8×8 board, the
// select-then-move input, the AI turn loop, and localStorage. Element ids are
// prefixed `d-` so the game coexists with its siblings in the hub's single
// document.

import { APP_ID } from "../../shell/app.js";
import { safeGet, safeRemove, safeSet } from "../../shell/safe-storage.js";
import type { GameController, GameHost } from "../../shell/game-controller.js";
import {
  SIZE,
  createGame,
  applyMove,
  getAiMove,
  legalMoves,
  otherPlayer,
  isPlayable,
  type GameState,
  type Mode,
  type Move,
  type Player,
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

const GAME_KEY = `${APP_ID}.dame.game`;
const SETTINGS_KEY = `${APP_ID}.dame.settings`;

// How long the AI "thinks" before each step — avoids an instant, jarring reply.
const AI_DELAY_MS = 550;
// How long the final board stays visible before the end screen slides in.
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
// App state
// ---------------------------------------------------------------------------
let settings: Settings = loadSettings();
// Only an *in-progress* game is ever persisted, so a restored game is resumable.
let game: GameState | null = loadGame();
// The piece the human has picked up (its legal targets are highlighted).
let selected: Square | null = null;
// True while the AI's move is pending — the board is locked against input.
let aiThinking = false;
let aiTimer: ReturnType<typeof setTimeout> | undefined;
let endTimer: ReturnType<typeof setTimeout> | undefined;

const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(`d-${id}`) as T;

const key = (square: Square): string => `${square.row},${square.col}`;

function aiPlayer(state: GameState): Player {
  return otherPlayer(state.humanPlayer);
}

function isAiTurn(state: GameState): boolean {
  return state.mode === "ai" && state.currentPlayer === aiPlayer(state);
}

function clearTimers(): void {
  clearTimeout(aiTimer);
  clearTimeout(endTimer);
  aiTimer = undefined;
  endTimer = undefined;
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
function renderBoard(
  container: HTMLElement,
  state: GameState,
  interactive: boolean,
): void {
  container.replaceChildren();
  const locked = !interactive || aiThinking || state.status !== "playing" || isAiTurn(state);
  container.classList.toggle("locked", locked);

  const moves = interactive && !locked ? legalMoves(state) : [];
  const targets = new Set(
    selected
      ? moves
          .filter((move) => move.from.row === selected!.row && move.from.col === selected!.col)
          .map((move) => key(move.to))
      : [],
  );
  // With nothing picked up yet, hint which pieces can move.
  const movable = new Set(!selected ? moves.map((move) => key(move.from)) : []);

  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const dark = isPlayable(row, col);
      const square: Square = { row, col };
      const cell = document.createElement(interactive && dark ? "button" : "div");
      cell.className = `sq ${dark ? "dark" : "light"}`;

      if (interactive && dark) {
        const button = cell as HTMLButtonElement;
        button.type = "button";
        button.disabled = locked;
        button.setAttribute("aria-label", `Feld ${col + 1}/${SIZE - row}`);
        button.addEventListener("click", () => onCellClick(square));
      }

      if (selected && selected.row === row && selected.col === col) cell.classList.add("selected");
      if (targets.has(key(square))) cell.classList.add("target");
      if (movable.has(key(square))) cell.classList.add("movable");

      const piece = state.board[row][col];
      if (piece) {
        const disc = document.createElement("span");
        disc.className = `dame-piece ${piece.player}${piece.kind === "king" ? " king" : ""}`;
        cell.append(disc);
      }
      container.append(cell);
    }
  }
}

// ---------------------------------------------------------------------------
// Game screen
// ---------------------------------------------------------------------------
function turnText(state: GameState): string {
  if (state.mode === "local") {
    return state.currentPlayer === "red" ? "Rot ist dran" : "Schwarz ist dran";
  }
  return state.currentPlayer === state.humanPlayer ? "Du bist dran" : "KI denkt …";
}

function annotText(state: GameState): string {
  if (aiThinking) return "";
  if (state.mustContinueFrom) return "Weiter schlagen — der Sprung geht noch!";
  const mustCapture = legalMoves(state).some((move) => move.captured !== null);
  if (mustCapture) return "Schlagzwang — du musst schlagen.";
  return "Wähle einen Stein und dann sein Ziel.";
}

function renderGame(): void {
  if (!game) return;
  const title = byId("game-title");
  title.textContent = turnText(game);
  title.className = `title turn ${game.currentPlayer}`;
  byId("game-annot").textContent = annotText(game);
  renderBoard(byId("board"), game, true);
}

// ---------------------------------------------------------------------------
// Turn loop
// ---------------------------------------------------------------------------
function onCellClick(square: Square): void {
  if (!game || game.status !== "playing" || aiThinking) return;
  if (isAiTurn(game)) return; // not the human's turn

  const moves = legalMoves(game);
  const fromSelected = selected
    ? moves.filter((move) => move.from.row === selected!.row && move.from.col === selected!.col)
    : [];

  // Tapping a highlighted destination plays that step.
  const chosen = fromSelected.find((move) => move.to.row === square.row && move.to.col === square.col);
  if (chosen) {
    step(chosen);
    return;
  }

  // Mid multi-jump the piece is fixed — ignore anything but its targets.
  if (game.mustContinueFrom) return;

  // Otherwise (re)select a piece that actually has a move.
  const owned = moves.some((move) => move.from.row === square.row && move.from.col === square.col);
  selected = owned ? square : null;
  renderGame();
}

/** Apply one step (slide or single jump), then route what's next. */
function step(move: Move): void {
  if (!game) return;
  game = applyMove(game, move);

  if (game.status !== "playing") {
    clearGame(); // finished — don't offer "Fortsetzen"
    selected = null;
    renderGame(); // show the final position first
    endTimer = setTimeout(() => {
      renderEnd();
      showScreen("end");
    }, END_DELAY_MS);
    return;
  }

  saveGame(game);
  // A capture that keeps the turn open pins the selection to the continuing
  // piece (for the human) or drives the next AI step.
  selected = game.mustContinueFrom;
  renderGame();
  maybeScheduleAi();
}

/** If it's the AI's turn (including a multi-jump continuation), think and play. */
function maybeScheduleAi(): void {
  if (!game || game.status !== "playing" || !isAiTurn(game)) return;
  aiThinking = true;
  selected = null;
  renderGame(); // lock the board and show "KI denkt …"
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
  return player === "red" ? "Rot" : "Schwarz";
}

function renderEnd(): void {
  if (!game || game.winner === null) return;
  const humanWon = game.mode === "ai" && game.winner === game.humanPlayer;
  const aiWon = game.mode === "ai" && game.winner !== game.humanPlayer;

  byId("end-bar").textContent =
    game.mode === "ai" ? (humanWon ? "Gewonnen" : "Verloren") : "Ergebnis";

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

  byId("end-sub").textContent = aiWon
    ? "Die KI hat dich festgesetzt. Revanche?"
    : humanWon
      ? "Stark gespielt — die KI ist geschlagen."
      : `${playerLabel(game.winner)} hat den Gegner bewegungsunfähig gemacht.`;

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
  (byId("btn-continue") as HTMLButtonElement).hidden =
    game === null || game.status !== "playing";
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function startGame(mode: Mode, difficulty = settings.difficulty, humanFirst = true): void {
  clearTimers();
  // Red always opens; the human takes red when they choose to go first.
  game = createGame({ mode, difficulty, humanPlayer: humanFirst ? "red" : "black" });
  selected = null;
  saveGame(game);
  showScreen("game");
  renderGame();
  maybeScheduleAi(); // AI opens if the human chose to go second
}

function resumeGame(): void {
  if (!game) return;
  clearTimers();
  selected = game.mustContinueFrom;
  showScreen("game");
  renderGame();
  maybeScheduleAi(); // re-trigger the AI if it was its turn when we left
}

function goHome(): void {
  clearTimers();
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
export function initDame(host: GameHost): GameController {
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
