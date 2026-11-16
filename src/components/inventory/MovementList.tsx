"use client";

/**
 * Append-only movement history (brief section 2: "Append-only movement history
 * with user and timestamp").
 *
 * There is no edit control and no delete control anywhere in this component,
 * and that absence is the feature. A correction is a new reversal row, which
 * appears here alongside the movement it compensates.
 */

import type { MovementType, StockMovement } from "@/domain/types";
import { EmptyState } from "@/components/ui";

const TYPE_LABEL: Record<MovementType, string> = {
  receipt: "Received",
  issue: "Issued",
  adjustment: "Adjustment",
  reversal: "Reversal",
};

const TYPE_STYLE: Record<MovementType, string> = {
  receipt: "bg-accent-soft text-accent border-accent/25",
  issue: "bg-info-soft text-info border-info/25",
  adjustment: "bg-warn-soft text-warn border-warn/25",
  reversal: "bg-danger-soft text-danger border-danger/25",
};

/** Absolute, unambiguous, and the same string for every reader. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

export function MovementList({
  movements,
  batchLabel,
  emptyHint,
}: {
  movements: StockMovement[];
  /** Resolves a batch id to its batch number for display. */
  batchLabel?: (batchId: string) => string;
  emptyHint?: string;
}) {
  if (movements.length === 0) {
    return (
      <EmptyState title="No movements recorded">
        {emptyHint ?? "Stock receipts, usage and adjustments will appear here."}
      </EmptyState>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Stock movement history, most recent first</caption>
        <thead className="bg-background text-left text-xs tracking-wide text-muted uppercase">
          <tr>
            <th scope="col" className="px-3 py-2.5 font-medium">When</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Type</th>
            {batchLabel ? <th scope="col" className="px-3 py-2.5 font-medium">Batch</th> : null}
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Change</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Reason</th>
            <th scope="col" className="px-3 py-2.5 font-medium">By</th>
          </tr>
        </thead>
        <tbody>
          {movements.map((m) => (
            <tr key={m.id} className="border-t border-line">
              <td className="px-3 py-2.5 whitespace-nowrap text-muted">{formatWhen(m.created_at)}</td>
              <td className="px-3 py-2.5">
                <span className={"inline-flex rounded-full border px-2 py-0.5 text-xs font-medium " + TYPE_STYLE[m.movement_type]}>
                  {TYPE_LABEL[m.movement_type]}
                </span>
              </td>
              {batchLabel ? (
                <td className="tabular px-3 py-2.5 text-muted">{batchLabel(m.batch_id)}</td>
              ) : null}
              {/* The sign is shown explicitly. "20" and "-20" differing only by
                  a character that is easy to miss is how a reader mistakes an
                  issue for a receipt. */}
              <td className={"tabular px-3 py-2.5 text-right font-medium " + (m.quantity_delta < 0 ? "text-danger" : "text-accent")}>
                {m.quantity_delta > 0 ? "+" : ""}{m.quantity_delta}
              </td>
              <td className="px-3 py-2.5">
                {m.reason ?? <span className="text-muted">—</span>}
                {m.notes ? <p className="text-xs text-muted">{m.notes}</p> : null}
                {m.reverses_movement_id ? (
                  <p className="text-xs text-muted">Reverses an earlier movement</p>
                ) : null}
              </td>
              <td className="px-3 py-2.5 text-muted">{m.performed_by}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
