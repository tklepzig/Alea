// Whether the *running* game offers its undo button. The choice is made before
// a game starts, so it has to outlive the setting it came from: a player who
// started a game without undo must not get the button back by flipping the
// setting mid-game — or by relaunching the app, which re-reads settings from
// scratch. It lives in its own localStorage key next to the game blob; nothing
// binds the two automatically, so each game keeps them in step by writing the
// flag in startGame and releasing it in clearGame — those two are the only
// writers.
//
// Absence means "undo allowed", so every game predating this option (and every
// device with storage disabled) keeps the button.

import { safeGet, safeRemove, safeSet } from "./safe-storage.js";

/** Stored only while undo is switched off; the key is removed otherwise. */
const BLOCKED = "off";

export function isUndoAllowed(key: string): boolean {
  return safeGet(key) !== BLOCKED;
}

export function setUndoAllowed(key: string, allowed: boolean): void {
  if (allowed) safeRemove(key);
  else safeSet(key, BLOCKED);
}
