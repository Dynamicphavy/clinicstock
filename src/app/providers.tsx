"use client";

/**
 * Session context, in two modes.
 *
 *   demo  -- localStorage, a role switcher, no accounts (brief section 9)
 *   cloud -- Supabase Auth, real membership, role read from the database
 *
 * Both expose the SAME shape, because every screen from milestone 4 consumes
 * this context and none of them should have to care. The mode is decided by
 * whether cloud credentials exist in the build, with an explicit override for
 * demonstrating to a clinic without touching their data.
 *
 * WHY `today` LIVES HERE: the domain functions refuse to read the clock (see
 * src/domain/expiry.ts). In cloud mode it comes from the organisation's stored
 * timezone, so the UI agrees with the SQL functions about what day it is.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  useSyncExternalStore,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import type { DateOnly, ExpiryBands, Role } from "@/domain/types";

import { todayInClinic, todayInTimezone } from "@/domain/dateOnly";
import { DemoInventoryRepository } from "@/repositories/demo/DemoInventoryRepository";
import { SupabaseInventoryRepository } from "@/repositories/supabase/SupabaseInventoryRepository";
import { BrowserLocalStore } from "@/repositories/demo/storage";
import { DEMO_ORG_ID, DEMO_USER_ID } from "@/repositories/demo/seed";
import type { ActorContext, InventoryRepository } from "@/repositories/InventoryRepository";
import { demoSettingsStore, type DemoSettings } from "@/app/demoStore";
import { getSupabase, isCloudConfigured } from "@/lib/supabase/client";

export type Mode = "demo" | "cloud";

/** Set NEXT_PUBLIC_CLINICSTOCK_MODE=demo to force the local demo. */
const FORCED_MODE = process.env.NEXT_PUBLIC_CLINICSTOCK_MODE as Mode | undefined;
export const MODE: Mode =
  FORCED_MODE === "demo" ? "demo" : isCloudConfigured ? "cloud" : "demo";

/** What the app knows about the signed-in user's clinic, in cloud mode. */
export interface Membership {
  organization_id: string;
  organization_name: string;
  timezone: string;
  role: Role;
}

type CloudStatus =
  | "loading"       // deciding whether there is a session
  | "signed_out"
  | "no_clinic"     // signed in, but belongs to no organisation yet
  | "ready";

interface SessionValue extends DemoSettings {
  mode: Mode;
  actor: ActorContext;
  today: DateOnly;
  repo: InventoryRepository;
  ready: boolean;
  version: number;
  refresh: () => void;

  /** Cloud only. In demo mode: "ready" and a null user. */
  status: CloudStatus;
  user: User | null;
  membership: Membership | null;
  signOut: () => Promise<void>;
  /** Re-reads membership after founding a clinic. */
  reloadMembership: () => Promise<void>;

  /** Demo only. Throws in cloud mode -- roles are not client-editable there. */
  setRole: (role: Role) => void;
  setClinicName: (name: string) => void;
  setBands: (bands: ExpiryBands) => void;
  resetDemo: () => void;
}

const Ctx = createContext<SessionValue | null>(null);

export function DemoSessionProvider({ children }: { children: React.ReactNode }) {
  const { settings, today: deviceToday, ready: storeReady } = useSyncExternalStore(
    demoSettingsStore.subscribe,
    demoSettingsStore.getSnapshot,
    demoSettingsStore.getServerSnapshot,
  );

  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const store = useMemo(() => new BrowserLocalStore(), []);

  /* ------------------------------------------------------------ cloud auth */

  const [status, setStatus] = useState<CloudStatus>(MODE === "cloud" ? "loading" : "ready");
  const [session, setSession] = useState<Session | null>(null);
  const [membership, setMembership] = useState<Membership | null>(null);

  /**
   * Reads the caller's one membership row.
   *
   * RLS means this needs no filter: the policy only exposes rows for
   * organisations the user belongs to. A clinic admin and a viewer run the
   * identical query and get their own row.
   */
  const loadMembership = useCallback(async (): Promise<Membership | null> => {
    const db = getSupabase();
    const { data, error } = await db
      .from("organization_members")
      .select("organization_id, role, organizations(name, timezone)")
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;
    const org = data.organizations as unknown as { name: string; timezone: string } | null;
    return {
      organization_id: data.organization_id as string,
      role: data.role as Role,
      organization_name: org?.name ?? "Clinic",
      timezone: org?.timezone ?? "UTC",
    };
  }, []);

  const reloadMembership = useCallback(async () => {
    if (MODE !== "cloud") return;
    const m = await loadMembership();
    setMembership(m);
    setStatus(m ? "ready" : "no_clinic");
    refresh();
  }, [loadMembership, refresh]);

  useEffect(() => {
    if (MODE !== "cloud") return;
    const db = getSupabase();
    let cancelled = false;

    /**
     * onAuthStateChange fires immediately with the restored session, so it
     * covers both "what is the session now" and "tell me when it changes".
     * A separate getSession() call first would race with it.
     */
    const { data: sub } = db.auth.onAuthStateChange((event, next) => {
      if (cancelled) return;
      setSession(next);

      if (!next) {
        setMembership(null);
        setStatus("signed_out");
        return;
      }
      // TOKEN_REFRESHED fires every hour; re-reading membership each time would
      // be a pointless query, and worse, a flash of "loading" over a working
      // screen.
      if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;

      setStatus("loading");
      void loadMembership().then((m) => {
        if (cancelled) return;
        setMembership(m);
        setStatus(m ? "ready" : "no_clinic");
      });
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [loadMembership]);

  /* ------------------------------------------------------- derived values */

  const actor = useMemo<ActorContext>(() => {
    if (MODE === "cloud") {
      return {
        user_id: session?.user?.id ?? "",
        organization_id: membership?.organization_id ?? "",
        // Default to the LEAST privilege while membership is unknown, so a
        // brief loading window cannot render admin controls.
        role: membership?.role ?? "viewer",
      };
    }
    return {
      user_id: DEMO_USER_ID,
      organization_id: DEMO_ORG_ID,
      role: settings.role,
    };
  }, [session, membership, settings.role]);

  const today = useMemo(
    () =>
      MODE === "cloud" && membership
        ? todayInTimezone(membership.timezone)
        : deviceToday || todayInClinic(),
    [membership, deviceToday],
  );

  const repo = useMemo<InventoryRepository>(() => {
    if (MODE === "cloud") {
      return new SupabaseInventoryRepository(getSupabase(), actor, today);
    }
    return new DemoInventoryRepository(actor, store, today);
  }, [actor, today, store]);

  const signOut = useCallback(async () => {
    if (MODE !== "cloud") return;
    await getSupabase().auth.signOut();
  }, []);

  const resetDemo = useCallback(() => {
    if (MODE !== "demo") return;
    (repo as DemoInventoryRepository).resetDemoData();
    refresh();
  }, [repo, refresh]);

  const demoOnly = (name: string) => () => {
    throw new Error(
      name + " is a demo-mode control. In cloud mode this comes from the " +
        "database and cannot be set by the client.",
    );
  };

  const value = useMemo<SessionValue>(
    () => ({
      ...settings,
      // In cloud mode the clinic name is the organisation's, not a local setting.
      clinicName: MODE === "cloud" ? membership?.organization_name ?? "ClinicStock" : settings.clinicName,
      role: actor.role,
      mode: MODE,
      actor,
      today,
      repo,
      ready: MODE === "cloud" ? status === "ready" : storeReady,
      version,
      refresh,
      status,
      user: session?.user ?? null,
      membership,
      signOut,
      reloadMembership,
      setRole: MODE === "demo" ? (role) => demoSettingsStore.set({ ...settings, role }) : demoOnly("setRole"),
      setClinicName: MODE === "demo" ? (clinicName) => demoSettingsStore.set({ ...settings, clinicName }) : demoOnly("setClinicName"),
      setBands: (bands) => demoSettingsStore.set({ ...settings, bands }),
      resetDemo,
    }),
    [settings, actor, today, repo, storeReady, version, refresh, status, session, membership, signOut, reloadMembership, resetDemo],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession must be used inside DemoSessionProvider");
  return ctx;
}
