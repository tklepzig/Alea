// localStorage can throw (private mode, storage disabled). Degrade to an
// unsaved-but-playable session instead of failing to boot. Shared by all games;
// each game namespaces its keys as `${APP_ID}.<game>.<what>`.

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — play on without persistence */
  }
}

export function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}
