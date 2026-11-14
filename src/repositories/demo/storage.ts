/**
 * Tiny key/value seam over localStorage.
 *
 * Why not call localStorage directly in the repository? Because `localStorage`
 * does not exist in Node, so the tests -- which are the whole point of
 * milestone 3 -- could not run. An in-memory implementation lets the same
 * repository code be exercised under Vitest and in the browser.
 */
export interface KeyValueStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

export class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>();
  read(key: string) {
    return this.map.get(key) ?? null;
  }
  write(key: string, value: string) {
    this.map.set(key, value);
  }
  remove(key: string) {
    this.map.delete(key);
  }
}

export class BrowserLocalStore implements KeyValueStore {
  /**
   * Every access is guarded. localStorage throws in private browsing modes and
   * when the quota is exceeded, and an unguarded throw here would take down a
   * whole screen over a storage preference.
   */
  read(key: string) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  write(key: string, value: string) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* quota or blocked storage: demo data simply does not persist */
    }
  }
  remove(key: string) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}
