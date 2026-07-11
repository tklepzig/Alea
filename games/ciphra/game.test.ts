import {
  score,
  generateSecret,
  isConfigValid,
  isValidGuess,
  createGame,
  submitGuess,
  remainingGuesses,
  DEFAULT_CONFIG,
  type GameConfig,
} from "./game.js";

/** Deterministic RNG (mulberry32) so secret generation is testable. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const config = (over: Partial<GameConfig> = {}): GameConfig => ({
  ...DEFAULT_CONFIG,
  ...over,
});

describe("score — two-pass, duplicate-safe", () => {
  it("all exact", () => {
    expect(score([0, 1, 2, 3], [0, 1, 2, 3])).toEqual({ exact: 4, colour: 0 });
  });

  it("nothing in common", () => {
    expect(score([0, 0, 0, 0], [1, 2, 3, 4])).toEqual({ exact: 0, colour: 0 });
  });

  it("all right colours, all wrong positions", () => {
    expect(score([0, 1, 2, 3], [3, 2, 1, 0])).toEqual({ exact: 0, colour: 4 });
  });

  it("duplicate guess colour is not over-counted against a single secret peg", () => {
    // secret has one 0; guessing four 0s must give exactly one exact, no colour.
    expect(score([0, 1, 2, 3], [0, 0, 0, 0])).toEqual({ exact: 1, colour: 0 });
  });

  it("duplicate colours on both sides", () => {
    // two 0s and two 1s, fully swapped → 0 exact, 4 colour.
    expect(score([0, 0, 1, 1], [1, 1, 0, 0])).toEqual({ exact: 0, colour: 4 });
  });

  it("repeated secret colour, one exact one misplaced", () => {
    expect(score([0, 1, 1, 2], [1, 1, 3, 4])).toEqual({ exact: 1, colour: 1 });
  });

  it("a colour matched exactly is not also counted as misplaced", () => {
    // secret two 1s; guess has 1 exact at pos1 and one extra 1 that should count
    // as a colour match (second secret 1), but no more.
    expect(score([1, 1, 2, 3], [1, 0, 1, 1])).toEqual({ exact: 1, colour: 1 });
  });

  it("throws on length mismatch", () => {
    expect(() => score([0, 1, 2, 3], [0, 1, 2])).toThrow();
  });
});

describe("isConfigValid", () => {
  it("accepts the defaults", () => {
    expect(isConfigValid(DEFAULT_CONFIG)).toBe(true);
  });

  it("rejects repeats-off when colours < codeLength", () => {
    expect(isConfigValid(config({ allowRepeats: false, colours: 6, codeLength: 6 }))).toBe(true);
    expect(isConfigValid(config({ allowRepeats: false, colours: 6, codeLength: 7 }))).toBe(false);
  });

  it("rejects out-of-range values", () => {
    expect(isConfigValid(config({ colours: 5 }))).toBe(false);
    expect(isConfigValid(config({ colours: 11 }))).toBe(false);
    expect(isConfigValid(config({ codeLength: 1 }))).toBe(false);
    expect(isConfigValid(config({ maxGuesses: 100 }))).toBe(false);
    expect(isConfigValid(config({ colours: 6.5 }))).toBe(false);
  });
});

describe("generateSecret", () => {
  it("has the right length and colour range", () => {
    const secret = generateSecret(config({ colours: 8, codeLength: 5 }), seededRandom(1));
    expect(secret).toHaveLength(5);
    expect(secret.every((c) => c >= 0 && c < 8)).toBe(true);
  });

  it("is deterministic for a given RNG", () => {
    const a = generateSecret(DEFAULT_CONFIG, seededRandom(42));
    const b = generateSecret(DEFAULT_CONFIG, seededRandom(42));
    expect(a).toEqual(b);
  });

  it("produces no duplicates when repeats are off", () => {
    for (let seed = 0; seed < 50; seed++) {
      const secret = generateSecret(
        config({ allowRepeats: false, colours: 6, codeLength: 6 }),
        seededRandom(seed),
      );
      expect(new Set(secret).size).toBe(secret.length);
    }
  });

  it("can repeat colours when repeats are on (across many draws)", () => {
    let sawRepeat = false;
    for (let seed = 0; seed < 50 && !sawRepeat; seed++) {
      const secret = generateSecret(config({ colours: 6, codeLength: 4 }), seededRandom(seed));
      if (new Set(secret).size < secret.length) sawRepeat = true;
    }
    expect(sawRepeat).toBe(true);
  });
});

describe("isValidGuess", () => {
  it("rejects wrong length, out-of-range, and (repeats-off) duplicates", () => {
    expect(isValidGuess(DEFAULT_CONFIG, [0, 1, 2])).toBe(false);
    expect(isValidGuess(DEFAULT_CONFIG, [0, 1, 2, 6])).toBe(false);
    expect(isValidGuess(DEFAULT_CONFIG, [0, 1, 2, 3])).toBe(true);
    const noRepeat = config({ allowRepeats: false });
    expect(isValidGuess(noRepeat, [0, 0, 1, 2])).toBe(false);
    expect(isValidGuess(noRepeat, [0, 1, 2, 3])).toBe(true);
  });
});

describe("createGame / submitGuess", () => {
  it("starts playing with a valid secret and no guesses", () => {
    const state = createGame(DEFAULT_CONFIG, seededRandom(7));
    expect(state.status).toBe("playing");
    expect(state.guesses).toHaveLength(0);
    expect(state.secret).toHaveLength(4);
  });

  it("wins when the guess equals the secret", () => {
    const state = createGame(DEFAULT_CONFIG, seededRandom(7));
    const next = submitGuess(state, state.secret);
    expect(next.status).toBe("won");
    expect(next.guesses).toHaveLength(1);
    expect(state.guesses).toHaveLength(0); // input not mutated
  });

  it("loses after maxGuesses wrong rows", () => {
    const cfg = config({ maxGuesses: 6 });
    let state = createGame(cfg, seededRandom(7));
    const wrong = state.secret.map((c) => (c + 1) % cfg.colours);
    for (let i = 0; i < cfg.maxGuesses; i++) {
      state = submitGuess(state, wrong);
    }
    expect(state.status).toBe("lost");
    expect(remainingGuesses(state)).toBe(0);
  });

  it("can win on the very last row (win beats lose)", () => {
    const cfg = config({ maxGuesses: 6 });
    let state = createGame(cfg, seededRandom(11));
    const wrong = state.secret.map((c) => (c + 1) % cfg.colours);
    for (let i = 0; i < cfg.maxGuesses - 1; i++) {
      state = submitGuess(state, wrong); // fill every row but the last
    }
    state = submitGuess(state, state.secret); // last allowed row, correct
    expect(state.status).toBe("won");
  });

  it("throws when guessing after the game is over", () => {
    const state = createGame(DEFAULT_CONFIG, seededRandom(7));
    const won = submitGuess(state, state.secret);
    expect(() => submitGuess(won, won.secret)).toThrow();
  });
});
