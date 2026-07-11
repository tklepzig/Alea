// Pure game logic — no DOM, no storage. A colour is an integer index in
// 0..colours-1; the secret and every guess are arrays of these indices.
// Everything here is deterministic given an injected RNG, so it's unit-testable.

export interface GameConfig {
  /** Number of distinct peg colours available (see LIMITS.colours). */
  colours: number;
  /** Pegs in the secret code. */
  codeLength: number;
  /** Rows the player gets before losing. */
  maxGuesses: number;
  /** May the same colour appear more than once in the code? */
  allowRepeats: boolean;
}

/** Feedback for one guess. `exact` = right colour AND position; `colour` =
 *  right colour, wrong position. (The classic black/white pegs.) */
export interface Feedback {
  exact: number;
  colour: number;
}

export interface Guess {
  pegs: number[];
  feedback: Feedback;
}

export type GameStatus = "playing" | "won" | "lost";

export interface GameState {
  config: GameConfig;
  secret: number[];
  guesses: Guess[];
  status: GameStatus;
}

export const DEFAULT_CONFIG: GameConfig = {
  colours: 6,
  codeLength: 4,
  maxGuesses: 10,
  allowRepeats: true,
};

/** Configurable ranges. With repeats off, colours must also be >= codeLength
 *  (enforced separately in isConfigValid), otherwise no valid code exists. */
export const LIMITS = {
  colours: { min: 6, max: 10 },
  codeLength: { min: 2, max: 6 },
  maxGuesses: { min: 6, max: 15 },
} as const;

export type RandomFn = () => number;

function inRange(value: number, range: { min: number; max: number }): boolean {
  return Number.isInteger(value) && value >= range.min && value <= range.max;
}

export function isConfigValid(config: GameConfig): boolean {
  return (
    inRange(config.colours, LIMITS.colours) &&
    inRange(config.codeLength, LIMITS.codeLength) &&
    inRange(config.maxGuesses, LIMITS.maxGuesses) &&
    // No-repeat codes need at least one colour per position.
    (config.allowRepeats || config.colours >= config.codeLength)
  );
}

/**
 * Score a guess against the secret. Two passes so duplicate colours are never
 * double-counted: first remove the exact (same colour + position) matches, then
 * count colour overlaps among only the *leftover* pegs. The naive
 * "count shared colours" approach is wrong whenever a colour repeats.
 */
export function score(
  secret: readonly number[],
  guess: readonly number[],
): Feedback {
  if (guess.length !== secret.length) {
    throw new Error(
      `guess length ${guess.length} does not match code length ${secret.length}`,
    );
  }

  let exact = 0;
  const secretRemaining: number[] = [];
  const guessRemaining: number[] = [];

  for (let i = 0; i < secret.length; i++) {
    if (guess[i] === secret[i]) {
      exact++;
    } else {
      secretRemaining.push(secret[i]);
      guessRemaining.push(guess[i]);
    }
  }

  // Tally how many of each colour are still available in the secret leftovers,
  // then consume one per matching guess peg.
  const available = new Map<number, number>();
  for (const colour of secretRemaining) {
    available.set(colour, (available.get(colour) ?? 0) + 1);
  }

  let colour = 0;
  for (const peg of guessRemaining) {
    const left = available.get(peg) ?? 0;
    if (left > 0) {
      colour++;
      available.set(peg, left - 1);
    }
  }

  return { exact, colour };
}

/** Generate a random secret honouring the repeats setting. */
export function generateSecret(
  config: GameConfig,
  random: RandomFn = Math.random,
): number[] {
  if (!isConfigValid(config)) {
    throw new Error("cannot generate a secret for an invalid config");
  }

  if (config.allowRepeats) {
    return Array.from({ length: config.codeLength }, () =>
      Math.floor(random() * config.colours),
    );
  }

  // No repeats: partial Fisher–Yates over the colour pool, take the first
  // codeLength entries — a uniform sample of distinct colours.
  const pool = Array.from({ length: config.colours }, (_, index) => index);
  for (let index = 0; index < config.codeLength; index++) {
    const pick = index + Math.floor(random() * (pool.length - index));
    [pool[index], pool[pick]] = [pool[pick], pool[index]];
  }
  return pool.slice(0, config.codeLength);
}

export function createGame(
  config: GameConfig,
  random: RandomFn = Math.random,
): GameState {
  if (!isConfigValid(config)) {
    throw new Error("invalid game config");
  }
  return {
    config,
    secret: generateSecret(config, random),
    guesses: [],
    status: "playing",
  };
}

/** Validate a fully-filled guess row against the active config. */
export function isValidGuess(config: GameConfig, pegs: readonly number[]): boolean {
  if (pegs.length !== config.codeLength) return false;
  if (pegs.some((peg) => !Number.isInteger(peg) || peg < 0 || peg >= config.colours)) {
    return false;
  }
  if (!config.allowRepeats && new Set(pegs).size !== pegs.length) return false;
  return true;
}

/**
 * Score a guess, append it, and advance the status. Pure: returns a new state,
 * never mutates the input. Throws on an out-of-turn or malformed guess — the UI
 * is expected to only call this with a complete, valid row.
 */
export function submitGuess(state: GameState, pegs: readonly number[]): GameState {
  if (state.status !== "playing") {
    throw new Error("game is already over");
  }
  if (!isValidGuess(state.config, pegs)) {
    throw new Error("invalid guess for this config");
  }

  const feedback = score(state.secret, pegs);
  const guesses = [...state.guesses, { pegs: [...pegs], feedback }];

  let status: GameStatus = "playing";
  if (feedback.exact === state.config.codeLength) {
    status = "won";
  } else if (guesses.length >= state.config.maxGuesses) {
    status = "lost";
  }

  return { ...state, guesses, status };
}

export function remainingGuesses(state: GameState): number {
  return Math.max(0, state.config.maxGuesses - state.guesses.length);
}
