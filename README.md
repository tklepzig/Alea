# Alea

> **Alea** — lateinisch für *Würfel / Glücksspiel* („alea iacta est"). Die
> App-Identität ist in `shell/app.ts` zentralisiert (plus
> `manifest.webmanifest`, `index.html` Titel/Wortmarke und die Icon-SVGs).

Kleine Offline-Spielesammlung (deutsche Oberfläche) als PWA: mehrere Spiele in
einer App, mit einer Startseite zur Auswahl. Jedes Spiel speichert seinen
Spielstand lokal und kann jederzeit fortgesetzt werden — komplett offline.

Enthaltene Spiele:

- **Quadra** — Vier in einer Reihe gegen die KI (vier Schwierigkeitsgrade) oder
  lokal zu zweit.
- **Ciphra** — Knacke den geheimen Farbcode (Einzelspieler, konfigurierbar).

Beide Spiele existieren weiterhin als eigenständige Apps
([Quadra](https://github.com/tklepzig/Quadra),
[Ciphra](https://github.com/tklepzig/Ciphra)); dieses Repo führt sie in einer
gemeinsamen PWA zusammen. Gespeicherte Spielstände der Einzel-Apps werden
nicht übernommen (anderer Origin-Pfad, getrennter localStorage).

## Architektur

- Vanilla TypeScript + SCSS auf dem Ada-Framework, kein Framework-Runtime.
- **Hub-Shell** (`ui.ts`): Hash-Router (`#/` Startseite, `#/quadra`, `#/ciphra`),
  pro Spiel ein `<section class="view">` in `index.html` mit präfixierten IDs
  (`q-…`, `c-…`). Spiele implementieren den `GameController`-Kontrakt
  (`shell/game-controller.ts`) und werden einmal beim Boot initialisiert.
- **Theming**: Hub + Quadra laufen auf Adas Blau; Ciphra behält Grün über eine
  Body-Klasse (`theme-ciphra`), die die Ada-Farbvariablen im Scope neu ableitet.
- **Persistenz**: localStorage, Keys namespaced als `alea.<spiel>.<was>`
  (`shell/safe-storage.ts` degradiert sauber, wenn Storage nicht verfügbar ist).
- **Offline**: [`@tklepzig/offline-kit`](https://github.com/tklepzig/offline-kit)
  (Service Worker mit content-gehashtem Precache-Manifest, Selbstheilung ab
  0.1.2, Readiness-Badge auf der Startseite mit Re-Check-Button).

## Offline-Garantien

Zwei Prüfungen sichern die 100%-Offline-Fähigkeit ab (beide laufen im Deploy):

1. `npm run verify:offline` — statischer Abgleich: alles, was `index.html`,
   CSS und Web-App-Manifest referenzieren, existiert und steht im
   Precache-Manifest des Service Workers (`offline-kit verify`, offline-kit ≥ 0.2.0).
2. `npm run smoke:offline` — echter Browser-Test (Playwright): App laden,
   auf „✓ Offline ready" warten, Server killen, neu laden — Hub und beide
   Spiele müssen vollständig aus dem Cache funktionieren, ohne einen einzigen
   fehlgeschlagenen Request.

## Entwicklung

```
npm install
npm run dev        # Build + Watcher + live-server
npm run dev:no-sw  # dito, Service Worker deaktiviert (kein Cache im Weg)
npm test           # Typecheck + Jest (Spiellogik + Persistenz)
npm run build      # Typecheck, SASS, Bundles + Service Worker
```

## Hinweis

Dieses Projekt ist ein privates Lernprojekt ohne kommerzielle Absichten und
steht in keiner Verbindung zu kommerziellen Spielen oder deren Herstellern.
