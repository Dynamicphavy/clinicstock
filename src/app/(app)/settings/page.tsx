"use client";

/**
 * Settings (brief section 4): clinic name, expiry warning window, users, roles
 * and clinic-level settings.
 *
 * User and role management is NOT here. It cannot be: there are no users in
 * demo mode, only a role switcher, and building a fake user list would be the
 * decorative UI the brief forbids. What IS here is everything that genuinely
 * works today, plus an honest statement of what milestone 6 adds.
 */

import { useState } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { useSession } from "@/app/providers";
import { DEFAULT_EXPIRY_BANDS } from "@/domain/types";
import { RequireCapability } from "@/components/layout/AppShell";
import {
  Alert, Button, Card, Field, PageHeader, TextInput,
} from "@/components/ui";

export default function SettingsPage() {
  return (
    <RequireCapability capability="configure_clinic">
      <SettingsScreen />
    </RequireCapability>
  );
}

function SettingsScreen() {
  const { clinicName, setClinicName, bands, setBands, resetDemo, today } = useSession();
  const [name, setName] = useState(clinicName);
  const [soon, setSoon] = useState(String(bands.soonDays));
  const [approaching, setApproaching] = useState(String(bands.approachingDays));
  const [saved, setSaved] = useState<string | null>(null);
  const [bandError, setBandError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const saveBands = () => {
    const s = Number(soon);
    const a = Number(approaching);
    setSaved(null);

    // Validated here rather than trusted, because the ordering matters: if the
    // "soon" window were larger than the "approaching" window, the bands in
    // expiryStatus would be unreachable and a whole status would silently
    // vanish from the app.
    if (!Number.isInteger(s) || !Number.isInteger(a) || s < 1 || a < 1) {
      setBandError("Both windows must be whole numbers of at least 1 day.");
      return;
    }
    if (s >= a) {
      setBandError("The 'expiring soon' window must be shorter than the 'approaching expiry' window.");
      return;
    }
    setBandError(null);
    setBands({ soonDays: s, approachingDays: a });
    setSaved("Expiry warning window saved.");
  };

  return (
    <>
      <PageHeader title="Settings" description="Clinic-level configuration. Changes apply to this browser's demo data." />

      {saved ? <div className="mb-4"><Alert tone="success">{saved}</Alert></div> : null}

      <div className="grid max-w-3xl gap-5">
        <Card className="p-5">
          <h2 className="text-sm font-semibold">Clinic</h2>
          <div className="mt-4 space-y-4">
            <Field label="Clinic name" htmlFor="clinic-name" hint="Shown in the sidebar and on reports.">
              <TextInput id="clinic-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Button
              onClick={() => {
                setClinicName(name.trim() || "Demo Clinic");
                setSaved("Clinic name saved.");
              }}
            >
              Save clinic name
            </Button>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-semibold">Expiry warning window</h2>
          <p className="mt-1 text-sm text-muted">
            These are operational warning bands, not a statement that stock is
            safe to use. Some products need an expiry date by law — agree those
            rules with the clinic.
          </p>

          {bandError ? <div className="mt-3"><Alert title="Could not save">{bandError}</Alert></div> : null}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Expiring soon (days)" htmlFor="soon" hint={"Default " + DEFAULT_EXPIRY_BANDS.soonDays + ". Anything within this window is flagged amber."}>
              <TextInput id="soon" type="number" min={1} step={1} value={soon} onChange={(e) => setSoon(e.target.value)} />
            </Field>
            <Field label="Approaching expiry (days)" htmlFor="approaching" hint={"Default " + DEFAULT_EXPIRY_BANDS.approachingDays + ". Must be longer than the window above."}>
              <TextInput id="approaching" type="number" min={2} step={1} value={approaching} onChange={(e) => setApproaching(e.target.value)} />
            </Field>
          </div>

          <p className="mt-3 text-xs text-muted">
            Today is {today}. With these settings, stock expiring up to {soon} days
            away shows as “expiring soon”, and up to {approaching} days as
            “approaching expiry”.
          </p>

          <Button className="mt-4" onClick={saveBands}>Save warning window</Button>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-semibold">Users and roles</h2>
          <p className="mt-1 text-sm text-muted">
            Not available in demo mode. Real accounts, invitations and role
            assignment arrive in milestone 6 with Supabase Auth and the
            <code className="mx-1 rounded bg-background px-1 py-0.5 text-xs">organization_members</code>
            table.
          </p>
          <Alert tone="info" title="Why the role switcher is not this">
            The sidebar role switcher is a testing aid. Once roles live in the
            database, a user cannot change their own — brief section 3: “A user
            must not be able to grant themselves administrator privileges.”
          </Alert>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-semibold">Demo data</h2>
          <p className="mt-1 text-sm text-muted">
            Restores the synthetic dataset and discards every movement recorded
            in this browser. Useful before a clinic walkthrough.
          </p>

          {/**
           * Two-step confirmation.
           *
           * The brief requires a reset-demo action, and this one destroys work
           * irreversibly. A single-click destructive button beside a "Save"
           * button is a mis-click waiting to happen.
           */}
          {confirmReset ? (
            <div className="mt-4 space-y-3">
              <Alert tone="error" title="This cannot be undone">
                <span className="flex items-start gap-1.5">
                  <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
                  Every product, batch and movement you have entered in this
                  browser will be replaced with the original synthetic data.
                </span>
              </Alert>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  onClick={() => {
                    resetDemo();
                    setConfirmReset(false);
                    setSaved("Demo data reset to the synthetic dataset.");
                  }}
                >
                  Yes, reset demo data
                </Button>
                <Button variant="secondary" onClick={() => setConfirmReset(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" className="mt-4" onClick={() => setConfirmReset(true)}>
              <RotateCcw size={15} aria-hidden /> Reset demo data
            </Button>
          )}
        </Card>
      </div>
    </>
  );
}
