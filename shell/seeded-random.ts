// mulberry32 — small, fast, and good enough for AI tie-breaking. Exists as its
// own module because the RNG has to be reconstructed *inside* the worker: a
// function can't be structured-cloned, so only its seed crosses the boundary.

import type { RandomFn } from "../games/dame/game.js";

export function seededRandom(seed: number): RandomFn {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed for one AI turn. Only needs to differ per call — the determinism that
 *  matters is within a single search, so the worker reproduces our tie-breaks. */
export function randomSeed(): number {
  return (Math.random() * 2 ** 32) >>> 0;
}
