// Hub entry: hash router, startpage, and the offline-readiness badge. Each game
// lives in games/<id>/ui.ts behind the GameController contract and owns its own
// screens inside its <section class="view"> in index.html; this file only
// decides which view is visible and dresses the document (title, theme class,
// theme-color) per route.

import {
  observeOfflineReadiness,
  type OfflineStatus,
} from "@tklepzig/offline-kit";

import { APP_NAME } from "./shell/app.js";
import type { GameController } from "./shell/game-controller.js";
import { initQuadra } from "./games/quadra/ui.js";
import { initCiphra } from "./games/ciphra/ui.js";

type GameId = "quadra" | "ciphra";
type ViewId = "hub" | GameId;

interface GameEntry {
  id: GameId;
  name: string;
  /** Body class carrying the game's Ada theme override (null = hub theme). */
  themeClass: string | null;
  /** Android status-bar tint while inside the game. */
  themeColor: string;
  controller: GameController;
}

const HUB_THEME_COLOR = "#0d1424";

const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

function goHub(): void {
  navigate("hub");
}

// Games initialise (wire their DOM) once at boot; the router only toggles them.
const games: GameEntry[] = [
  {
    id: "quadra",
    name: "Quadra",
    themeClass: null, // shares the hub's blue theme
    themeColor: "#0a2a5e",
    controller: initQuadra({ onExit: goHub }),
  },
  {
    id: "ciphra",
    name: "Ciphra",
    themeClass: "theme-ciphra",
    themeColor: "#23400f",
    controller: initCiphra({ onExit: goHub }),
  },
];

// ---------------------------------------------------------------------------
// Router — "#/" is the hub, "#/<gameId>" a game. Unknown hashes fall back to
// the hub, so a stale bookmark can never strand the user on a blank page.
// ---------------------------------------------------------------------------
function parseView(): ViewId {
  const hash = location.hash.replace(/^#\/?/, "");
  return games.some((game) => game.id === hash) ? (hash as ViewId) : "hub";
}

function navigate(view: ViewId): void {
  location.hash = view === "hub" ? "/" : `/${view}`;
}

const themeColorMeta = document.querySelector<HTMLMetaElement>(
  'meta[name="theme-color"]',
)!;

let activeGame: GameEntry | null = null;

function render(): void {
  const view = parseView();
  const entering = games.find((game) => game.id === view) ?? null;
  if (entering === activeGame && view !== "hub") return; // hash noise within a game

  if (activeGame && activeGame !== entering) activeGame.controller.deactivate();

  byId("view-hub").hidden = entering !== null;
  for (const game of games) {
    byId(`view-${game.id}`).hidden = game !== entering;
  }

  const themeClasses = games.flatMap((game) => (game.themeClass ? [game.themeClass] : []));
  document.body.classList.remove(...themeClasses);
  if (entering?.themeClass) document.body.classList.add(entering.themeClass);
  themeColorMeta.content = entering?.themeColor ?? HUB_THEME_COLOR;
  document.title = entering ? `${entering.name} · ${APP_NAME}` : APP_NAME;

  if (entering) {
    entering.controller.activate();
  } else {
    renderHub();
  }
  activeGame = entering;
}

// ---------------------------------------------------------------------------
// Hub startpage
// ---------------------------------------------------------------------------
function renderHub(): void {
  for (const game of games) {
    byId(`chip-${game.id}`).hidden = !game.controller.hasRunningGame();
  }
}

for (const game of games) {
  byId(`card-${game.id}`).addEventListener("click", () => navigate(game.id));
}

// ---------------------------------------------------------------------------
// Offline-ready indicator (hub panel footer, always visible). The lifecycle
// (registration, readiness query, state machine) lives in @tklepzig/offline-kit;
// here we only render the emitted state into the badge. Strings stay English
// (infrastructure status). The ↻ button re-runs the readiness check — since
// offline-kit 0.1.2 that also repairs any missing precache entries in place.
// ---------------------------------------------------------------------------
const offlineStatusEl = byId("offline-status");
const offlineRefreshEl = byId<HTMLButtonElement>("offline-refresh");

const renderOfflineStatus = ({ state, missing }: OfflineStatus): void => {
  offlineStatusEl.classList.toggle("ready", state === "ready");
  offlineStatusEl.classList.toggle(
    "warn",
    state === "incomplete" || state === "unavailable",
  );
  offlineStatusEl.hidden = false;
  offlineRefreshEl.hidden = state === "unavailable"; // no worker to re-ask
  if (state === "ready") {
    offlineStatusEl.textContent = "✓ Offline ready";
  } else if (state === "incomplete") {
    const names = missing.map((url) => url.replace(/^\.\//, "")).join(", ");
    offlineStatusEl.textContent = `Offline cache incomplete — missing: ${names}`;
  } else if (state === "unavailable") {
    offlineStatusEl.textContent = "Service worker failed — offline unavailable";
  } else {
    offlineStatusEl.textContent = "Caching…";
  }
};

const readiness = observeOfflineReadiness({ onStatus: renderOfflineStatus });
offlineRefreshEl.addEventListener("click", () => readiness.refresh());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.addEventListener("hashchange", render);
render();
