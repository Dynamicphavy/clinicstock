"use client";

/**
 * Found a clinic — the first screen a new account sees.
 *
 * Calls create_organization() from 0004, which creates the organisation AND the
 * caller's admin membership in one transaction. There is no INSERT policy on
 * `organizations`, so this function is the only route in. That is deliberate: a
 * clinic created without an administrator would be unreachable and unfixable.
 *
 * Deliberately OUTSIDE the (app) route group, so it renders without the
 * navigation shell. A sidebar full of links to a clinic that does not exist yet
 * would be nine dead ends.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";
import { useSession } from "@/app/providers";
import { getSupabase } from "@/lib/supabase/client";
import { mapPostgrestError, networkError } from "@/lib/supabase/errors";
import { todayInTimezone } from "@/domain/dateOnly";
import { Alert, Button, Card, Field, Select, TextInput } from "@/components/ui";

/**
 * A short list rather than every IANA zone.
 *
 * The timezone decides what "today" means for every expiry calculation in the
 * clinic, so it must be a deliberate choice, not a scroll through 400 entries
 * where Africa/Abidjan sits one row from Africa/Accra. The browser's guess is
 * offered first and can be overridden.
 */
const COMMON_ZONES = [
  "Africa/Lagos", "Africa/Accra", "Africa/Nairobi", "Africa/Johannesburg",
  "Africa/Cairo", "Europe/London", "Europe/Paris", "Asia/Dubai",
  "Asia/Kolkata", "America/New_York", "UTC",
];

export default function OnboardingPage() {
  const { mode, status, user, reloadMembership } = useSession();
  const router = useRouter();

  const guessedZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(guessedZone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const zones = useMemo(
    () => (COMMON_ZONES.includes(guessedZone) ? COMMON_ZONES : [guessedZone, ...COMMON_ZONES]),
    [guessedZone],
  );

  useEffect(() => {
    if (mode !== "cloud") router.replace("/dashboard");
    else if (status === "signed_out") router.replace("/");
    else if (status === "ready") router.replace("/dashboard");
  }, [mode, status, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const db = getSupabase();
      const { data, error: rpcError } = await db.rpc("create_organization", {
        p_name: name.trim(),
        p_timezone: timezone,
      });
      if (rpcError) {
        setError(mapPostgrestError(rpcError).message);
        return;
      }

      // Default categories, so the inventory filters are not empty on day one.
      // A failure here is not fatal: the clinic exists and categories can be
      // added by hand, so it must not block the redirect.
      const orgId = (data as { id?: string } | null)?.id;
      if (orgId) {
        await db.rpc("seed_default_categories", { p_organization_id: orgId });
      }

      await reloadMembership();
      router.replace("/dashboard");
    } catch (err) {
      setError(networkError(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (mode !== "cloud" || status !== "no_clinic") {
    return (
      <main className="mx-auto max-w-md p-6">
        <Alert tone="info">One moment…</Alert>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-md bg-accent text-white">
          <Building2 size={18} aria-hidden />
        </span>
        <div>
          <h1 className="text-lg font-semibold">Set up your clinic</h1>
          <p className="text-xs text-muted">
            Signed in as {user?.email ?? "your account"}
          </p>
        </div>
      </div>

      <Card className="p-5">
        <p className="text-sm text-muted">
          Your account is not linked to a clinic yet. Creating one makes you its
          administrator — you can invite colleagues afterwards.
        </p>

        {error ? <div className="mt-4"><Alert title="Could not create the clinic">{error}</Alert></div> : null}

        <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
          <Field label="Clinic name" htmlFor="clinic" required
            hint="Shown in the sidebar and on every report.">
            <TextInput id="clinic" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Riverside Medical Centre" required minLength={2} />
          </Field>

          <Field
            label="Clinic timezone" htmlFor="tz" required
            hint="Decides what counts as today for every expiry date. The database uses this, not your device clock."
          >
            <Select id="tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z === guessedZone ? z + "  (detected)" : z}
                </option>
              ))}
            </Select>
          </Field>

          <p className="tabular rounded-md bg-background px-3 py-2 text-xs text-muted">
            Today in {timezone} is {todayInTimezone(timezone)}.
          </p>

          <Button type="submit" className="w-full" pending={busy} pendingLabel="Creating…"
            disabled={name.trim().length < 2}>
            Create clinic
          </Button>
        </form>
      </Card>
    </main>
  );
}
