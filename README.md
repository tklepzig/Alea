# Alea

> **Alea** — Latin for *die / game of chance* ("alea iacta est"). The app's
> identity is centralised in `shell/app.ts` (plus `manifest.webmanifest`, the
> title/wordmark in `index.html` and the icon SVGs).

A small offline game collection (German UI) shipped as a PWA: several games in
one app, with a start page to pick from. Every game stores its state locally and
can be resumed at any time — fully offline.

Included games (names as shown in the UI):

- **Quadra** — four in a row against the AI (four difficulty levels) or locally
  for two players.
- **Ciphra** — crack the secret colour code (single player, configurable).
- **Dame** (draughts) — capture whatever you can, against the AI or for two.
- **Schach** (chess) — the royal game, against the AI or for two.
- **Mühle** (nine men's morris) — close mills, take stones, against the AI or
  for two.
- **Halma** — move all your stones into the opposing camp, jumping far.
- **Solo-Halma** — peg solitaire: keep jumping until a single stone is left.

## Architecture

- Vanilla TypeScript + SCSS on top of the Ada framework, no framework runtime.
- **Hub shell** (`ui.ts`): hash router (`#/` start page, `#/quadra`, `#/ciphra`,
  `#/dame`, `#/schach`, `#/muehle`, `#/halma`, `#/solohalma`); one
  `<section class="view">` per game in `index.html` with prefixed ids (`q-…`,
  `c-…`, `d-…`, `x-…`, `m-…`, `h-…`, `s-…`). Games implement the
  `GameController` contract (`shell/game-controller.ts`) and are initialised
  once at boot.
- **Theming**: hub and Quadra run on Ada's blue; every other game brings its own
  colour via a body class (`theme-ciphra`, `theme-dame`, …) that re-derives the
  Ada colour variables within that scope.
- **Persistence**: localStorage, keys namespaced as `alea.<game>.<what>`
  (`shell/safe-storage.ts` degrades gracefully when storage is unavailable).
- **Offline**: [`@tklepzig/offline-kit`](https://github.com/tklepzig/offline-kit)
  (service worker with a content-hashed precache manifest, self-healing since
  0.1.2, readiness badge on the start page with a re-check button).

## Offline guarantees

Two checks back the 100% offline capability (both run on deploy):

1. `npm run verify:offline` — static check: everything referenced by
   `index.html`, the CSS and the web app manifest exists and is listed in the
   service worker's precache manifest (`offline-kit verify`, offline-kit ≥
   0.2.0).
2. `npm run smoke:offline` — real browser test (Playwright): load the app, wait
   for "✓ Offline ready", kill the server, reload — the hub and every game must
   work entirely from the cache, without a single failed request.

## Development

```
npm install
npm run dev        # build + watchers + live-server
npm run dev:no-sw  # same, service worker disabled (no cache in the way)
npm test           # typecheck + Jest (game logic + persistence)
npm run build      # typecheck, SASS, bundles + service worker
```

## Note

This project is a private learning project with no commercial intent and is not
affiliated with any commercial game or its makers.
