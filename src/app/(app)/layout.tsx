import { AppShell } from "@/components/layout/AppShell";

/**
 * Layout for the signed-in screens.
 *
 * `(app)` is a route GROUP -- the brackets mean it does not appear in the URL.
 * It exists so every screen except the login page gets the shell, without
 * repeating <AppShell> in eleven files or nesting the login page inside it.
 */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return <AppShell>{children}</AppShell>;
}
