---
name: add-game
description: >-
  Checklist for adding a new game to this Alea multi-game PWA hub. Use whenever
  the user wants to add, port, integrate, or build another game in this repo —
  "add a new game", "port <game> into the hub", "neues Spiel hinzufügen",
  "create game #3" — even if they don't say "game" but describe a new playable
  module with its own screens. Not for changes to existing games, hub-only UI
  work, or @tklepzig/offline-kit changes.
---

# Add a game to Alea

Adding a game is mechanical if you follow the existing pattern (Quadra `q-` and
Ciphra `c-` are the reference implementations; Dame, Schach, Mühle, Halma and
Solo-Halma follow the same shape). The offline pipeline needs **no
changes** — the precache manifest is glob-generated from built output, so new
code/assets are picked up automatically. Everything below exists because all
games share ONE document: collisions are the failure mode to design against.

## 0. Decide upfront

- `<id>`: lowercase module name (e.g. `quadra`) and an unused id prefix. Taken so
  far: `q-` (Quadra), `c-` (Ciphra), `d-` (Dame), `x-` (Schach), `m-` (Mühle),
  `h-` (Halma), `s-` (Solo-Halma) — pick a free letter, not necessarily the
  game's initial (Schach took `x-` because Ciphra already held `c-`).
- German display name + one-line tagline for the hub card. If the game gets a
  family-style name, follow the scheme: 2–3 syllables, soft `-a` ending,
  mythology/Latin, hidden tie to what the game does.
- Theme: default is the hub's Ada blue. A game with its own identity gets a
  scoped theme (step 5) — pick an oklch hue.

## 1. Pure logic + persistence (`games/<id>/`)

- `game.ts` — rules only: no DOM, no storage, deterministic via an injectable
  `RandomFn` so it's fully unit-testable. `game.test.ts` alongside.
- `storage.ts` — (de)serialisation as pure string↔object functions using the
  `{ v: SCHEMA_VERSION, data }` envelope; every deserialize validates
  defensively and returns `null` on anything it can't fully trust (corrupt JSON,
  old schema, impossible state), so the caller falls back to a fresh start.
  `storage.test.ts` alongside.
- Add the four files to the `include` list in `tsconfig.test.json`.

## 2. Markup (`index.html`)

- New `<section class="view view-<id>" id="view-<id>" hidden>` with the game's
  screens (`<p>-screen-home`, `<p>-screen-game`, …).
- **Every element id inside the view carries the prefix** — ids are
  document-global and the sibling games already use the unprefixed names.
- Home screen appbar: left button `<p>-home-hub` (`←`, aria-label "Zur
  Spieleauswahl") — the exit to the hub.
- `<dialog>`s (how-to etc.) live INSIDE the view section: a modal whose ancestor
  is `display: none` doesn't render, and only the active view is visible — so
  this placement is both safe and required for scoped styling.

## 3. Game UI module (`games/<id>/ui.ts`)

- Prefixed lookup helper — game code keeps using logical ids:

  ```ts
  const byId = <T extends HTMLElement>(id: string): T =>
    document.getElementById(`<p>-${id}`) as T;
  ```

- Module-level state; all event wiring inside the exported
  `init<Name>(host: GameHost): GameController` (see `shell/game-controller.ts`),
  called once at boot by the hub. Return:
  - `activate()` → show the home screen and recompute "Fortsetzen"
  - `deactivate()` → clear timers / transient state (route left mid-game)
  - `hasRunningGame()` → drives the hub card's "Spiel läuft" chip
- Class-based queries (steppers, segments, …) must be scoped to
  `document.getElementById("view-<id>")` — a document-wide
  `querySelectorAll(".stepper")` grabs sibling games' controls.
- Persistence via `shell/safe-storage.ts`, keys namespaced
  `` `${APP_ID}.<id>.<what>` `` (APP_ID from `shell/app.ts`). Persist only
  in-progress games; clear on finish so "Fortsetzen" is honest.
- German UI strings; infrastructure strings (offline status etc.) stay English.

## 4. Register with the hub

- `index.html`: game card in the hub view —
  `<button class="game-card" id="card-<id>">` with `card-tokens` icon, name,
  tagline, and
  `<span class="card-chip" id="chip-<id>" hidden>Spiel läuft</span>`.
- Root `ui.ts`: extend the `GameId` union and add an entry to the `games` array
  (`name`, `themeClass` or `null`, `themeColor` hex for the Android status bar,
  `controller: init<Name>({ onExit: goHub })`). The router, document title,
  chips and theme switching all derive from this array.

## 5. Styles (`style.scss`)

- One scoped block: `.view-<id> { … }`. Shared shell styles (appbar, iconbtn,
  wordmark base, cta, set-row, end-hero, howto, note/annot/tagline) already
  exist — don't duplicate them; only add what's game-specific.
- `@keyframes` go at the top level — Sass nests them into the scope otherwise
  and they silently don't apply.
- Own theme (non-blue): declare
  `body.theme-<id> { @extend %colourShades; --hue: H; --l-base: …; --c-base: …; --l-base-light: …; --c-base-light: …; }`
  (values per `ada.<colour>.scss` in ada-ui). Ada derives the full palette from
  these per scope, and the router toggles the body class. Set the matching
  `themeClass`/`themeColor` in the registry entry.

## 6. Verify (all must be green before commit)

```
npm test               # typecheck + jest, including the new game's suites
npm run build          # tsc + sass + offline-kit build (regenerates manifest)
npm run verify:offline # static: everything referenced exists + is precached
npm run smoke:offline  # real browser, server killed — nothing may fail
```

- Extend `scripts/offline-smoke.mjs` with one `expectVisible` for the new game's
  home screen (navigate via `#/<id>`), so the smoke actually covers it.
- New asset _types_ (not new files of existing types) need a glob extension in
  `offline-kit.config.js` — that's the only offline config that ever changes.
- Finish with a quick browser pass (desktop + ~390px mobile): hub card, game
  screens, theme switch on enter/leave, back arrow to hub.
