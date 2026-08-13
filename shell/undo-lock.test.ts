// The lock encodes two conventions every game's ui.ts leans on: an absent key
// means undo is allowed, and only the "off" sentinel takes it away. Both are
// invisible at the call sites, so they get pinned here.

import { isUndoAllowed, setUndoAllowed } from "./undo-lock.js";

const KEY = "alea.test.undo-lock";

class MemoryStorage {
  private entries = new Map<string, string>();
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  get size(): number {
    return this.entries.size;
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
});

describe("undo lock", () => {
  it("treats a missing key as allowed — every game predating the option keeps undo", () => {
    expect(isUndoAllowed(KEY)).toBe(true);
  });

  it("blocks undo once written, and releases it again", () => {
    setUndoAllowed(KEY, false);
    expect(isUndoAllowed(KEY)).toBe(false);

    setUndoAllowed(KEY, true);
    expect(isUndoAllowed(KEY)).toBe(true);
  });

  it("leaves no key behind when undo is allowed", () => {
    setUndoAllowed(KEY, false);
    setUndoAllowed(KEY, true);
    expect(storage.size).toBe(0);
  });

  it("keeps two games' locks apart", () => {
    setUndoAllowed("alea.quadra.undo-lock", false);
    expect(isUndoAllowed("alea.dame.undo-lock")).toBe(true);
  });

  it("falls back to allowed when storage throws (private mode)", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem() {
        throw new Error("storage disabled");
      },
      setItem() {
        throw new Error("storage disabled");
      },
      removeItem() {
        throw new Error("storage disabled");
      },
    };
    expect(() => setUndoAllowed(KEY, false)).not.toThrow();
    expect(isUndoAllowed(KEY)).toBe(true);
  });
});
