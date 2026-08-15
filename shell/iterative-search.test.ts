// Direct tests for the shared search scaffold.
//
// These exist because the per-game differential tests structurally cannot cover
// this module: getAiMove and getAiMoveIterative both delegate to the same
// bestAtDepth -> pickBest, so a regression *inside* pickBest moves both sides
// identically and every differential still passes. That was demonstrated — a
// pickBest that ignores every score and returns the first candidate kept the
// whole games suite green, i.e. all five engines could have been silently
// weakened at once with nothing to catch it. Behaviour here has to be pinned on
// its own terms.

import {
  depthLadder,
  iterativeBest,
  pickBest,
  type Scored,
} from "./iterative-search.js";

describe("depthLadder", () => {
  // The target must always be the last rung. Striding onto it instead would
  // skip every odd target — Halma's expert 3, Mühle's and Schach's 5, Quadra's
  // 7 — and the deepest result, which is the whole point, would never exist.
  it.each([
    [1, [1]],
    [2, [2]],
    [3, [2, 3]],
    [4, [2, 4]],
    [5, [2, 4, 5]],
    [6, [2, 4, 6]],
    [7, [2, 4, 6, 7]],
    [8, [2, 4, 6, 8]],
  ])("walks to %i as %j", (target, expected) => {
    expect(depthLadder(target)).toEqual(expected);
  });

  it("never returns an empty ladder, so there is always a result", () => {
    for (let target = 1; target <= 12; target++) {
      expect(depthLadder(target).length).toBeGreaterThan(0);
      expect(depthLadder(target)[depthLadder(target).length - 1]).toBe(target);
    }
  });
});

describe("pickBest", () => {
  const scored = (...scores: number[]): Scored<number>[] =>
    scores.map((score, index) => ({ move: index, score }));

  it("returns the highest-scoring entry", () => {
    expect(pickBest(scored(1, 9, 3), () => 0).move).toBe(1);
    expect(pickBest(scored(-50, -1, -400), () => 0).move).toBe(1);
    expect(pickBest(scored(5, 5, 7), () => 0).move).toBe(2);
  });

  it("returns the best even when it is last, first, or unique", () => {
    expect(pickBest(scored(0, 0, 0, 42), () => 0).move).toBe(3);
    expect(pickBest(scored(42, 0, 0, 0), () => 0).move).toBe(0);
  });

  it("carries the winning score back, not just the move", () => {
    expect(pickBest(scored(2, 8, 4), () => 0)).toEqual({ move: 1, score: 8 });
  });

  // Ties are the only place randomness may enter — the AI shouldn't answer an
  // identical position identically every time.
  it("chooses among tied-best entries only, using random once", () => {
    let calls = 0;
    const random = (): number => {
      calls++;
      return 0.99;
    };
    // Entries 0 and 2 tie on the top score; entry 1 must never be chosen.
    const chosen = pickBest([
      { move: "a", score: 10 },
      { move: "b", score: 1 },
      { move: "c", score: 10 },
    ], random);
    expect(chosen.move).toBe("c");
    expect(calls).toBe(1);
  });

  it("takes the first tied-best when random is 0", () => {
    const chosen = pickBest([
      { move: "a", score: 10 },
      { move: "b", score: 10 },
    ], () => 0);
    expect(chosen.move).toBe("a");
  });

  it("never picks a losing move when a winning one exists", () => {
    // The shape that matters in a real engine: one move wins outright, the rest
    // are ordinary. A pick that ignored scores would take index 0.
    const chosen = pickBest(scored(-100000, 0, 0, 100000), () => 0);
    expect(chosen.score).toBe(100000);
    expect(chosen.move).toBe(3);
  });
});

describe("iterativeBest", () => {
  /** Scores each rung so the "best" move differs per depth — that way a caller
   *  returning the wrong rung is visible. */
  const byDepth = (depth: number): Scored<string> => ({ move: `d${depth}`, score: depth });

  it("returns the deepest rung's result", () => {
    expect(iterativeBest(5, byDepth)).toBe("d5");
    expect(iterativeBest(1, byDepth)).toBe("d1");
  });

  it("reports every completed depth in order", () => {
    const seen: number[] = [];
    iterativeBest(7, byDepth, { onDepth: (progress) => seen.push(progress.depth) });
    expect(seen).toEqual([2, 4, 6, 7]);
  });

  it("reports the move and score of each rung, so a killed search has a fallback", () => {
    const seen: { depth: number; move: string; score: number }[] = [];
    iterativeBest(4, byDepth, { onDepth: (progress) => seen.push({ ...progress }) });
    expect(seen).toEqual([
      { depth: 2, move: "d2", score: 2 },
      { depth: 4, move: "d4", score: 4 },
    ]);
  });

  it("stops at maxDepth", () => {
    const seen: number[] = [];
    expect(
      iterativeBest(8, byDepth, { maxDepth: 4, onDepth: (progress) => seen.push(progress.depth) }),
    ).toBe("d4");
    expect(seen).toEqual([2, 4]);
  });

  // maxDepth is a ceiling for callers that must not block, never a floor —
  // it must not make a shallow level search deeper than its own target.
  it("ignores a maxDepth above the target", () => {
    const seen: number[] = [];
    expect(
      iterativeBest(3, byDepth, { maxDepth: 99, onDepth: (progress) => seen.push(progress.depth) }),
    ).toBe("d3");
    expect(seen).toEqual([2, 3]);
  });

  it("calls bestAtDepth once per rung, with the rung's depth", () => {
    const asked: number[] = [];
    iterativeBest(6, (depth) => {
      asked.push(depth);
      return byDepth(depth);
    });
    expect(asked).toEqual([2, 4, 6]);
  });
});
