"use client";

/**
 * Application frame: demo banner, sidebar navigation, role switcher.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ClipboardList,
  FileText,
  LayoutDashboard,
  LogOut,
  Package,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import type { Role } from "@/domain/types";
import { can, type Capability } from "@/domain/permissions";
import { useSession } from "@/app/providers";
import { Select } from "@/components/ui";

interface NavItem {
  href: string;
  label: string;
  icon: typeof Package;
  /** Hidden when the role lacks this. Convenience only -- see the note below. */
  requires?: Capability;
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/inventory", label: "Inventory", icon: Package },
  { href: "/receive", label: "Receive stock", icon: ArrowDownToLine, requires: "move_stock" },
  { href: "/issue", label: "Record usage", icon: ArrowUpFromLine, requires: "move_stock" },
  { href: "/adjust", label: "Adjustment", icon: SlidersHorizontal, requires: "move_stock" },
  { href: "/movements", label: "Movement history", icon: ClipboardList, requires: "view_movement_history" },
  { href: "/reports", label: "Reports", icon: FileText, requires: "export_reports" },
  { href: "/settings", label: "Settings", icon: Settings, requires: "configure_clinic" },
];

const ROLE_LABEL: Record<Role, string> = {
  admin: "Administrator",
  inventory_officer: "Inventory officer",
  viewer: "Viewer (read-only)",
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const { role, setRole, clinicName, mode, user, signOut } = useSession();
  const pathname = usePathname();

  const visible = NAV.filter((item) => !item.requires || can(role, item.requires));

  return (
    <div className="min-h-dvh">
      {/**
       * The DEMO banner, required by brief section 9.
       *
       * Demo mode ONLY. Not dismissible there, so nobody can mistake a
       * localStorage demo for a real record system. In cloud mode it is
       * removed rather than reworded: this is a real clinic's real stock, and
       * a banner calling it synthetic would be its own kind of lie.
       */}
      {mode === "demo" ? (
        <div className="bg-warn-soft border-b border-warn/25 px-4 py-2 text-center text-xs font-medium text-warn">
          DEMO MODE &middot; synthetic data in this browser only &middot; not for real clinic records
        </div>
      ) : null}

      <div className="mx-auto flex max-w-7xl flex-col gap-0 md:flex-row">
        {/* Sidebar on desktop, horizontal scroller on mobile: the brief asks for
            desktop and tablet layouts, and a stock room often uses a tablet. */}
        <aside className="border-b border-line bg-surface md:min-h-dvh md:w-60 md:shrink-0 md:border-r md:border-b-0">
          <div className="flex items-center gap-2 px-4 py-4">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-sm font-bold text-white">
              CS
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">ClinicStock</p>
              <p className="truncate text-xs text-muted">{clinicName}</p>
            </div>
          </div>

          <nav aria-label="Main" className="px-2 pb-3">
            <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
              {visible.map(({ href, label, icon: Icon }) => {
                const active = pathname === href || pathname.startsWith(href + "/");
                return (
                  <li key={href} className="shrink-0">
                    <Link
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={
                        "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors " +
                        (active
                          ? "bg-accent-soft font-medium text-accent"
                          : "text-foreground hover:bg-background")
                      }
                    >
                      <Icon size={16} aria-hidden />
                      {label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/**
           * Role switcher.
           *
           * A DEMO AFFORDANCE, not a feature. It exists so the §11 permission
           * tests can be performed by hand without creating three accounts. In
           * the real build the role comes from `organization_members` and the
           * verified JWT, and no user can change their own -- brief section 3:
           * "A user must not be able to grant themselves administrator
           * privileges." This control must not survive into milestone 6.
           */}
          <div className="mt-auto border-t border-line px-4 py-3">
            {mode === "demo" ? (
              <>
                <label htmlFor="demo-role" className="block text-xs font-medium text-muted">
                  Demo: act as
                </label>
                <Select
                  id="demo-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                  className="mt-1.5 text-xs"
                >
                  {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </Select>
                <p className="mt-1.5 text-[11px] leading-snug text-muted">
                  Demo control only. Real roles come from the database.
                </p>
              </>
            ) : (
              /**
               * In cloud mode the role is DISPLAYED, never chosen. It comes
               * from organization_members, a row the user cannot write, and
               * every stock function re-reads it server-side. Brief section 3:
               * "A user must not be able to grant themselves administrator
               * privileges."
               */
              <>
                <p className="truncate text-xs font-medium text-foreground" title={user?.email ?? ""}>
                  {user?.email ?? "Signed in"}
                </p>
                <p className="mt-0.5 text-[11px] text-muted">{ROLE_LABEL[role]}</p>
                <button
                  onClick={() => void signOut()}
                  className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-background"
                >
                  <LogOut size={13} aria-hidden /> Sign out
                </button>
              </>
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}

/**
 * Guard for a whole screen.
 *
 * Note what this is NOT. Hiding a nav link stops an accident; this stops
 * someone typing the URL. Neither is security -- the repository re-checks the
 * role, and in milestone 5 PostgreSQL re-checks it again, which is the only
 * check that counts. Three layers, one of them real.
 */
export function RequireCapability({
  capability,
  children,
}: {
  capability: Capability;
  children: React.ReactNode;
}) {
  const { role } = useSession();
  if (!can(role, capability)) {
    return (
      <div className="rounded-lg border border-line bg-surface p-6">
        <h1 className="text-base font-semibold">Permission denied</h1>
        <p className="mt-1 text-sm text-muted">
          Your role ({ROLE_LABEL[role]}) cannot open this screen. Ask an
          administrator if you need access.
        </p>
        <Link
          href="/dashboard"
          className="mt-4 inline-block text-sm font-medium text-accent hover:underline"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }
  return <>{children}</>;
}
