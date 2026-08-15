// Lifecycle tests for the AI client. The point of this module is what happens
// when the worker *doesn't* behave — it dies silently, it never loads, the
// player walks away mid-think — so that is what's exercised here. A real worker
// would give none of that control, hence the fake.

import type { AiRequest, AiResponse } from "./ai-protocol.js";
import {
  createGame,
  isLegalMove,
  type GameState,
  type IterativeOptions,
  type Move,
} from "../games/dame/game.js";

// The fallback's depth cap has no observable effect on the returned move — any
// depth yields a legal one — so the only assertable invariant is the options the
// client passes down. Asserting on a mock's arguments is usually the weak
// choice; here the real observable ("how long it blocks the main thread") can't
// be measured, and an uncapped fallback is precisely the regression that
// reinstates the original freeze, so the call contract is what gets pinned.
const mockOptionsSeen: IterativeOptions[] = [];
jest.mock("../games/dame/game.js", () => {
  const actual = jest.requireActual<typeof import("../games/dame/game.js")>(
    "../games/dame/game.js",
  );
  return {
    ...actual,
    getAiMoveIterative: (
      state: GameState,
      random: () => number,
      options: IterativeOptions = {},
    ) => {
      mockOptionsSeen.push(options);
      return actual.getAiMoveIterative(state, random, options);
    },
  };
});

/** Stand-in for the browser's Worker: records what it was sent and lets a test
 *  decide, per request, what (if anything) comes back. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  /** Set by a test before the client constructs one. */
  static onRequest: ((worker: FakeWorker, request: AiRequest) => void) | null = null;
  /** Throw from the constructor, standing in for "workers unavailable". */
  static failConstruction = false;

  onmessage: ((event: MessageEvent<AiResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  readonly sent: AiRequest[] = [];

  constructor(public readonly url: string) {
    if (FakeWorker.failConstruction) throw new Error("no workers here");
    FakeWorker.instances.push(this);
  }

  postMessage(request: AiRequest): void {
    this.sent.push(request);
    FakeWorker.onRequest?.(this, request);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Deliver a message as the real worker would. */
  reply(response: AiResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<AiResponse>);
  }

  static reset(): void {
    FakeWorker.instances = [];
    FakeWorker.onRequest = null;
    FakeWorker.failConstruction = false;
  }
}

const move = (row: number, col: number): Move => ({
  from: { row: 5, col: 0 },
  to: { row, col },
  captured: null,
});

function aiState(): GameState {
  return {
    ...createGame({ mode: "ai", humanPlayer: "red", difficulty: "expert" }),
    currentPlayer: "black",
  };
}

// The client keeps module-level state (the worker, the broken flag), so each
// test needs a pristine copy of the module.
async function freshClient(): Promise<typeof import("./ai-client.js")> {
  jest.resetModules();
  return import("./ai-client.js");
}

beforeEach(() => {
  FakeWorker.reset();
  mockOptionsSeen.length = 0;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  delete (globalThis as { Worker?: unknown }).Worker;
});

describe("requestAiMove", () => {
  it("resolves with the move the worker finishes on", async () => {
    const { requestAiMove } = await freshClient();
    FakeWorker.onRequest = (worker, request) => {
      worker.reply({ id: request.id, kind: "progress", depth: 2, move: move(4, 1) });
      worker.reply({ id: request.id, kind: "done", move: move(4, 3) });
    };
    await expect(requestAiMove("dame", aiState())).resolves.toEqual(move(4, 3));
  });

  // The whole reason this module exists: the worker is killed mid-search and
  // says nothing at all. Only the silence timer notices.
  it("falls back to the deepest reported depth when the worker goes silent", async () => {
    const { requestAiMove } = await freshClient();
    FakeWorker.onRequest = (worker, request) => {
      worker.reply({ id: request.id, kind: "progress", depth: 2, move: move(4, 1) });
      worker.reply({ id: request.id, kind: "progress", depth: 4, move: move(4, 3) });
      // ...and then nothing. No "done", no error, no crash event.
    };
    const pending = requestAiMove("dame", aiState());
    jest.advanceTimersByTime(60_000);
    await expect(pending).resolves.toEqual(move(4, 3));
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it("rejects when the worker dies before reporting any depth", async () => {
    const { requestAiMove, AiUnavailableError } = await freshClient();
    FakeWorker.onRequest = () => {
      /* silence from the very start */
    };
    const pending = requestAiMove("dame", aiState());
    jest.advanceTimersByTime(60_000);
    await expect(pending).rejects.toBeInstanceOf(AiUnavailableError);
  });

  // The silence window is a gap between results, not a total budget — a search
  // that keeps reporting must never be cut off, or it would cost strength.
  it("re-arms the silence timer on every reported depth", async () => {
    const { requestAiMove } = await freshClient();
    let worker: FakeWorker | undefined;
    let requestId = 0;
    FakeWorker.onRequest = (instance, request) => {
      worker = instance;
      requestId = request.id;
    };
    const pending = requestAiMove("dame", aiState());

    // Keep answering just inside the window, well past any total budget.
    for (let step = 0; step < 5; step++) {
      jest.advanceTimersByTime(20_000);
      worker!.reply({ id: requestId, kind: "progress", depth: 2 + step, move: move(4, 1) });
    }
    jest.advanceTimersByTime(20_000);
    worker!.reply({ id: requestId, kind: "done", move: move(4, 5) });

    await expect(pending).resolves.toEqual(move(4, 5));
    expect(worker!.terminated).toBe(false);
  });

  it("reports an explicit worker error when nothing was completed", async () => {
    const { requestAiMove, AiUnavailableError } = await freshClient();
    FakeWorker.onRequest = (worker, request) => {
      worker.reply({ id: request.id, kind: "error", message: "kaputt", fromEngine: false });
    };
    await expect(requestAiMove("dame", aiState())).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
  });

  it("prefers a completed depth over a late worker error", async () => {
    const { requestAiMove } = await freshClient();
    FakeWorker.onRequest = (worker, request) => {
      worker.reply({ id: request.id, kind: "progress", depth: 2, move: move(4, 1) });
      worker.reply({ id: request.id, kind: "error", message: "kaputt", fromEngine: false });
    };
    await expect(requestAiMove("dame", aiState())).resolves.toEqual(move(4, 1));
  });

  it("searches on this thread when no worker can be built", async () => {
    FakeWorker.failConstruction = true;
    const { requestAiMove } = await freshClient();
    const state = aiState();
    const chosen = await requestAiMove("dame", state);
    expect(isLegalMove(state, chosen)).toBe(true);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  // Without the cap this path runs the full expert ladder synchronously — ~30s
  // of frozen board on the tablet, then a killed context. Deleting `maxDepth`
  // from requestAiMove must fail a test, and nothing about the returned move
  // reveals the depth, so the options object is the thing to assert on.
  it("caps the on-thread fallback so it cannot block like the original bug", async () => {
    FakeWorker.failConstruction = true;
    const { requestAiMove } = await freshClient();
    await requestAiMove("dame", aiState());
    expect(mockOptionsSeen).toHaveLength(1);
    expect(mockOptionsSeen[0].maxDepth).toBe(4);
  });

  it("does not cap the worker's own search — full strength stays in the worker", async () => {
    const { requestAiMove } = await freshClient();
    FakeWorker.onRequest = (worker, request) => {
      worker.reply({ id: request.id, kind: "done", move: move(4, 3) });
    };
    await requestAiMove("dame", aiState());
    // Nothing ran on this thread, and the request carries no depth limit.
    expect(mockOptionsSeen).toHaveLength(0);
    expect("maxDepth" in FakeWorker.instances[0].sent[0]).toBe(false);
  });

  it("sends a plain-data request that survives structured cloning", async () => {
    const { requestAiMove } = await freshClient();
    FakeWorker.onRequest = (worker, request) => {
      worker.reply({ id: request.id, kind: "done", move: move(4, 3) });
    };
    await requestAiMove("dame", aiState());
    const [sent] = FakeWorker.instances[0].sent;
    // A function anywhere in here would throw DataCloneError in a real browser.
    expect(() => structuredClone(sent)).not.toThrow();
    expect(typeof sent.seed).toBe("number");
  });
});

// A worker that dies without ever speaking means the bundle never loaded — `new
// Worker` resolves happily for a 404, so onerror is the only signal. One such
// failure is ambiguous (it could be the low-memory kill this design exists for,
// and falling back to the main thread for that would reinstate the freeze), so
// it takes two in a row to write workers off.
describe("worker load failures", () => {
  const failOnError = (worker: FakeWorker) => {
    worker.onerror?.();
  };

  it("rebuilds the worker after a single silent failure", async () => {
    const { requestAiMove } = await freshClient();
    FakeWorker.onRequest = failOnError;
    await expect(requestAiMove("dame", aiState())).rejects.toBeDefined();

    // Not written off yet: a second worker is built rather than searching here.
    FakeWorker.onRequest = (worker, request) => {
      worker.reply({ id: request.id, kind: "done", move: move(4, 3) });
    };
    await expect(requestAiMove("dame", aiState())).resolves.toEqual(move(4, 3));
    expect(FakeWorker.instances).toHaveLength(2);
    expect(mockOptionsSeen).toHaveLength(0); // nothing ran on this thread
  });

  it("writes workers off after two silent failures and answers on this thread", async () => {
    const { requestAiMove } = await freshClient();
    FakeWorker.onRequest = failOnError;

    await expect(requestAiMove("dame", aiState())).rejects.toBeDefined();
    // The second failure flips workerBroken, and that request is answered by
    // the capped on-thread search rather than being reported as a failure —
    // otherwise the player taps Nochmal only to meet the same wall.
    const state = aiState();
    const chosen = await requestAiMove("dame", state);
    expect(isLegalMove(state, chosen)).toBe(true);
    expect(mockOptionsSeen[mockOptionsSeen.length - 1].maxDepth).toBe(4);

    // And no further workers are built.
    const built = FakeWorker.instances.length;
    await requestAiMove("dame", aiState());
    expect(FakeWorker.instances).toHaveLength(built);
  });

  it("does not write workers off when the worker had answered first", async () => {
    const { requestAiMove } = await freshClient();
    // Progress then death, twice — this is the silent-kill shape, not a broken
    // bundle, so it must never push the search back onto the main thread.
    for (let attempt = 0; attempt < 2; attempt++) {
      FakeWorker.onRequest = (worker, request) => {
        worker.reply({ id: request.id, kind: "progress", depth: 2, move: move(4, 1) });
        worker.onerror?.();
      };
      await expect(requestAiMove("dame", aiState())).resolves.toEqual(move(4, 1));
    }
    FakeWorker.onRequest = (worker, request) => {
      worker.reply({ id: request.id, kind: "done", move: move(4, 3) });
    };
    await expect(requestAiMove("dame", aiState())).resolves.toEqual(move(4, 3));
    expect(mockOptionsSeen).toHaveLength(0);
  });
});

describe("error reporting", () => {
  // Engine assertions are diagnostics. AiUnavailableError is the client's own
  // German copy, and the UI renders only that — so an engine message must not
  // arrive wearing it.
  it("keeps an engine assertion out of AiUnavailableError", async () => {
    const { requestAiMove, AiUnavailableError } = await freshClient();
    FakeWorker.onRequest = (worker, request) => {
      worker.reply({
        id: request.id,
        kind: "error",
        message: "no legal move — check status first",
        fromEngine: true,
      });
    };
    const failure = await requestAiMove("dame", aiState()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AiUnavailableError);
  });

  it("uses AiUnavailableError for the client's own failures", async () => {
    const { requestAiMove, AiUnavailableError } = await freshClient();
    FakeWorker.onRequest = () => {
      /* silence */
    };
    const pending = requestAiMove("dame", aiState());
    jest.advanceTimersByTime(60_000);
    await expect(pending).rejects.toBeInstanceOf(AiUnavailableError);
  });
});

describe("cancelAiMoves", () => {
  it("rejects the pending request with AiCancelledError", async () => {
    const { requestAiMove, cancelAiMoves, AiCancelledError } = await freshClient();
    FakeWorker.onRequest = () => {
      /* still thinking */
    };
    const pending = requestAiMove("dame", aiState());
    cancelAiMoves();
    await expect(pending).rejects.toBeInstanceOf(AiCancelledError);
  });

  // The abandoned search does not yield, so leaving it running would block the
  // next request behind it — and its own silence timer would later terminate
  // the worker mid-way through that next search.
  it("terminates the worker so the next request starts clean", async () => {
    const { requestAiMove, cancelAiMoves } = await freshClient();
    FakeWorker.onRequest = () => {
      /* still thinking */
    };
    const abandoned = requestAiMove("dame", aiState());
    abandoned.catch(() => {
      /* expected */
    });
    cancelAiMoves();
    expect(FakeWorker.instances[0].terminated).toBe(true);

    FakeWorker.onRequest = (worker, request) => {
      worker.reply({ id: request.id, kind: "done", move: move(4, 3) });
    };
    await expect(requestAiMove("dame", aiState())).resolves.toEqual(move(4, 3));
    expect(FakeWorker.instances).toHaveLength(2);
  });

  // A settled request must not leave its silence timer armed: when it later
  // fires it calls discardWorker, which terminates the worker and fails
  // whatever request is in flight by then. The clock has to be staggered to
  // show this — advancing far enough for the abandoned request's timer to fire
  // would otherwise also trip the new request's own timer, and the test would
  // pass whether or not `settle` clears anything.
  it("does not fire a stale timer against a later request", async () => {
    const { requestAiMove, cancelAiMoves } = await freshClient();
    FakeWorker.onRequest = () => {
      /* still thinking */
    };
    const abandoned = requestAiMove("dame", aiState());
    abandoned.catch(() => {
      /* expected */
    });

    // Burn most of the abandoned request's 25s window before cancelling, so its
    // deadline lands well inside the *next* request's window.
    jest.advanceTimersByTime(20_000);
    cancelAiMoves();

    let second: FakeWorker | undefined;
    let secondId = 0;
    FakeWorker.onRequest = (worker, request) => {
      second = worker;
      secondId = request.id;
    };
    const pending = requestAiMove("dame", aiState());

    // t = 30s: past the abandoned request's original 25s deadline, but only 10s
    // into the new one. A leaked timer fires here and kills this request.
    jest.advanceTimersByTime(10_000);
    second!.reply({ id: secondId, kind: "done", move: move(4, 5) });

    await expect(pending).resolves.toEqual(move(4, 5));
    expect(second!.terminated).toBe(false);
  });
});
