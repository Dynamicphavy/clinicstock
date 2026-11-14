/**
 * Role capabilities from brief section 3.
 *
 * IMPORTANT: this module exists for USABILITY -- hiding buttons a user cannot
 * use. It is NOT the security boundary. Anyone can open devtools and call the
 * API directly, so the real check is repeated inside the PostgreSQL functions
 * and Row Level Security policies in milestone 5. The brief is explicit:
 * "Enforce permissions in PostgreSQL Row Level Security and database functions,
 * not only by hiding buttons."
 */
import type { Role } from "./types";

export type Capability =
  | "view_inventory"
  | "manage_products"
  | "move_stock"
  | "view_movement_history"
  | "export_reports"
  | "manage_users"
  | "configure_clinic";

const CAPABILITIES: Record<Role, Capability[]> = {
  admin: [
    "view_inventory",
    "manage_products",
    "move_stock",
    "view_movement_history",
    "export_reports",
    "manage_users",
    "configure_clinic",
  ],
  inventory_officer: [
    "view_inventory",
    "manage_products",
    "move_stock",
    "view_movement_history",
    "export_reports",
  ],
  // A viewer may look and export, nothing else. Note what is absent:
  // `manage_users`, so a user can never grant themselves admin.
  viewer: ["view_inventory", "export_reports"],
};

export function can(role: Role, capability: Capability): boolean {
  return CAPABILITIES[role].includes(capability);
}
