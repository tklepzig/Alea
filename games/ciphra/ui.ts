// Ciphra's DOM wiring and screen flow, ported from the standalone app. All the
// game *rules* live in game.ts (pure, tested); this file is the impure shell:
// rendering, input, navigation, and localStorage. Colours are integer indices;
// a peg's CSS colour class is `c${index + 1}` (see style.scss). Element ids are
// prefixed `c-` so the game coexists with its siblings in the hub's document.

import { APP_ID } from "../../shell/app.js";
import { safeGet, safeRemove, safeSet } from "../../shell/safe-storage.js";
import type { GameController, GameHost } from "../../shell/game-controller.js";
import {
  DEFAULT_CONFIG,
  LIMITS,
  createGame,
  submitGuess,
  remainingGuesses,
  type GameConfig,
  type GameState,
} from "./game.js";
import {
  serializeConfig,
  deserializeConfig,
  serializeGame,
  deserializeGame,
} from "./storage.js";

const CONFIG_KEY = `${APP_ID}.ciphra.config`;
const GAME_KEY = `${APP_ID}.ciphra.game`;

function loadConfig(): GameConfig {
  return deserializeConfig(safeGet(CONFIG_KEY)) ?? { ...DEFAULT_CONFIG };
}
function saveConfig(config: GameConfig): void {
  safeSet(CONFIG_KEY, serializeConfig(config));
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
let config: GameConfig = loadConfig();
// Only an *in-progress* game is ever persisted, so a restored game is resumable.
let game: GameState | null = loadGame();
// The current, not-yet-submitted row. Length follows the active game's config.
let active: (number | null)[] = [];
// Which slot the next palette click will fill.
let selectedSlot: number = 0;

const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(`c-${id}`) as T;

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
type ScreenName = "home" | "settings" | "game" | "end";

function showScreen(name: ScreenName): void {
  for (const key of ["home", "settings", "game", "end"] as const) {
    byId(`screen-${key}`).hidden = key !== name;
  }
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------
function pegEl(
  colourIndex: number,
  size: "s" | "m" | "l",
  onClick?: () => void,
): HTMLElement {
  const tag = onClick ? "button" : "span";
  const element = document.createElement(tag);
  element.className = `peg ${size} c${colourIndex + 1}`;
  if (onClick) {
    (element as HTMLButtonElement).type = "button";
    element.addEventListener("click", onClick);
  }
  return element;
}

function slotEl(size: "m" | "l", isActive: boolean, onClick?: () => void): HTMLElement {
  const tag = onClick ? "button" : "span";
  const element = document.createElement(tag);
  element.className = `slot ${size}${isActive ? " active" : ""}`;
  if (onClick) {
    (element as HTMLButtonElement).type = "button";
    element.addEventListener("click", onClick);
  }
  return element;
}

function emptyRow(length: number): (number | null)[] {
  return Array.from({ length }, () => null);
}

function isRowFull(): boolean {
  return active.length > 0 && active.every((peg) => peg !== null);
}

// ---------------------------------------------------------------------------
// Game rendering
// ---------------------------------------------------------------------------
function renderGame(): void {
  if (!game) return;
  const { codeLength, colours, maxGuesses } = game.config;

  byId("game-title").textContent = `Noch ${remainingGuesses(game)} Versuche`;

  // Board
  const board = byId("board");
  board.replaceChildren();
  const currentRowIndex = game.guesses.length;

  for (let rowIndex = 0; rowIndex < maxGuesses; rowIndex++) {
    const row = document.createElement("div");
    row.className = "row";

    const number = document.createElement("span");
    number.className = "rownum";
    number.textContent = String(rowIndex + 1);

    const pegs = document.createElement("span");
    pegs.className = "pegs";

    if (rowIndex < currentRowIndex) {
      // Submitted guess + feedback (filled then outline dots, no empties).
      const guess = game.guesses[rowIndex];
      for (const colour of guess.pegs) pegs.append(pegEl(colour, "m"));
      const feedback = document.createElement("span");
      feedback.className = "fb";
      for (let i = 0; i < guess.feedback.exact; i++) {
        const dot = document.createElement("i");
        dot.className = "exact";
        feedback.append(dot);
      }
      for (let i = 0; i < guess.feedback.colour; i++) {
        const dot = document.createElement("i");
        dot.className = "colour";
        feedback.append(dot);
      }
      row.append(number, pegs, feedback);
    } else if (rowIndex === currentRowIndex && game.status === "playing") {
      // The active row: placed pegs (tap to clear) + empty slots.
      row.classList.add("current");
      for (let slot = 0; slot < codeLength; slot++) {
        const placed = active[slot];
        if (placed === null) {
          pegs.append(slotEl("m", slot === selectedSlot, () => selectSlot(slot)));
        } else {
          pegs.append(pegEl(placed, "m", () => clearSlot(slot)));
        }
      }
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = isRowFull() ? "" : "setzen";
      row.append(number, pegs, hint);
    } else {
      // Future row: dimmed empty slots.
      row.classList.add("empty");
      for (let slot = 0; slot < codeLength; slot++) pegs.append(slotEl("m", false));
      row.append(number, pegs, document.createElement("span"));
    }

    board.append(row);
  }

  // Palette — a colour already in the active row is disabled when repeats are off.
  const palette = byId("palette");
  palette.replaceChildren();
  for (let colour = 0; colour < colours; colour++) {
    const button = pegEl(colour, "l", () => placeColour(colour)) as HTMLButtonElement;
    if (!game.config.allowRepeats && active.includes(colour)) {
      button.disabled = true;
    }
    palette.append(button);
  }

  // Controls
  (byId("btn-check") as HTMLButtonElement).disabled = !isRowFull();
  (byId("btn-undo") as HTMLButtonElement).disabled = active.every((p) => p === null);

  // Keep the active row visible as the board scrolls internally.
  board.querySelector(".row.current")?.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------------------
// Game interaction
// ---------------------------------------------------------------------------
function selectSlot(index: number): void {
  selectedSlot = index;
  renderGame();
}

function placeColour(colour: number): void {
  if (!game || game.status !== "playing") return;
  if (!game.config.allowRepeats && active.includes(colour)) return;
  // If the selected slot is already filled, fall back to the first empty slot.
  const target = active[selectedSlot] === null ? selectedSlot : active.indexOf(null);
  if (target === -1) return; // row full
  active[target] = colour;
  // Advance selection to the next empty slot (if any).
  const next = active.indexOf(null);
  if (next !== -1) selectedSlot = next;
  renderGame();
}

function clearSlot(index: number): void {
  active[index] = null;
  selectedSlot = index;
  renderGame();
}

function undoLast(): void {
  for (let index = active.length - 1; index >= 0; index--) {
    if (active[index] !== null) {
      active[index] = null;
      selectedSlot = index;
      break;
    }
  }
  renderGame();
}

function check(): void {
  if (!game || game.status !== "playing" || !isRowFull()) return;
  game = submitGuess(game, active as number[]);
  active = emptyRow(game.config.codeLength);
  selectedSlot = 0;

  if (game.status === "playing") {
    saveGame(game);
    renderGame();
  } else {
    // Finished — don't persist a done game (so "Fortsetzen" won't offer it).
    clearGame();
    renderEnd();
    showScreen("end");
  }
}

function startGame(withConfig: GameConfig): void {
  game = createGame(withConfig);
  active = emptyRow(game.config.codeLength);
  selectedSlot = 0;
  saveGame(game);
  renderGame();
  showScreen("game");
}

function resumeGame(): void {
  if (!game) return;
  active = emptyRow(game.config.codeLength);
  selectedSlot = 0;
  renderGame();
  showScreen("game");
}

// ---------------------------------------------------------------------------
// End screen
// ---------------------------------------------------------------------------
function renderEnd(): void {
  if (!game) return;
  const won = game.status === "won";

  byId("end-bar").textContent = won ? "Gelöst" : "Verloren";
  byId("end-glyph").textContent = won ? "◆" : "⊘";

  const title = byId("end-title");
  title.textContent = won ? "CODE GEKNACKT" : "KEINE VERSUCHE MEHR";
  title.className = `end-title ${won ? "win" : "lose"}`;

  byId("end-sub").textContent = won
    ? `Geknackt in ${game.guesses.length} von ${game.config.maxGuesses} Versuchen.`
    : "Alle Versuche aufgebraucht. Der Code bleibt geheim – versuch es nochmal.";

  const reveal = byId("reveal");
  reveal.replaceChildren();
  for (const colour of game.secret) reveal.append(pegEl(colour, "l"));

  const stats = byId("stats");
  stats.hidden = !won;
  if (won) {
    stats.replaceChildren();
    const cell = (big: string, label: string) => {
      const wrapper = document.createElement("div");
      wrapper.className = "stat";
      const value = document.createElement("div");
      value.className = "big";
      value.textContent = big;
      const lbl = document.createElement("div");
      lbl.className = "lbl";
      lbl.textContent = label;
      wrapper.append(value, lbl);
      return wrapper;
    };
    stats.append(
      cell(String(game.guesses.length), "Versuche"),
      cell(`${game.config.maxGuesses}`, "von max."),
    );
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function clamp(value: number, range: { min: number; max: number }): number {
  return Math.max(range.min, Math.min(range.max, value));
}

/** Keep the config self-consistent: a no-repeat code needs colours >= length. */
function enforce(candidate: GameConfig): GameConfig {
  const next = { ...candidate };
  next.colours = clamp(next.colours, LIMITS.colours);
  next.codeLength = clamp(next.codeLength, LIMITS.codeLength);
  next.maxGuesses = clamp(next.maxGuesses, LIMITS.maxGuesses);
  if (!next.allowRepeats && next.colours < next.codeLength) {
    next.colours = next.codeLength;
  }
  return next;
}

function renderSettings(): void {
  byId("val-colours").textContent = String(config.colours);
  byId("val-codeLength").textContent = String(config.codeLength);
  byId("val-maxGuesses").textContent = String(config.maxGuesses);

  const toggle = byId("toggle-repeats");
  toggle.classList.toggle("off", !config.allowRepeats);
  toggle.setAttribute("aria-checked", String(config.allowRepeats));

  const preview = byId("colours-preview");
  preview.replaceChildren();
  for (let colour = 0; colour < config.colours; colour++) {
    preview.append(pegEl(colour, "s"));
  }
}

/** A settings change starts fresh: discard any in-progress game (see reset-note). */
function onConfigChanged(next: GameConfig): void {
  config = enforce(next);
  saveConfig(config);
  clearGame();
  game = null;
  renderSettings();
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
function renderHome(): void {
  const canContinue = game !== null && game.status === "playing";
  (byId("btn-continue") as HTMLButtonElement).hidden = !canContinue;
}

function goHome(): void {
  renderHome();
  showScreen("home");
}

function openSettings(): void {
  renderSettings();
  showScreen("settings");
}

// ---------------------------------------------------------------------------
// Wiring + hub contract — called once at boot by the hub.
// ---------------------------------------------------------------------------
export function initCiphra(host: GameHost): GameController {
  const howto = byId<HTMLDialogElement>("howto");
  const openHowto = (): void => howto.showModal();

  byId("home-hub").addEventListener("click", host.onExit);
  byId("btn-new").addEventListener("click", () => startGame(config));
  byId("btn-continue").addEventListener("click", resumeGame);
  byId("btn-howto").addEventListener("click", openHowto);
  byId("home-settings").addEventListener("click", openSettings);

  byId("game-settings").addEventListener("click", openSettings);
  byId("game-back").addEventListener("click", goHome);
  byId("btn-undo").addEventListener("click", undoLast);
  byId("btn-check").addEventListener("click", check);

  byId("end-settings").addEventListener("click", openSettings);
  byId("end-back").addEventListener("click", goHome);
  byId("btn-again").addEventListener("click", () => startGame(game?.config ?? config));
  byId("btn-home").addEventListener("click", goHome);

  // Settings → back returns to the live game if it survived, else home.
  byId("settings-back").addEventListener("click", () => {
    // Return to a still-running game WITHOUT resetting the active row — peeking at
    // settings and backing out must not discard placed pegs. (A real config change
    // nulls `game` via onConfigChanged, so that path still starts a fresh game.)
    if (game && game.status === "playing") {
      renderGame();
      showScreen("game");
    } else {
      goHome();
    }
  });

  // Steppers — scoped to this game's view so sibling games' steppers stay untouched.
  const view = document.getElementById("view-ciphra")!;
  for (const stepper of view.querySelectorAll<HTMLElement>(".stepper")) {
    const setting = stepper.dataset.setting as keyof GameConfig;
    for (const button of stepper.querySelectorAll<HTMLButtonElement>(".step-btn")) {
      button.addEventListener("click", () => {
        const delta = Number(button.dataset.step);
        onConfigChanged({ ...config, [setting]: (config[setting] as number) + delta });
      });
    }
  }

  byId("toggle-repeats").addEventListener("click", () => {
    onConfigChanged({ ...config, allowRepeats: !config.allowRepeats });
  });

  byId("howto-close").addEventListener("click", () => howto.close());
  // Backdrop click closes the dialog (click lands on <dialog>, not its content).
  howto.addEventListener("click", (event) => {
    if (event.target === howto) howto.close();
  });

  renderSettings();

  return {
    activate: goHome,
    deactivate: () => {},
    hasRunningGame: () => game !== null && game.status === "playing",
  };
}
