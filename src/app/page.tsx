"use client";

/**
 * Login and sign-up (brief section 4).
 *
 * In demo mode this is a labelled, inert form -- there is nothing to
 * authenticate against. In cloud mode it is real Supabase Auth.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MailCheck, ShieldAlert } from "lucide-react";
import { useSession } from "@/app/providers";
import { getSupabase } from "@/lib/supabase/client";
import { Alert, Button, Card, Field, TextInput } from "@/components/ui";

export default function LoginPage() {
  const { mode } = useSession();
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-md bg-accent text-sm font-bold text-white">
          CS
        </span>
        <div>
          <h1 className="text-lg font-semibold">ClinicStock</h1>
          <p className="text-xs text-muted">Clinic inventory management</p>
        </div>
      </div>
      {mode === "cloud" ? <CloudAuth /> : <DemoNotice />}
    </main>
  );
}

/* ------------------------------------------------------------- cloud auth */

type Tab = "sign_in" | "sign_up";

function CloudAuth() {
  const { status } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("sign_in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState(false);

  // Already signed in (a refresh, or a second tab): go straight through.
  useEffect(() => {
    if (status === "ready") router.replace("/dashboard");
    else if (status === "no_clinic") router.replace("/onboarding");
  }, [status, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setConfirmSent(false);
    setBusy(true);
    try {
      const db = getSupabase();
      if (tab === "sign_in") {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) {
          // Supabase deliberately returns the same message for a wrong password
          // and an unknown email, so the form cannot be used to discover who
          // has an account. Passing it through unchanged keeps that property.
          setError(
            /email not confirmed/i.test(error.message)
              ? "That address has not been confirmed yet. Check your inbox for the confirmation link."
              : error.message,
          );
          return;
        }
        // The provider's auth listener takes it from here.
      } else {
        const { data, error } = await db.auth.signUp({
          email,
          password,
          // Read by the on_auth_user_created trigger from 0004 to populate
          // profiles.full_name.
          options: { data: { full_name: fullName.trim() } },
        });
        if (error) {
          setError(error.message);
          return;
        }
        // No session means the project requires email confirmation. Saying so
        // is essential -- otherwise the screen looks like it did nothing.
        if (!data.session) setConfirmSent(true);
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? "Could not reach the server: " + e.message
          : "Could not reach the server.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (confirmSent) {
    return (
      <Card className="p-5">
        <Alert tone="success" title="Check your email">
          <span className="flex items-start gap-1.5">
            <MailCheck size={15} className="mt-0.5 shrink-0" aria-hidden />
            We sent a confirmation link to {email}. Click it, then come back and
            sign in.
          </span>
        </Alert>
        <Button variant="secondary" className="mt-4 w-full" onClick={() => { setConfirmSent(false); setTab("sign_in"); }}>
          Back to sign in
        </Button>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="mb-5 flex rounded-md border border-line p-0.5" role="tablist">
        {([["sign_in", "Sign in"], ["sign_up", "Create account"]] as [Tab, string][]).map(([v, label]) => (
          <button
            key={v}
            role="tab"
            aria-selected={tab === v}
            onClick={() => { setTab(v); setError(null); }}
            className={
              "flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors " +
              (tab === v ? "bg-accent-soft text-accent" : "text-muted hover:text-foreground")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {error ? <div className="mb-4"><Alert title="Could not continue">{error}</Alert></div> : null}

      <form onSubmit={submit} className="space-y-4" noValidate>
        {tab === "sign_up" ? (
          <Field label="Your name" htmlFor="full_name" required>
            <TextInput id="full_name" value={fullName} onChange={(e) => setFullName(e.target.value)}
              autoComplete="name" required />
          </Field>
        ) : null}

        <Field label="Email" htmlFor="email" required>
          <TextInput id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            autoComplete="username" required />
        </Field>

        <Field
          label="Password" htmlFor="password" required
          hint={tab === "sign_up" ? "At least 6 characters." : undefined}
        >
          <TextInput id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete={tab === "sign_up" ? "new-password" : "current-password"} required minLength={6} />
        </Field>

        <Button type="submit" className="w-full" pending={busy}
          pendingLabel={tab === "sign_in" ? "Signing in…" : "Creating account…"}>
          {tab === "sign_in" ? "Sign in" : "Create account"}
        </Button>
      </form>

      {/* No "forgot password" link until the reset flow exists -- section 14,
          no non-functional buttons. */}
      <p className="mt-4 flex items-start gap-1.5 border-t border-line pt-4 text-xs text-muted">
        <ShieldAlert size={14} className="mt-px shrink-0" aria-hidden />
        Use synthetic data only. Do not enter real patient information — this
        system stores clinic stock, never patient records.
      </p>
    </Card>
  );
}

/* -------------------------------------------------------------- demo mode */

function DemoNotice() {
  return (
    <Card className="p-5">
      <Alert tone="warn" title="Demo build — sign-in is not active">
        This build has no Supabase credentials, so it runs on synthetic data in
        this browser only. Nothing you type here is sent anywhere.
      </Alert>
      <div className="mt-5 border-t border-line pt-5">
        <Link href="/dashboard">
          <Button className="w-full">Open the demo</Button>
        </Link>
      </div>
    </Card>
  );
}
