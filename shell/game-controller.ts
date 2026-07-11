// Contract between the hub (router/startpage) and each game module. A game
// initialises once at boot and is toggled via activate/deactivate as the route
// changes; its screens live in its own <section class="view"> in index.html.

export interface GameController {
  /** Route entered this game: reset to its home screen, recompute "continue". */
  activate(): void;
  /** Route left this game: stop timers, drop transient UI state. */
  deactivate(): void;
  /** An in-progress game is saved (drives the "Spiel läuft" chip in the hub). */
  hasRunningGame(): boolean;
}

export interface GameHost {
  /** Navigate back to the hub startpage. */
  onExit(): void;
}
