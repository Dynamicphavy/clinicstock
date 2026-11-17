"use client";

/**
 * Decides whether the signed-in screens may render at all.
 *
 * Four states, each with a different correct answer -- which is why this is not
 * a boolean. Collapsing "still checking" into "signed out" is what produces the
 * flash of a login page on every refresh.
 *
 * NOT SECURITY. Every screen behind this gate reads data the database would
 * refuse to serve anyway; RLS does not care whether this component rendered.
 * This exists so a user sees the right screen, not so data stays private.
 */
import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useSession } from "@/app/providers";
import { Alert } from "@/components/ui";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { mode, status } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  // Navigation belongs in an effect, never in render: redirecting during a
  // render is a React error, and in a static export the router is only
  // available in the browser.
  useEffect(() => {
    if (mode !== "cloud") return;
    if (status === "signed_out") router.replace("/");
    else if (status === "no_clinic") router.replace("/onboarding");
  }, [mode, status, router, pathname]);

  if (mode === "demo") return <>{children}</>;

  if (status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <p className="text-sm text-muted" role="status">
          Checking your session…
        </p>
      </div>
    );
  }

  if (status === "signed_out" || status === "no_clinic") {
    // The redirect above is already running; this is the single frame before
    // it lands. Saying something true beats a blank screen.
    return (
      <div className="mx-auto max-w-md p-6">
        <Alert tone="info">
          {status === "signed_out" ? "Taking you to sign in…" : "Taking you to clinic setup…"}
        </Alert>
      </div>
    );
  }

  return <>{children}</>;
}
