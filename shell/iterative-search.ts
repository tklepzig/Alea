// Iterative deepening, shared by every game engine that searches.
//
// The engines run in a Web Worker because a deep search can be killed outright
// on a low-memory device — no exception, no `catch`, taking the whole JS context
// with it. Nothing in that context survives to notice, so the only way to get an
// answer out is to publish one at each completed depth and let the main thread
// keep the last it heard. That is all this module does.
//
// It must not cost playing strength: the ladder always ends on the engine's own
// target depth, so the final answer is the one a fixed-depth search would have
// produced. Only `maxDepth` narrows that, and only the blocking main-thread
// fallback passes it.
//
// Pure and dependency-free, like the engines that import it.

export interface SearchProgress<TMove> {
  depth: number;
  move: TMove;
  score: number;
}

export interface IterativeOptions<TMove> {
  /** Called after each completed depth. */
  onDepth?: (progress: SearchProgress<TMove>) => void;
  /** Stop the ladder here even if the engine would go deeper. Strictly for
   *  callers that must not block for long — a shallow move beats a dead
   *  context. Leave unset to keep full strength. */
  maxDepth?: number;
}

export interface Scored<TMove> {
  move: TMove;
  score: number;
}

/**
 * The depths walked on the way to `target`, `target` always last.
 *
 * The stride is 2 because a search's cost grows steeply with depth, so the
 * intermediate rungs are near-free insurance. Appending the target rather than
 * striding onto it matters: an odd target (Mühle's expert 5, Dame's flying
 * expert 5) would otherwise be stepped straight over and the deepest result —
 * the whole point — never computed.
 */
export function depthLadder(target: number): number[] {
  const ladder: number[] = [];
  for (let depth = 2; depth < target; depth += 2) ladder.push(depth);
  ladder.push(target);
  return ladder;
}

/**
 * Walk the ladder to `target`, reporting each completed depth, and return the
 * deepest result.
 *
 * `bestAtDepth` must do the engine's own scoring at exactly that depth,
 * including its tie-break — so it consumes the engine's RNG once per rung
 * rather than once overall. Among moves that score *equally* that can land on a
 * different one than a fixed-depth search would; the score of the move returned
 * is the same, which is what "no loss of strength" means here.
 */
export function iterativeBest<TMove>(
  target: number,
  bestAtDepth: (depth: number) => Scored<TMove>,
  options: IterativeOptions<TMove> = {},
): TMove {
  const { onDepth, maxDepth } = options;
  const limit = maxDepth === undefined ? target : Math.min(target, maxDepth);

  let best: Scored<TMove> | null = null;
  for (const depth of depthLadder(limit)) {
    best = bestAtDepth(depth);
    onDepth?.({ depth, move: best.move, score: best.score });
  }
  // depthLadder always yields at least one rung, so this cannot be null; the
  // check keeps the type honest without a non-null assertion.
  if (!best) throw new Error("iterativeBest: empty depth ladder");
  return best.move;
}

/** Pick one of the tied-best, using `random` exactly once — the shape every
 *  engine's root already had, kept identical so tie-breaking doesn't change. */
export function pickBest<TMove>(
  scored: Scored<TMove>[],
  random: () => number,
): Scored<TMove> {
  const bestScore = Math.max(...scored.map((entry) => entry.score));
  const best = scored.filter((entry) => entry.score === bestScore);
  return best[Math.floor(random() * best.length)];
}
