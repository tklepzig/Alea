// Quadra's DOM wiring and screen flow, ported from the standalone app. All the
// game *rules* live in game.ts (pure, tested); this file is the impure shell:
// rendering, input, navigation, the AI turn loop, and localStorage. The board
// is rebuilt from state on every render. Element ids are prefixed `q-` so the
// game coexists with its siblings in the hub's single document.

import { APP_ID } from "../../shell/app.js";
import { safeGet, safeRemove, safeSet } from "../../shell/safe-storage.js";
import { isUndoAllowed, setUndoAllowed } from "../../shell/undo-lock.js";
import type { GameController, GameHost } from "../../shell/game-controller.js";
import {
  COLUMNS,
  ROWS,
  createGame,
  applyMove,
  getAiMove,
  isColumnPlayable,
  lowestEmptyRow,
  otherPlayer,
  type Difficulty,
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

const GAME_KEY = `${APP_ID}.quadra.game`;
const SETTINGS_KEY = `${APP_ID}.quadra.settings`;
const UNDO_LOCK_KEY = `${APP_ID}.quadra.undo-lock`;

// How long the AI "thinks" before moving — avoids an instant, jarring reply.
const AI_DELAY_MS = 550;
// How long the winning board stays visible before the end screen slides in.
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
// App state
// ---------------------------------------------------------------------------
let settings: Settings = loadSettings();
// Only an *in-progress* game is ever persisted, so a restored game is resumable.
let game: GameState | null = loadGame();
// The disc placed by the most recent move, so we can animate just that one.
let lastDrop: Move | null = null;
// States before each human move, for undo: one pop reverts the move plus the
// AI reply that followed (the snapshot predates both). Not persisted — a
// resumed game starts with a fresh stack, like Solo-Halma.
let history: GameState[] = [];
// Does the *running* game offer undo? Captured from the setting when the game
// starts and persisted alongside it, so flipping the setting mid-game — or
// relaunching the app — can't hand the button back.
let undoAllowed = isUndoAllowed(UNDO_LOCK_KEY);
// True while the AI's move is pending — the board is locked against input.
let aiThinking = false;
let aiTimer: ReturnType<typeof setTimeout> | undefined;
let endTimer: ReturnType<typeof setTimeout> | undefined;

const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(`q-${id}`) as T;

function aiPlayer(state: GameState): Player {
  return otherPlayer(state.humanPlayer);
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
  for (const key of ["home", "setup", "game", "end"] as const) {
    byId(`screen-${key}`).hidden = key !== name;
  }
}

// ---------------------------------------------------------------------------
// Board rendering — shared by the live game board and the static end board.
// ---------------------------------------------------------------------------
interface BoardOptions {
  interactive: boolean;
  locked: boolean;
  winningCells: Move[] | null;
  /** Colour the hover ghost should use, when interactive. */
  turn?: Player;
}

function renderBoard(
  container: HTMLElement,
  state: GameState,
  options: BoardOptions,
): void {
  container.replaceChildren();
  container.classList.toggle("locked", options.locked);
  if (options.turn) {
    container.style.setProperty(
      "--turn",
      options.turn === "red" ? "var(--disc-red)" : "var(--disc-yellow)",
    );
  }

  const winning = new Set(
    (options.winningCells ?? []).map((cell) => `${cell.column},${cell.row}`),
  );

  for (let column = 0; column < COLUMNS; column++) {
    const columnEl = document.createElement(options.interactive ? "button" : "div");
    columnEl.className = "column";

    const dropRow = lowestEmptyRow(state.board, column);
    if (options.interactive) {
      const columnButton = columnEl as HTMLButtonElement;
      columnButton.type = "button";
      columnButton.disabled = options.locked || dropRow === -1;
      columnButton.setAttribute("aria-label", `Spalte ${column + 1} setzen`);
      columnButton.addEventListener("click", () => onColumnClick(column));
    }

    // Render rows top-to-bottom so the visual top is the highest row index.
    for (let row = ROWS - 1; row >= 0; row--) {
      const cell = document.createElement("span");
      cell.className = "cell";

      const value = state.board[column][row];
      const disc = document.createElement("span");
      disc.className = `disc ${value ?? "empty"}`;
      if (winning.has(`${column},${row}`)) disc.classList.add("win");
      // The ghost preview lands in the lowest empty slot of a playable column.
      if (options.interactive && !options.locked && row === dropRow) {
        disc.classList.add("next");
      }
      if (lastDrop && lastDrop.column === column && lastDrop.row === row) {
        disc.classList.add("drop");
      }

      cell.append(disc);
      columnEl.append(cell);
    }

    container.append(columnEl);
  }
}

// ---------------------------------------------------------------------------
// Game screen
// ---------------------------------------------------------------------------
function turnText(state: GameState): string {
  if (state.mode === "local") {
    return state.currentPlayer === "red" ? "Rot ist dran" : "Gelb ist dran";
  }
  return state.currentPlayer === state.humanPlayer ? "Du bist dran" : "KI denkt …";
}

function renderGame(): void {
  if (!game) return;
  const locked = aiThinking || game.status !== "playing";

  const title = byId("game-title");
  title.textContent = turnText(game);
  title.className = `title turn ${game.currentPlayer}`;

  byId("game-annot").textContent = aiThinking
    ? ""
    : "Tippe eine Spalte, um einen Stein zu setzen.";

  byId("board-actions").hidden = !undoAllowed;
  (byId("btn-undo") as HTMLButtonElement).disabled =
    history.length === 0 || game.status !== "playing";

  renderBoard(byId("board"), game, {
    interactive: true,
    locked,
    winningCells: game.winningCells,
    turn: game.currentPlayer,
  });

  // Consume the drop so later re-renders (e.g. locking for the AI) don't replay
  // the fall animation.
  lastDrop = null;
}

// ---------------------------------------------------------------------------
// Turn loop
// ---------------------------------------------------------------------------
function onColumnClick(column: number): void {
  if (!game || game.status !== "playing" || aiThinking) return;
  // In AI mode, ignore taps while it's the computer's turn.
  if (game.mode === "ai" && game.currentPlayer !== game.humanPlayer) return;
  if (!isColumnPlayable(game.board, column)) return;
  step(column);
}

/** Apply one move (whoever's turn it is), then render and route what's next. */
function step(column: number): void {
  if (!game) return;
  // Snapshot before a human move (states are immutable) — the AI's reply lands
  // after the snapshot, so one undo takes back the whole exchange.
  if (undoAllowed && (game.mode === "local" || game.currentPlayer === game.humanPlayer)) {
    history.push(game);
  }
  lastDrop = { column, row: lowestEmptyRow(game.board, column) };
  game = applyMove(game, column);

  if (game.status === "playing") {
    saveGame(game);
    renderGame();
    maybeScheduleAi();
  } else {
    // Finished — don't persist a done game (so "Fortsetzen" won't offer it).
    clearGame();
    renderGame(); // show the final move + win highlight on the board first
    endTimer = setTimeout(() => {
      renderEnd();
      showScreen("end");
    }, END_DELAY_MS);
  }
}

function undo(): void {
  const previous = history.pop();
  if (!previous) return;
  clearTimers(); // also cancels a pending AI reply
  game = previous;
  lastDrop = null;
  saveGame(game);
  renderGame();
}

/** If it's the AI's turn, think briefly and then play. */
function maybeScheduleAi(): void {
  if (!game || game.mode !== "ai" || game.status !== "playing") return;
  if (game.currentPlayer !== aiPlayer(game)) return;

  aiThinking = true;
  renderGame(); // lock the board and show "KI denkt …"
  aiTimer = setTimeout(() => {
    aiThinking = false;
    // Re-check the turn too (like the sibling games): undo can flip it back to
    // the human between scheduling and firing.
    if (!game || game.status !== "playing" || game.currentPlayer !== aiPlayer(game)) return;
    const column = getAiMove(game.board, game.currentPlayer, game.difficulty);
    step(column);
  }, AI_DELAY_MS);
}

// ---------------------------------------------------------------------------
// End screen
// ---------------------------------------------------------------------------
function playerLabel(player: Player): string {
  return player === "red" ? "Rot" : "Gelb";
}

function renderEnd(): void {
  if (!game) return;
  const won = game.status === "won";
  const humanWon = won && game.mode === "ai" && game.winner === game.humanPlayer;
  const aiWon = won && game.mode === "ai" && game.winner !== game.humanPlayer;

  const bar = byId("end-bar");
  bar.textContent = !won ? "Unentschieden" : aiWon ? "Verloren" : "Gewonnen";

  const glyph = byId("end-glyph");
  glyph.textContent = won ? "★" : "◐";
  glyph.className = `end-glyph ${won ? game.winner : "draw"}`;

  const title = byId("end-title");
  if (!won) {
    title.textContent = "UNENTSCHIEDEN";
    title.className = "end-title draw";
  } else if (game.mode === "ai") {
    title.textContent = humanWon ? "DU GEWINNST" : "KI GEWINNT";
    title.className = `end-title ${humanWon ? "win" : "lose"}`;
  } else {
    title.textContent = `${playerLabel(game.winner!).toUpperCase()} GEWINNT`;
    title.className = `end-title ${game.winner}`;
  }

  byId("end-sub").textContent = !won
    ? "Das Brett ist voll — niemand hat vier in einer Reihe."
    : aiWon
      ? "Die KI hatte vier in einer Reihe. Revanche?"
      : humanWon
        ? "Stark gespielt — die KI ist geschlagen."
        : `${playerLabel(game.winner!)} hat vier in einer Reihe.`;

  renderBoard(byId("end-board"), game, {
    interactive: false,
    locked: true,
    winningCells: game.winningCells,
  });
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
  const canContinue = game !== null && game.status === "playing";
  (byId("btn-continue") as HTMLButtonElement).hidden = !canContinue;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function startGame(mode: Mode, difficulty = settings.difficulty, humanFirst = true): void {
  clearTimers();
  game = createGame({
    mode,
    difficulty,
    humanPlayer: humanFirst ? "red" : "yellow",
  });
  lastDrop = null;
  history = [];
  // The only place the choice is captured — every new game (incl. restart and
  // rematch) comes through here, and nothing else writes the lock.
  undoAllowed = settings.allowUndo;
  setUndoAllowed(UNDO_LOCK_KEY, undoAllowed);
  saveGame(game);
  showScreen("game");
  renderGame();
  maybeScheduleAi(); // AI opens if the human chose to go second
}

function resumeGame(): void {
  if (!game) return;
  clearTimers();
  lastDrop = null;
  history = [];
  showScreen("game");
  renderGame();
  maybeScheduleAi(); // re-trigger the AI if it was its turn when we left
}

function goHome(): void {
  clearTimers();
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
export function initQuadra(host: GameHost): GameController {
  const howto = byId<HTMLDialogElement>("howto");
  const openHowto = (): void => howto.showModal();

  byId("home-hub").addEventListener("click", host.onExit);
  byId("btn-ai").addEventListener("click", () => openSetup("ai"));
  byId("btn-local").addEventListener("click", () => openSetup("local"));
  byId("btn-continue").addEventListener("click", resumeGame);
  byId("btn-howto").addEventListener("click", openHowto);

  byId("setup-back").addEventListener("click", goHome);
  byId("btn-start").addEventListener("click", () =>
    // In local mode "who starts" doesn't apply — red always opens.
    startGame(setupMode, settings.difficulty, setupMode === "local" || settings.humanFirst),
  );

  byId("seg-difficulty").addEventListener("click", (event) => {
    const value = (event.target as HTMLElement).closest<HTMLButtonElement>(".seg")?.dataset.value;
    const difficulties: readonly Difficulty[] = ["easy", "medium", "hard", "expert"];
    if (!difficulties.includes(value as Difficulty)) return;
    settings = { ...settings, difficulty: value as Difficulty };
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
  // Backdrop click closes the dialog (the click lands on <dialog>, not its content).
  howto.addEventListener("click", (event) => {
    if (event.target === howto) howto.close();
  });

  return {
    activate: goHome,
    deactivate: clearTimers,
    hasRunningGame: () => game !== null && game.status === "playing",
  };
}
