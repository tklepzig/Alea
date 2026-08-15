// Halma's DOM wiring and screen flow. The rules live in game.ts (pure, tested);
// this file renders the 10×10 board, handles select→step/jump input (including
// human jump-chains that the player ends by tapping the moving piece), and
// replays the AI's whole turn hop by hop. Element ids are prefixed `h-`.

import { APP_ID } from "../../shell/app.js";
import { safeGet, safeRemove, safeSet } from "../../shell/safe-storage.js";
import { isUndoAllowed, setUndoAllowed } from "../../shell/undo-lock.js";
import type { GameController, GameHost } from "../../shell/game-controller.js";
import {
  SIZE,
  createGame,
  applyMove,
  legalMoves,
  targetCamp,
  otherPlayer,
  type GameState,
  type Mode,
  type Move,
  type Player,
  type Square,
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

const GAME_KEY = `${APP_ID}.halma.game`;
const SETTINGS_KEY = `${APP_ID}.halma.settings`;
const UNDO_LOCK_KEY = `${APP_ID}.halma.undo-lock`;

// The AI "thinks" briefly, then plays its move; a multi-hop jump animates one
// hop at a time.
const AI_DELAY_MS = 550;
// Gap between jump hops — long enough for each hop's slide (~0.7s, see `.moving`
// in style.scss) to finish before the next hop redraws the board.
const AI_HOP_MS = 800;
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

const RED_CAMP = targetCamp("blue"); // top-left (blue's target, red's home)
const BLUE_CAMP = targetCamp("red"); // bottom-right

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let settings: Settings = loadSettings();
let game: GameState | null = loadGame();
// The piece the human has picked up (moving), or the piece mid jump-chain.
let selected: Square | null = null;
// States at the start of each human turn, for undo: one pop reverts the whole
// jump-chain plus the AI reply that followed. Not persisted.
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

// Move feedback: the last hop's origin and destination stay lit until the next
// move, and the moved stone slides in from its origin — so a multi-hop AI turn
// is easy to follow. (Halma has no captures, so no capture ghost.) `moveAnim`
// carries the slide offset and is consumed after one render, so it plays once.
let lastMove: { from: Square; to: Square } | null = null;
let moveAnim: { at: Square; sx: number; sy: number } | null = null;
// One cell = 100/84 × 100% of a stone's width (the stone is 84% of the cell).
const SLIDE_UNIT = (100 / 84) * 100;

const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(`h-${id}`) as T;

const cellKey = (square: Square): string => `${square.row},${square.col}`;
const sameSquare = (first: Square | null, second: Square | null): boolean =>
  first !== null && second !== null && first.row === second.row && first.col === second.col;

function clearHighlights(): void {
  lastMove = null;
  moveAnim = null;
}

function noteMove(move: Move): void {
  if (move.kind === "step" || move.kind === "jump") {
    lastMove = { from: move.from, to: move.to };
    moveAnim = {
      at: move.to,
      sx: (move.from.col - move.to.col) * SLIDE_UNIT,
      sy: (move.from.row - move.to.row) * SLIDE_UNIT,
    };
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
  aiTimer = undefined;
  endTimer = undefined;
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

  const moves = interactive && !locked ? legalMoves(state) : [];
  const fromSel = (move: Move): boolean =>
    (move.kind === "step" || move.kind === "jump") &&
    selected !== null &&
    move.from.row === selected.row &&
    move.from.col === selected.col;

  const stepTargets = new Set(
    selected ? moves.filter((move) => move.kind === "step" && fromSel(move)).map((move) => (move.kind === "step" ? cellKey(move.to) : "")) : [],
  );
  const jumpTargets = new Set(
    moves.filter((move) => move.kind === "jump" && (state.jumpingFrom ? true : fromSel(move))).map((move) => (move.kind === "jump" ? cellKey(move.to) : "")),
  );
  const hasFrom = (move: Move): move is Extract<Move, { from: Square }> => move.kind !== "end";
  const movable = new Set(
    !state.jumpingFrom && selected === null
      ? moves.filter(hasFrom).map((move) => cellKey(move.from))
      : [],
  );

  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const square: Square = { row, col };
      const cell = document.createElement(interactive ? "button" : "div");
      cell.className = "hc";
      if (RED_CAMP.has(cellKey(square))) cell.classList.add("camp-red");
      if (BLUE_CAMP.has(cellKey(square))) cell.classList.add("camp-blue");

      if (interactive) {
        const button = cell as HTMLButtonElement;
        button.type = "button";
        button.disabled = locked;
        button.setAttribute("aria-label", `Feld ${col + 1}/${row + 1}`);
        button.addEventListener("click", () => onCellClick(square));
      }

      if (selected && selected.row === row && selected.col === col) {
        cell.classList.add(state.jumpingFrom ? "chain" : "selected");
      }
      if (stepTargets.has(cellKey(square))) cell.classList.add("target");
      if (jumpTargets.has(cellKey(square))) cell.classList.add("jump-target");
      if (movable.has(cellKey(square))) cell.classList.add("movable");
      if (interactive && lastMove) {
        if (sameSquare(lastMove.from, square)) cell.classList.add("last-from");
        if (sameSquare(lastMove.to, square)) cell.classList.add("last-to");
      }

      const owner = state.board[row][col];
      if (owner) {
        const stone = document.createElement("span");
        stone.className = `halma-stone ${owner}`;
        if (interactive && moveAnim && sameSquare(moveAnim.at, square)) {
          stone.classList.add("moving");
          stone.style.setProperty("--slide-x", `${moveAnim.sx}%`);
          stone.style.setProperty("--slide-y", `${moveAnim.sy}%`);
        }
        cell.append(stone);
      }
      container.append(cell);
    }
  }
}

// ---------------------------------------------------------------------------
// Game screen text
// ---------------------------------------------------------------------------
function turnText(state: GameState): string {
  if (aiFailed) return "KI-Fehler";
  if (state.mode === "ai") {
    return state.currentPlayer === state.humanPlayer ? "Du bist dran" : "KI denkt …";
  }
  return state.currentPlayer === "red" ? "Rot ist dran" : "Blau ist dran";
}

function annotText(state: GameState): string {
  if (aiFailed) return `${aiFailed} Tippe auf „Nochmal“.`;
  if (aiThinking) return "";
  if (state.jumpingFrom) return "Weiter springen — oder tippe deinen Stein, um den Zug zu beenden.";
  return "Wähle einen Stein: ein Schritt oder ein Sprung ins Ziel.";
}

// Update only the title + hint — used when scheduling the AI so its "denkt" text
// can change without a board rebuild cutting off an in-flight slide.
function paintStatus(): void {
  if (!game) return;
  const title = byId("game-title");
  title.textContent = turnText(game);
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
// Turn loop — human
// ---------------------------------------------------------------------------
function goToEnd(): void {
  clearGame();
  selected = null;
  renderGame();
  endTimer = setTimeout(() => {
    renderEnd();
    showScreen("end");
  }, END_DELAY_MS);
}

function humanMove(move: Move): void {
  if (!game) return;
  // Snapshot at the start of the turn (not mid jump-chain), so one undo reverts
  // the whole chain — and the AI reply, which lands after the snapshot.
  if (undoAllowed && !game.jumpingFrom) history.push(game);
  game = applyMove(game, move);
  noteMove(move);

  if (game.status !== "playing") {
    goToEnd();
    return;
  }

  if (game.jumpingFrom) {
    // The chain continues. If no further jump is possible, end the turn for the
    // player; otherwise keep the piece picked up and wait for their choice.
    selected = game.jumpingFrom;
    const canContinue = legalMoves(game).some((candidate) => candidate.kind === "jump");
    if (!canContinue) {
      humanMove({ kind: "end" });
      return;
    }
    renderGame();
    return;
  }

  selected = null;
  saveGame(game);
  renderGame();
  maybeScheduleAi();
}

function onCellClick(square: Square): void {
  if (!game || game.status !== "playing" || aiThinking || isAiTurn(game)) return;
  const moves = legalMoves(game);

  if (game.jumpingFrom) {
    const jump = moves.find(
      (move) => move.kind === "jump" && move.to.row === square.row && move.to.col === square.col,
    );
    if (jump) {
      humanMove(jump);
      return;
    }
    // Tapping the moving piece itself ends the turn.
    if (game.jumpingFrom.row === square.row && game.jumpingFrom.col === square.col) {
      humanMove({ kind: "end" });
    }
    return;
  }

  if (selected) {
    const move = moves.find(
      (candidate) =>
        (candidate.kind === "step" || candidate.kind === "jump") &&
        candidate.from.row === selected!.row &&
        candidate.from.col === selected!.col &&
        candidate.to.row === square.row &&
        candidate.to.col === square.col,
    );
    if (move) {
      humanMove(move);
      return;
    }
  }
  const ownMovable = moves.some(
    (move) => (move.kind === "step" || move.kind === "jump") && move.from.row === square.row && move.from.col === square.col,
  );
  selected = ownMovable ? square : null;
  renderGame();
}

function undo(): void {
  const previous = history.pop();
  if (!previous) return;
  clearTimers(); // also cancels a pending AI reply or hop replay
  clearHighlights();
  game = previous;
  selected = null;
  saveGame(game);
  renderGame();
}

// ---------------------------------------------------------------------------
// Turn loop — AI (replays a full turn, one hop at a time)
// ---------------------------------------------------------------------------
function maybeScheduleAi(): void {
  if (!game || game.status !== "playing" || !isAiTurn(game)) return;
  aiThinking = true;
  selected = null;
  // Repaint only the status text — the board is already rendered (and locked)
  // from the move that led here; a rebuild would cut off its slide.
  paintStatus();
  aiTimer = setTimeout(() => {
    if (!game || game.status !== "playing" || !isAiTurn(game)) {
      aiThinking = false;
      if (game) renderGame();
      return;
    }
    const asked = ++aiGeneration;
    const current = game;
    // Halma's engine answers with a whole turn — a path of hops the UI replays.
    requestAiMove("halma", current)
      .then((path) => {
        if (aiGeneration !== asked) return;
        playPath(path, 0);
      })
      .catch((error: unknown) => {
        if (aiGeneration !== asked || error instanceof AiCancelledError) return;
        aiThinking = false;
        if (!(error instanceof AiUnavailableError)) console.error("Halma AI:", error);
        aiFailed =
          error instanceof AiUnavailableError
            ? error.message
            : "Die KI konnte nicht ziehen.";
        renderGame();
      });
  }, AI_DELAY_MS);
}

/** Ask the AI again after a failure — the position is unchanged. */
function retryAi(): void {
  if (!game || game.status !== "playing" || !isAiTurn(game)) return;
  aiFailed = null;
  renderGame();
  maybeScheduleAi();
}

function playPath(path: Move[], index: number): void {
  // Every other exit clears aiThinking; this one has to as well. An empty path
  // (or a game that vanished under us) would otherwise leave the board locked
  // with the AI apparently still thinking and nothing scheduled — the precise
  // stuck state this whole change exists to remove.
  if (!game || index >= path.length) {
    aiThinking = false;
    if (game) renderGame();
    return;
  }
  game = applyMove(game, path[index]);
  noteMove(path[index]);

  const last = index + 1 >= path.length;
  if (game.status !== "playing") {
    aiThinking = false;
    goToEnd();
    return;
  }
  if (last) {
    aiThinking = false;
    selected = null;
    saveGame(game);
    renderGame();
    maybeScheduleAi(); // no-op unless both sides are AI
    return;
  }
  renderGame(); // show the intermediate hop; board stays locked
  aiTimer = setTimeout(() => playPath(path, index + 1), AI_HOP_MS);
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

  byId("end-sub").textContent =
    game.mode === "ai"
      ? humanWon
        ? "Alle deine Steine stehen im Ziel — stark!"
        : "Die KI war zuerst drüben. Revanche?"
      : `${playerLabel(game.winner)} hat alle Steine ins gegnerische Lager gebracht.`;

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
export function initHalma(host: GameHost): GameController {
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
