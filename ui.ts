// Hub entry: hash router, startpage, and the offline-readiness badge. Each game
// lives in games/<id>/ui.ts behind the GameController contract and owns its own
// screens inside its <section class="view"> in index.html; this file only
// decides which view is visible and dresses the document (title, theme class,
// theme-color) per route.

import {
  observeOfflineReadiness,
  type OfflineStatus,
} from "@tklepzig/offline-kit";

import { APP_ID, APP_NAME } from "./shell/app.js";
import { safeGet, safeSet } from "./shell/safe-storage.js";
import type { GameController } from "./shell/game-controller.js";
import { initQuadra } from "./games/quadra/ui.js";
import { initCiphra } from "./games/ciphra/ui.js";
import { initDame } from "./games/dame/ui.js";
import { initMuehle } from "./games/muehle/ui.js";
import { initHalma } from "./games/halma/ui.js";
import { initSolohalma } from "./games/solohalma/ui.js";

type GameId = "quadra" | "ciphra" | "dame" | "muehle" | "halma" | "solohalma";
type ViewId = "hub" | GameId;

interface GameEntry {
  id: GameId;
  name: string;
  /** Body class carrying the game's Ada theme override (null = hub theme). */
  themeClass: string | null;
  /** Android status-bar tint while inside the game (dark / light theme). */
  themeColor: string;
  themeColorLight: string;
  controller: GameController;
}

const HUB_THEME_COLOR = "#0d1424";
const HUB_THEME_COLOR_LIGHT = "#eef1f8";
const THEME_KEY = `${APP_ID}.theme`;

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
    themeColorLight: HUB_THEME_COLOR_LIGHT,
    controller: initQuadra({ onExit: goHub }),
  },
  {
    id: "ciphra",
    name: "Ciphra",
    themeClass: "theme-ciphra",
    themeColor: "#23400f",
    themeColorLight: "#edf6ed",
    controller: initCiphra({ onExit: goHub }),
  },
  {
    id: "dame",
    name: "Dame",
    themeClass: "theme-dame",
    themeColor: "#0e2830",
    themeColorLight: "#eaf3f8",
    controller: initDame({ onExit: goHub }),
  },
  {
    id: "muehle",
    name: "Mühle",
    themeClass: "theme-muehle",
    themeColor: "#0e2a2c",
    themeColorLight: "#eaf5f6",
    controller: initMuehle({ onExit: goHub }),
  },
  {
    id: "halma",
    name: "Halma",
    themeClass: "theme-halma",
    themeColor: "#20240f",
    themeColorLight: "#f1f4ea",
    controller: initHalma({ onExit: goHub }),
  },
  {
    id: "solohalma",
    name: "Solo-Halma",
    themeClass: "theme-solohalma",
    themeColor: "#1a1c3a",
    themeColorLight: "#f0eff8",
    controller: initSolohalma({ onExit: goHub }),
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

// ---------------------------------------------------------------------------
// Light/dark theme — one app-wide switch (hub appbar), persisted. The colour
// work happens in CSS (body.light inverts the shade ramp); here we only toggle
// the class and keep the Android status-bar tint in step.
// ---------------------------------------------------------------------------
let lightTheme = safeGet(THEME_KEY) === "light";
const themeToggleEl = byId<HTMLButtonElement>("theme-toggle");

function themeColorFor(entry: GameEntry | null): string {
  if (lightTheme) return entry?.themeColorLight ?? HUB_THEME_COLOR_LIGHT;
  return entry?.themeColor ?? HUB_THEME_COLOR;
}

function applyTheme(): void {
  document.body.classList.toggle("light", lightTheme);
  // The button shows what a press switches TO. Labels stay English on purpose
  // ("Light/Dark Theme" as a term of art, like the offline status strings).
  themeToggleEl.textContent = lightTheme ? "☾" : "☀";
  themeToggleEl.setAttribute(
    "aria-label",
    lightTheme ? "Dark Theme" : "Light Theme",
  );
  themeColorMeta.content = themeColorFor(activeGame);
}

themeToggleEl.addEventListener("click", () => {
  lightTheme = !lightTheme;
  safeSet(THEME_KEY, lightTheme ? "light" : "dark");
  applyTheme();
});

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
  themeColorMeta.content = themeColorFor(entering);
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

// Strings stay English — this is infrastructure status, not game UI.
const paintOfflineStatus = ({ state, missing }: OfflineStatus): void => {
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

// A re-check often lands back on the same "ready" state, so without explicit
// feedback the ↻ press looks like it did nothing. Spin the button and hold a
// "Checking …" label for a beat, then show the result (flashing "✓ Updated" when
// it's ready) so the click always reads as an action.
let lastOfflineStatus: OfflineStatus = { state: "caching", missing: [] };
let refreshing = false;

const renderOfflineStatus = (status: OfflineStatus): void => {
  lastOfflineStatus = status;
  if (!refreshing) paintOfflineStatus(status); // hold "Checking …" while refreshing
};

const readiness = observeOfflineReadiness({ onStatus: renderOfflineStatus });

offlineRefreshEl.addEventListener("click", () => {
  if (refreshing) return;
  refreshing = true;
  offlineRefreshEl.classList.add("spinning");
  offlineStatusEl.classList.remove("ready", "warn");
  offlineStatusEl.hidden = false;
  offlineStatusEl.textContent = "Checking …";
  readiness.refresh();
  window.setTimeout(() => {
    refreshing = false;
    offlineRefreshEl.classList.remove("spinning");
    if (lastOfflineStatus.state === "ready") {
      offlineStatusEl.classList.add("ready");
      offlineStatusEl.textContent = "✓ Updated";
      window.setTimeout(() => {
        if (!refreshing) paintOfflineStatus(lastOfflineStatus);
      }, 1100);
    } else {
      paintOfflineStatus(lastOfflineStatus);
    }
  }, 900);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.addEventListener("hashchange", render);
applyTheme();
render();
