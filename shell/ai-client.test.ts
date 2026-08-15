// Lifecycle tests for the AI client. The point of this module is what happens
// when the worker *doesn't* behave — it dies silently, it never loads, the
// player walks away mid-think — so that is what's exercised here. A real worker
// would give none of that control, hence the fake.

import type { AiRequest, AiResponse } from "./ai-protocol.js";
import { createGame, type GameState, type Move } from "../games/dame/game.js";

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
      worker.reply({ id: request.id, kind: "error", message: "kaputt" });
    };
    await expect(requestAiMove("dame", aiState())).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
  });

  it("prefers a completed depth over a late worker error", async () => {
    const { requestAiMove } = await freshClient();
    FakeWorker.onRequest = (worker, request) => {
      worker.reply({ id: request.id, kind: "progress", depth: 2, move: move(4, 1) });
      worker.reply({ id: request.id, kind: "error", message: "kaputt" });
    };
    await expect(requestAiMove("dame", aiState())).resolves.toEqual(move(4, 1));
  });

  it("searches on this thread when no worker can be built", async () => {
    FakeWorker.failConstruction = true;
    const { requestAiMove } = await freshClient();
    // Capped at a shallow depth — an unbounded search here would block the UI,
    // which is the bug this whole design removes.
    const chosen = await requestAiMove("dame", aiState());
    expect(chosen.from).toBeDefined();
    expect(FakeWorker.instances).toHaveLength(0);
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

  it("does not fire a stale timer against a later request", async () => {
    const { requestAiMove, cancelAiMoves } = await freshClient();
    FakeWorker.onRequest = () => {
      /* still thinking */
    };
    const abandoned = requestAiMove("dame", aiState());
    abandoned.catch(() => {
      /* expected */
    });
    cancelAiMoves();

    let second: FakeWorker | undefined;
    let secondId = 0;
    FakeWorker.onRequest = (worker, request) => {
      second = worker;
      secondId = request.id;
    };
    const pending = requestAiMove("dame", aiState());
    // Past the cancelled request's original deadline: it must not take this one
    // down with it.
    jest.advanceTimersByTime(24_000);
    second!.reply({ id: secondId, kind: "done", move: move(4, 5) });
    await expect(pending).resolves.toEqual(move(4, 5));
    expect(second!.terminated).toBe(false);
  });
});
