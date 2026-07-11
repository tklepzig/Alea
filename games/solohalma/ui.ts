// Solo-Halma's DOM wiring and screen flow. The rules live in game.ts (pure,
// tested); this file renders the cross board, handles the tap-a-peg → tap-a-hole
// input, keeps an undo stack, and persists to localStorage. It's a single-player
// puzzle, so there's no AI, opponent, or setup screen. Element ids are prefixed
// `s-`.

import { APP_ID } from "../../shell/app.js";
import { safeGet, safeRemove, safeSet } from "../../shell/safe-storage.js";
import type { GameController, GameHost } from "../../shell/game-controller.js";
import {
  SIZE,
  isHole,
  createBoard,
  legalMoves,
  movesFrom,
  applyMove,
  pegCount,
  statusOf,
  isCenterFinish,
  type Board,
  type Move,
  type Square,
} from "./game.js";
import { serializeGame, deserializeGame } from "./storage.js";

const GAME_KEY = `${APP_ID}.solohalma.game`;

const END_DELAY_MS = 1000;

function loadGame(): Board | null {
  return deserializeGame(safeGet(GAME_KEY));
}
function saveGame(board: Board): void {
  safeSet(GAME_KEY, serializeGame(board));
}
function clearGame(): void {
  safeRemove(GAME_KEY);
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let board: Board | null = loadGame();
// The peg the player has picked up, whose jumps are highlighted.
let selected: Square | null = null;
// Previous boards, for undo. Not persisted (a resumed puzzle starts fresh undo).
let history: Board[] = [];
let endTimer: ReturnType<typeof setTimeout> | undefined;

const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(`s-${id}`) as T;

const key = (square: Square): string => `${square.row},${square.col}`;

function clearTimers(): void {
  clearTimeout(endTimer);
  endTimer = undefined;
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
type ScreenName = "home" | "game" | "end";

function showScreen(name: ScreenName): void {
  for (const screen of ["home", "game", "end"] as const) {
    byId(`screen-${screen}`).hidden = screen !== name;
  }
}

// ---------------------------------------------------------------------------
// Board rendering
// ---------------------------------------------------------------------------
function renderBoard(container: HTMLElement, current: Board, interactive: boolean): void {
  const locked = !interactive || statusOf(current) !== "playing";
  container.classList.toggle("locked", locked);
  container.replaceChildren();

  const targets = new Set(
    selected ? movesFrom(current, selected).map((move) => key(move.to)) : [],
  );
  const jumpable = new Set(
    interactive && !locked && !selected
      ? legalMoves(current).map((move) => key(move.from))
      : [],
  );

  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const square: Square = { row, col };
      if (!isHole(row, col)) {
        const spacer = document.createElement("div");
        spacer.className = "sw"; // cut corner — an invisible spacer keeps the grid square
        container.append(spacer);
        continue;
      }

      const hole = document.createElement(interactive ? "button" : "div");
      hole.className = "sh";
      if (interactive) {
        const button = hole as HTMLButtonElement;
        button.type = "button";
        button.disabled = locked;
        button.setAttribute("aria-label", `Feld ${col + 1}/${row + 1}`);
        button.addEventListener("click", () => onHoleClick(square));
      }

      if (selected && selected.row === row && selected.col === col) hole.classList.add("selected");
      if (targets.has(key(square))) hole.classList.add("target");

      if (current[row][col] === "peg") {
        const peg = document.createElement("span");
        peg.className = "solo-peg";
        if (jumpable.has(key(square))) peg.classList.add("jumpable");
        hole.append(peg);
      }
      container.append(hole);
    }
  }
}

// ---------------------------------------------------------------------------
// Game screen
// ---------------------------------------------------------------------------
function renderGame(): void {
  if (!board) return;
  const remaining = pegCount(board);
  byId("game-title").textContent = `Noch ${remaining} ${remaining === 1 ? "Stein" : "Steine"}`;
  byId("game-annot").textContent = selected
    ? "Tippe ein markiertes Feld zum Springen."
    : "Tippe einen Stein, der springen kann.";
  (byId("btn-undo") as HTMLButtonElement).disabled = history.length === 0;
  renderBoard(byId("board"), board, true);
}

// ---------------------------------------------------------------------------
// Turn loop
// ---------------------------------------------------------------------------
function onHoleClick(square: Square): void {
  if (!board || statusOf(board) !== "playing") return;

  // Tapping a highlighted destination plays the jump.
  if (selected) {
    const move = movesFrom(board, selected).find(
      (candidate) => candidate.to.row === square.row && candidate.to.col === square.col,
    );
    if (move) {
      play(move);
      return;
    }
  }
  // Otherwise (re)select a peg that can actually jump.
  const canJump = board[square.row][square.col] === "peg" && movesFrom(board, square).length > 0;
  selected = canJump ? square : null;
  renderGame();
}

function play(move: Move): void {
  if (!board) return;
  history.push(board);
  board = applyMove(board, move);
  selected = null;

  const status = statusOf(board);
  if (status !== "playing") {
    clearGame(); // finished — don't offer "Fortsetzen"
    renderGame();
    endTimer = setTimeout(() => {
      renderEnd();
      showScreen("end");
    }, END_DELAY_MS);
    return;
  }
  saveGame(board);
  renderGame();
}

function undo(): void {
  const previous = history.pop();
  if (!board || !previous) return;
  board = previous;
  selected = null;
  saveGame(board);
  renderGame();
}

// ---------------------------------------------------------------------------
// End screen
// ---------------------------------------------------------------------------
function renderEnd(): void {
  if (!board) return;
  const remaining = pegCount(board);
  const solved = remaining === 1;
  const centre = isCenterFinish(board);

  byId("end-bar").textContent = solved ? "Gelöst" : "Festgefahren";

  const glyph = byId("end-glyph");
  glyph.textContent = solved ? "★" : "◐";
  glyph.className = `end-glyph ${solved ? "win" : "stuck"}`;

  const title = byId("end-title");
  if (centre) {
    title.textContent = "PERFEKT GELÖST";
    title.className = "end-title win";
  } else if (solved) {
    title.textContent = "GELÖST";
    title.className = "end-title win";
  } else {
    title.textContent = "FESTGEFAHREN";
    title.className = "end-title lose";
  }

  byId("end-sub").textContent = centre
    ? "Ein einziger Stein — und genau in der Mitte. Meisterhaft!"
    : solved
      ? "Nur noch ein Stein übrig. Schaffst du ihn beim nächsten Mal in die Mitte?"
      : `Noch ${remaining} Steine, aber kein Sprung mehr möglich. Neuer Versuch?`;

  renderBoard(byId("end-board"), board, false);
}

// ---------------------------------------------------------------------------
// Home screen
// ---------------------------------------------------------------------------
function renderHome(): void {
  (byId("btn-continue") as HTMLButtonElement).hidden = board === null || statusOf(board) !== "playing";
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function startGame(): void {
  clearTimers();
  board = createBoard();
  selected = null;
  history = [];
  saveGame(board);
  showScreen("game");
  renderGame();
}

function resumeGame(): void {
  if (!board) return;
  clearTimers();
  selected = null;
  history = [];
  showScreen("game");
  renderGame();
}

function goHome(): void {
  clearTimers();
  selected = null;
  renderHome();
  showScreen("home");
}

// ---------------------------------------------------------------------------
// Wiring + hub contract — called once at boot by the hub.
// ---------------------------------------------------------------------------
export function initSolohalma(host: GameHost): GameController {
  const howto = byId<HTMLDialogElement>("howto");

  byId("home-hub").addEventListener("click", host.onExit);
  byId("btn-new").addEventListener("click", startGame);
  byId("btn-continue").addEventListener("click", resumeGame);
  byId("btn-howto").addEventListener("click", () => howto.showModal());

  byId("game-back").addEventListener("click", goHome);
  byId("game-restart").addEventListener("click", startGame);
  byId("btn-undo").addEventListener("click", undo);

  byId("end-back").addEventListener("click", goHome);
  byId("btn-home").addEventListener("click", goHome);
  byId("btn-again").addEventListener("click", startGame);

  byId("howto-close").addEventListener("click", () => howto.close());
  howto.addEventListener("click", (event) => {
    if (event.target === howto) howto.close();
  });

  return {
    activate: goHome,
    deactivate: clearTimers,
    hasRunningGame: () => board !== null && statusOf(board) === "playing",
  };
}
