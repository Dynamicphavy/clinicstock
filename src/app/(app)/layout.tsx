import { AppShell } from "@/components/layout/AppShell";
import { AuthGate } from "@/components/layout/AuthGate";

/**
 * Layout for the signed-in screens.
 *
 * `(app)` is a route GROUP -- the brackets mean it does not appear in the URL.
 * The gate wraps the shell rather than the other way round, so a signed-out
 * visitor never sees a navigation sidebar for a clinic they cannot read.
 */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <AuthGate>
      <AppShell>{children}</AppShell>
    </AuthGate>
  );
}
