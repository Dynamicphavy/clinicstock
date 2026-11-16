"use client";

/**
 * Demo session context.
 *
 * Holds the four things every screen needs and nothing else: who is acting,
 * what "today" is, the clinic's expiry window, and the repository.
 *
 * WHY `today` LIVES HERE: the domain functions refuse to read the clock
 * themselves (see src/domain/expiry.ts). Something has to supply it, and it has
 * to be ONE value for the whole render -- if each component called the clock
 * separately, a page rendering across midnight could show a batch as "expiring
 * soon" in the table and "expired" in the badge beside it.
 *
 * WHY A `version` COUNTER: after a stock movement the screens must refetch.
 * Rather than a data-fetching library, mutations bump `version`, and every data
 * hook lists it as a dependency. Crude, but it is honest about when data is
 * stale and it adds no dependency to explain.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { DateOnly, ExpiryBands, Role } from "@/domain/types";
import { DemoInventoryRepository } from "@/repositories/demo/DemoInventoryRepository";
import { BrowserLocalStore } from "@/repositories/demo/storage";
import { DEMO_ORG_ID, DEMO_USER_ID } from "@/repositories/demo/seed";
import type { ActorContext } from "@/repositories/InventoryRepository";
import { demoSettingsStore, type DemoSettings } from "@/app/demoStore";

interface DemoSession extends DemoSettings {
  actor: ActorContext;
  today: DateOnly;
  repo: DemoInventoryRepository;
  /** False during the static prerender; screens show a loading state until true. */
  ready: boolean;
  version: number;
  refresh: () => void;
  setRole: (role: Role) => void;
  setClinicName: (name: string) => void;
  setBands: (bands: ExpiryBands) => void;
  resetDemo: () => void;
}

const Ctx = createContext<DemoSession | null>(null);

export function DemoSessionProvider({ children }: { children: React.ReactNode }) {
  const { settings, today, ready } = useSyncExternalStore(
    demoSettingsStore.subscribe,
    demoSettingsStore.getSnapshot,
    demoSettingsStore.getServerSnapshot,
  );

  const [version, setVersion] = useState(0);
  const store = useMemo(() => new BrowserLocalStore(), []);

  const actor = useMemo<ActorContext>(
    () => ({
      user_id: DEMO_USER_ID,
      organization_id: DEMO_ORG_ID,
      role: settings.role,
    }),
    [settings.role],
  );

  /**
   * Rebuilt when the actor or the date changes, so a role switch cannot leave a
   * repository behind that still believes it is acting as an admin.
   */
  const repo = useMemo(
    () => new DemoInventoryRepository(actor, store, today),
    [actor, store, today],
  );

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const resetDemo = useCallback(() => {
    repo.resetDemoData();
    refresh();
  }, [repo, refresh]);

  const value = useMemo<DemoSession>(
    () => ({
      ...settings,
      actor,
      today,
      repo,
      ready,
      version,
      refresh,
      setRole: (role) => demoSettingsStore.set({ ...settings, role }),
      setClinicName: (clinicName) => demoSettingsStore.set({ ...settings, clinicName }),
      setBands: (bands) => demoSettingsStore.set({ ...settings, bands }),
      resetDemo,
    }),
    [settings, actor, today, repo, ready, version, refresh, resetDemo],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): DemoSession {
  const ctx = useContext(Ctx);
  // A clear error beats `undefined.repo` three stack frames deeper.
  if (!ctx) throw new Error("useSession must be used inside DemoSessionProvider");
  return ctx;
}
