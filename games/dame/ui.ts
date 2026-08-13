// Dame's DOM wiring and screen flow. All the rules live in game.ts (pure,
// tested); this file is the impure shell: rendering the 8×8 board, the
// select-then-move input, the AI turn loop, and localStorage. Element ids are
// prefixed `d-` so the game coexists with its siblings in the hub's single
// document.

import { APP_ID } from "../../shell/app.js";
import { safeGet, safeRemove, safeSet } from "../../shell/safe-storage.js";
import { isUndoAllowed, setUndoAllowed } from "../../shell/undo-lock.js";
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
const UNDO_LOCK_KEY = `${APP_ID}.dame.undo-lock`;

// How long the AI "thinks" before its move — avoids an instant, jarring reply.
// It also has to outlast the slide it follows: the AI's move rebuilds the board,
// which would cut the human's piece off mid-flight. 550ms lands 150ms before a
// one-cell slide ends (as it always has); a long flight pushes it out.
const AI_DELAY_MS = 550;
const SLIDE_LEAD_MS = 150;
// A one-cell hop reads well at 0.7s (`.moving` in style.scss), but a flying Dame
// crossing seven cells at the same duration looks teleported — so stretch the
// slide with the distance. Not linearly: full linear travel would crawl.
const SLIDE_BASE_MS = 700;
const SLIDE_PER_CELL_MS = 130;
const SLIDE_MAX_MS = 1500;
const slideMs = (cells: number): number =>
  Math.min(SLIDE_MAX_MS, SLIDE_BASE_MS + (cells - 1) * SLIDE_PER_CELL_MS);
// Breathing room between the hops of a multi-jump: the slide has to land before
// the next hop redraws the board.
const CONTINUE_GAP_MS = 100;
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
// States at the start of each human turn, for undo: one pop reverts the whole
// turn (all hops of a multi-jump) plus the AI reply that followed. Not persisted.
let history: GameState[] = [];
// Does the *running* game offer undo? Captured from the setting when the game
// starts and persisted alongside it, so flipping the setting mid-game — or
// relaunching the app — can't hand the button back.
let undoAllowed = isUndoAllowed(UNDO_LOCK_KEY);
// True while the AI's move is pending — the board is locked against input.
let aiThinking = false;
let aiTimer: ReturnType<typeof setTimeout> | undefined;
let endTimer: ReturnType<typeof setTimeout> | undefined;

// Move feedback so the AI's action is easy to follow: the last move's origin and
// destination stay glowing until the next move, the moved piece slides in from
// its origin, and a captured piece leaves a fading ghost so you see what was
// taken. `moveAnim` carries the slide offset (in % of a piece width) and is
// consumed after one render (Quadra's `lastDrop` trick), so it plays exactly once.
let lastMove: { from: Square | null; to: Square } | null = null;
let moveAnim: { at: Square; sx: number; sy: number; ms: number } | null = null;
// The slide currently playing — a multi-jump waits it out before the next hop.
let slideDuration = SLIDE_BASE_MS;
// A whole multi-jump's worth of pieces leaves the board at once, so this is a list.
let capturedGhosts: { at: Square; player: Player }[] = [];
let flashTimer: ReturnType<typeof setTimeout> | undefined;
// The ghosts fade in ~0.6s (`capture-flash`), but clearing them re-renders the
// board — so hold them until the slide they accompany has landed.
const CAPTURE_FLASH_MS = 720;
// One board cell = 125% of a piece's own width (the piece is 80% of the cell), so
// translating a piece by this per column/row moves it exactly one cell.
const SLIDE_UNIT = 125;

const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(`d-${id}`) as T;

const key = (square: Square): string => `${square.row},${square.col}`;
const sameSquare = (first: Square | null, second: Square | null): boolean =>
  first !== null && second !== null && first.row === second.row && first.col === second.col;

function setCapturedGhosts(ghosts: { at: Square; player: Player }[]): void {
  clearTimeout(flashTimer);
  capturedGhosts = ghosts;
  if (ghosts.length > 0) {
    flashTimer = setTimeout(
      () => {
        capturedGhosts = [];
        renderGame();
      },
      Math.max(CAPTURE_FLASH_MS, slideDuration + CONTINUE_GAP_MS),
    );
  }
}

function clearHighlights(): void {
  lastMove = null;
  moveAnim = null;
  setCapturedGhosts([]);
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
      if (interactive && lastMove) {
        if (sameSquare(lastMove.from, square)) cell.classList.add("last-from");
        if (sameSquare(lastMove.to, square)) cell.classList.add("last-to");
      }

      const piece = state.board[row][col];
      if (piece) {
        const disc = document.createElement("span");
        disc.className = `dame-piece ${piece.player}${piece.kind === "king" ? " king" : ""}`;
        // Jumped mid-chain but not swept off yet — mark it as already lost.
        if (state.pendingCaptures.some((pending) => sameSquare(pending, square))) {
          disc.classList.add("doomed");
        }
        if (interactive && moveAnim && sameSquare(moveAnim.at, square)) {
          disc.classList.add("moving");
          disc.style.setProperty("--slide-x", `${moveAnim.sx}%`);
          disc.style.setProperty("--slide-y", `${moveAnim.sy}%`);
          disc.style.setProperty("--slide-ms", `${moveAnim.ms}ms`);
        }
        cell.append(disc);
      } else if (interactive) {
        // The captured pieces are already gone from state — draw a fading ghost
        // of each so the player sees exactly which stones were taken.
        const ghost = capturedGhosts.find((candidate) => sameSquare(candidate.at, square));
        if (ghost) {
          const disc = document.createElement("span");
          disc.className = `dame-piece ${ghost.player} captured-ghost`;
          cell.append(disc);
        }
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
  if (mustCapture) {
    return state.maxCapture
      ? "Mehrschlagzwang — du musst die längste Folge schlagen."
      : "Schlagzwang — du musst schlagen.";
  }
  return "Wähle einen Stein und dann sein Ziel.";
}

// Update only the title + hint. Used when the AI is scheduled so the "KI denkt"
// text can change without rebuilding the board — a rebuild would cut off an
// in-flight slide.
function paintStatus(): void {
  if (!game) return;
  const title = byId("game-title");
  title.textContent = turnText(game);
  title.className = `title turn ${game.currentPlayer}`;
  byId("game-annot").textContent = annotText(game);
  byId("board-actions").hidden = !undoAllowed;
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
function onCellClick(square: Square): void {
  if (!game || game.status !== "playing" || aiThinking) return;
  if (isAiTurn(game)) return; // not the human's turn
  setCapturedGhosts([]); // a tap means the flash has served its purpose

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
  // Snapshot at the start of a human turn (not mid multi-jump), so one undo
  // reverts the whole chain — and the AI reply, which lands after the snapshot.
  const humanMover = game.mode === "local" || game.currentPlayer === game.humanPlayer;
  if (undoAllowed && humanMover && !game.mustContinueFrom) history.push(game);
  const mover = game.currentPlayer;
  const pendingBefore = game.pendingCaptures;
  game = applyMove(game, move);
  // Feedback: glow the path, slide the piece in from its origin, ghost the taken piece.
  lastMove = { from: move.from, to: move.to };
  slideDuration = slideMs(Math.abs(move.to.row - move.from.row));
  moveAnim = {
    at: move.to,
    sx: (move.from.col - move.to.col) * SLIDE_UNIT,
    sy: (move.from.row - move.to.row) * SLIDE_UNIT,
    ms: slideDuration,
  };
  // Captured pieces leave the board only when the turn ends — ghost them all then.
  const swept =
    game.pendingCaptures.length === 0
      ? [...pendingBefore, ...(move.captured ? [move.captured] : [])]
      : [];
  setCapturedGhosts(swept.map((at) => ({ at, player: otherPlayer(mover) })));

  if (game.status !== "playing") {
    clearGame(); // finished — don't offer "Fortsetzen"
    selected = null;
    renderGame(); // show the final position first
    endTimer = setTimeout(
      () => {
        renderEnd();
        showScreen("end");
      },
      // Never cut a long flight short.
      Math.max(END_DELAY_MS, slideDuration + 450),
    );
    return;
  }

  saveGame(game);
  // A capture that keeps the turn open pins the selection to the continuing
  // piece (for the human) or drives the next AI step.
  selected = game.mustContinueFrom;
  renderGame();
  maybeScheduleAi();
}

function undo(): void {
  const previous = history.pop();
  if (!previous) return;
  clearTimers(); // also cancels a pending AI reply or continuation hop
  clearHighlights();
  game = previous;
  // Normally null (snapshots are turn starts); a mid-chain snapshot seeded by
  // resumeGame keeps the continuing piece pinned, like resuming does.
  selected = game.mustContinueFrom;
  saveGame(game);
  renderGame();
}

/** If it's the AI's turn (including a multi-jump continuation), think and play. */
function maybeScheduleAi(): void {
  if (!game || game.status !== "playing" || !isAiTurn(game)) return;
  aiThinking = true;
  selected = null;
  // Only repaint the status text — the board is already rendered (and locked)
  // from the move that led here; a full rebuild would cut off its slide.
  paintStatus();
  // Either way the current slide has to land before the AI redraws the board.
  const gap = game.mustContinueFrom
    ? slideDuration + CONTINUE_GAP_MS
    : Math.max(AI_DELAY_MS, slideDuration - SLIDE_LEAD_MS);
  aiTimer = setTimeout(() => {
    aiThinking = false;
    if (!game || game.status !== "playing" || !isAiTurn(game)) return;
    step(getAiMove(game));
  }, gap);
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
// Setup screen — both modes pass through it, since the ruleset is configurable
// for a local game too; the KI-only panels are hidden in local mode.
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
  markSegment("seg-flying", settings.flyingKings ? "on" : "off");
  markSegment("seg-maxcapture", settings.maxCapture ? "on" : "off");
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
function startGame(
  mode: Mode,
  difficulty = settings.difficulty,
  humanFirst = true,
  flyingKings = settings.flyingKings,
  maxCapture = settings.maxCapture,
): void {
  clearTimers();
  clearHighlights();
  // Red always opens; the human takes red when they choose to go first.
  game = createGame({
    mode,
    difficulty,
    humanPlayer: humanFirst ? "red" : "black",
    flyingKings,
    maxCapture,
  });
  selected = null;
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
  clearHighlights();
  history = [];
  // Resumed mid multi-jump there's no turn-start state to snapshot, and the
  // continuation hops won't push one — seed the stack with the closest
  // reachable boundary so the first post-resume turn stays undoable.
  if (undoAllowed && game.mustContinueFrom) history.push(game);
  selected = game.mustContinueFrom;
  showScreen("game");
  renderGame();
  maybeScheduleAi(); // re-trigger the AI if it was its turn when we left
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
export function initDame(host: GameHost): GameController {
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

  byId("seg-flying").addEventListener("click", (event) => {
    const value = (event.target as HTMLElement).closest<HTMLButtonElement>(".seg")?.dataset.value;
    if (value !== "on" && value !== "off") return;
    settings = { ...settings, flyingKings: value === "on" };
    saveSettings(settings);
    renderSetup();
  });

  byId("seg-maxcapture").addEventListener("click", (event) => {
    const value = (event.target as HTMLElement).closest<HTMLButtonElement>(".seg")?.dataset.value;
    if (value !== "on" && value !== "off") return;
    settings = { ...settings, maxCapture: value === "on" };
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
    startGame(
      game.mode,
      game.difficulty,
      game.humanPlayer === "red",
      game.flyingKings,
      game.maxCapture,
    );
  });

  byId("end-back").addEventListener("click", goHome);
  byId("btn-home").addEventListener("click", goHome);
  byId("btn-again").addEventListener("click", () => {
    if (!game) return;
    startGame(
      game.mode,
      game.difficulty,
      game.humanPlayer === "red",
      game.flyingKings,
      game.maxCapture,
    );
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
