import {
  SCHEMA_VERSION,
  serializeConfig,
  deserializeConfig,
  serializeGame,
  deserializeGame,
} from "./storage.js";
import { createGame, submitGuess, DEFAULT_CONFIG } from "./game.js";

function fixedRandom(): () => number {
  return () => 0.42;
}

describe("config persistence", () => {
  it("round-trips a valid config", () => {
    const restored = deserializeConfig(serializeConfig(DEFAULT_CONFIG));
    expect(restored).toEqual(DEFAULT_CONFIG);
  });

  it("rejects an invalid config", () => {
    const raw = JSON.stringify({ v: SCHEMA_VERSION, data: { ...DEFAULT_CONFIG, colours: 99 } });
    expect(deserializeConfig(raw)).toBeNull();
  });
});

describe("game persistence", () => {
  it("round-trips an in-progress game", () => {
    let state = createGame(DEFAULT_CONFIG, fixedRandom());
    state = submitGuess(state, [0, 1, 2, 3]);
    const restored = deserializeGame(serializeGame(state));
    expect(restored).toEqual(state);
  });

  it("returns null for null / empty input", () => {
    expect(deserializeGame(null)).toBeNull();
    expect(deserializeGame("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(deserializeGame("{not json")).toBeNull();
  });

  it("returns null for an older schema version", () => {
    const state = createGame(DEFAULT_CONFIG, fixedRandom());
    const raw = JSON.stringify({ v: SCHEMA_VERSION - 1, data: state });
    expect(deserializeGame(raw)).toBeNull();
  });

  it("returns null when the state shape doesn't match its config", () => {
    const state = createGame(DEFAULT_CONFIG, fixedRandom());
    // secret length disagrees with config.codeLength → corrupt.
    const corrupt = { ...state, secret: [0, 1] };
    const raw = JSON.stringify({ v: SCHEMA_VERSION, data: corrupt });
    expect(deserializeGame(raw)).toBeNull();
  });

  it("returns null when a peg is out of colour range", () => {
    const state = createGame(DEFAULT_CONFIG, fixedRandom());
    const corrupt = { ...state, secret: [0, 1, 2, 99] };
    const raw = JSON.stringify({ v: SCHEMA_VERSION, data: corrupt });
    expect(deserializeGame(raw)).toBeNull();
  });
});
