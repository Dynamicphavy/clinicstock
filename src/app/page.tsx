"use client";

/**
 * Login screen (brief section 4).
 *
 * In demo mode there is NO authentication -- there is nothing to authenticate
 * against, and faking one would be a decorative screen that teaches the wrong
 * lesson. So this is honest: it shows the form that milestone 6 will wire up,
 * states plainly that it is not active, and lets you into the demo.
 *
 * The password field is deliberately inert and says so. A login box that
 * accepts anything trains people to trust a door that is not locked.
 */

import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Alert, Button, Card, Field, TextInput } from "@/components/ui";

export default function LoginPage() {
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

      <Card className="p-5">
        <Alert tone="warn" title="Demo build — sign-in is not active yet">
          Authentication, password reset and real user accounts arrive in
          milestone 6 with Supabase Auth. Nothing you type here is sent anywhere.
        </Alert>

        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => e.preventDefault()}
          aria-describedby="login-disabled"
        >
          <Field label="Email" htmlFor="email">
            <TextInput id="email" type="email" autoComplete="username" disabled placeholder="name@clinic.example" />
          </Field>
          <Field label="Password" htmlFor="password">
            <TextInput id="password" type="password" autoComplete="current-password" disabled />
          </Field>
          <p id="login-disabled" className="text-xs text-muted">
            These fields are disabled until authentication is implemented.
          </p>
        </form>

        <div className="mt-5 border-t border-line pt-5">
          <Link href="/dashboard">
            <Button className="w-full">Open the demo</Button>
          </Link>
          <p className="mt-2.5 flex items-start gap-1.5 text-xs text-muted">
            <ShieldAlert size={14} className="mt-px shrink-0" aria-hidden />
            Synthetic data only, stored in this browser. Do not enter real
            clinic or patient information.
          </p>
        </div>
      </Card>
    </main>
  );
}
