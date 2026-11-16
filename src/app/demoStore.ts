/**
 * External store for demo settings.
 *
 * WHY NOT just `useEffect(() => setState(readLocalStorage()), [])`?
 *
 * Two reasons, and React's compiler lint rules flag the first:
 *
 * 1. Setting state synchronously inside an effect causes a second render pass
 *    on every mount -- React renders with defaults, the effect fires, state
 *    changes, React renders again. `useSyncExternalStore` reads the value
 *    during the render that needs it.
 *
 * 2. localStorage is a value that lives OUTSIDE React and can change without
 *    React's knowledge -- including from another browser tab. An effect reads
 *    it once and then drifts. This store listens for `storage` events, so two
 *    tabs of the demo stay consistent.
 *
 * `getServerSnapshot` is what the static prerender uses. React renders the
 * server snapshot, then re-renders with the client snapshot on hydration --
 * which is precisely the mechanism that avoids a hydration mismatch, rather
 * than us papering over one with a mounted flag.
 */
import type { DateOnly, ExpiryBands, Role } from "@/domain/types";
import { DEFAULT_EXPIRY_BANDS } from "@/domain/types";
import { todayInClinic } from "@/domain/dateOnly";
import { DEMO_ORG_NAME } from "@/repositories/demo/seed";

const SETTINGS_KEY = "clinicstock.demo.settings.v1";

export interface DemoSettings {
  role: Role;
  clinicName: string;
  bands: ExpiryBands;
}

export const DEFAULT_SETTINGS: DemoSettings = {
  role: "admin",
  clinicName: DEMO_ORG_NAME,
  bands: DEFAULT_EXPIRY_BANDS,
};

export interface DemoState {
  settings: DemoSettings;
  /** The clinic's local today, resolved once per browser session. */
  today: DateOnly;
  /**
   * False only in the server snapshot. Screens show a loading state until it
   * is true, so no screen ever renders seed data as though it were the user's.
   */
  ready: boolean;
}

/** Stable object identity: `useSyncExternalStore` compares snapshots by
 *  reference, so returning a fresh object each call would loop forever. */
const SERVER_STATE: DemoState = {
  settings: DEFAULT_SETTINGS,
  today: todayInClinic(),
  ready: false,
};

function readSettings(): DemoSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    // Spread over the defaults so a settings blob written by an older version
    // of the app, missing a field added since, does not render `undefined`.
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<DemoSettings>) };
  } catch {
    // Blocked storage, private browsing, or corrupt JSON: defaults, not a crash.
    return DEFAULT_SETTINGS;
  }
}

class DemoSettingsStore {
  private listeners = new Set<() => void>();
  private snapshot: DemoState | null = null;

  /** Another tab wrote settings: drop the cache and let React re-read. */
  private onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== SETTINGS_KEY) return;
    this.snapshot = null;
    this.emit();
  };

  private emit() {
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size === 0) window.addEventListener("storage", this.onStorage);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) window.removeEventListener("storage", this.onStorage);
    };
  };

  getSnapshot = (): DemoState => {
    this.snapshot ??= { settings: readSettings(), today: todayInClinic(), ready: true };
    return this.snapshot;
  };

  getServerSnapshot = (): DemoState => SERVER_STATE;

  set = (settings: DemoSettings): void => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* quota or blocked storage: the change still applies for this session */
    }
    this.snapshot = { settings, today: this.getSnapshot().today, ready: true };
    this.emit();
  };
}

export const demoSettingsStore = new DemoSettingsStore();
