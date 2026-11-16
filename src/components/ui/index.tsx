"use client";

/**
 * Small UI primitives.
 *
 * Deliberately plain: no component library, no variants nobody uses. The brief
 * asks for "compact tables" and "readable status labels", and every one of these
 * exists because at least two screens needed it.
 */

import type { ReactNode } from "react";
import type { ExpiryStatus } from "@/domain/types";
import { EXPIRY_STATUS_LABEL } from "@/domain/expiry";

/* ------------------------------------------------------------------ Button */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
  /**
   * While true the button is disabled and shows its pending label.
   *
   * This is brief section 7's "prevent accidental duplicate submissions". A
   * double-clicked receipt form would post two +100 movements, and the second
   * one is indistinguishable from a real second delivery.
   */
  pending?: boolean;
  pendingLabel?: string;
};

export function Button({
  variant = "primary",
  pending = false,
  pendingLabel = "Working...",
  children,
  className = "",
  disabled,
  ...rest
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-offset-2";
  const styles = {
    primary: "bg-accent text-white hover:bg-accent-hover focus-visible:outline-accent",
    secondary:
      "border border-line bg-surface text-foreground hover:bg-background focus-visible:outline-accent",
    danger: "bg-danger text-white hover:brightness-90 focus-visible:outline-danger",
  }[variant];

  return (
    <button
      {...rest}
      disabled={disabled || pending}
      className={base + " " + styles + " " + className}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}

/* ------------------------------------------------------------------- Field */

/**
 * Label + control + error, wired for screen readers.
 *
 * `aria-describedby` and `aria-invalid` are not decoration: without them a
 * blind user hears "Quantity, edit text" and no error at all, and the brief
 * asks for accessible forms.
 */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  const describedBy = [error ? htmlFor + "-error" : null, hint ? htmlFor + "-hint" : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-foreground">
        {label}
        {required ? <span className="ml-0.5 text-danger">*</span> : null}
      </label>
      <div aria-describedby={describedBy || undefined}>{children}</div>
      {hint ? (
        <p id={htmlFor + "-hint"} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        // role="alert" so the message is announced the moment it appears.
        <p id={htmlFor + "-error"} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const controlClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent aria-[invalid=true]:border-danger";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={controlClass + " " + (props.className ?? "")} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={controlClass + " " + (props.className ?? "")} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={controlClass + " " + (props.className ?? "")} />;
}

/* ------------------------------------------------------------------ Badges */

/**
 * Expiry badge.
 *
 * Carries a TEXT label as well as a colour. Status by colour alone fails for
 * colour-blind users and in a black-and-white printout of a stock report --
 * both of which happen in clinics.
 */
export function ExpiryBadge({ status }: { status: ExpiryStatus }) {
  const styles: Record<ExpiryStatus, string> = {
    expired: "bg-danger-soft text-danger border-danger/25",
    expiring_soon: "bg-warn-soft text-warn border-warn/25",
    approaching_expiry: "bg-info-soft text-info border-info/25",
    valid: "bg-accent-soft text-accent border-accent/25",
    no_expiry_recorded: "bg-background text-muted border-line",
  };
  return (
    <span
      className={
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap " +
        styles[status]
      }
    >
      {EXPIRY_STATUS_LABEL[status]}
    </span>
  );
}

export function StockBadge({ low }: { low: boolean }) {
  return (
    <span
      className={
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap " +
        (low
          ? "bg-warn-soft text-warn border-warn/25"
          : "bg-accent-soft text-accent border-accent/25")
      }
    >
      {low ? "Low stock" : "In stock"}
    </span>
  );
}

/* ------------------------------------------------------------- Page states */

export function Alert({
  tone = "error",
  title,
  children,
}: {
  tone?: "error" | "warn" | "info" | "success";
  title?: string;
  children: ReactNode;
}) {
  const styles = {
    error: "bg-danger-soft text-danger border-danger/25",
    warn: "bg-warn-soft text-warn border-warn/25",
    info: "bg-info-soft text-info border-info/25",
    success: "bg-accent-soft text-accent border-accent/25",
  }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={"rounded-md border p-3 text-sm " + styles}>
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className={title ? "mt-0.5" : ""}>{children}</div>
    </div>
  );
}

/** Skeleton rows. Sized like the real table so the layout does not jump. */
export function LoadingRows({ rows = 4, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <tbody aria-busy="true">
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-t border-line">
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c} className="px-3 py-3">
              <div className="h-3.5 w-full max-w-[12rem] animate-pulse rounded bg-line" />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

/**
 * Empty state.
 *
 * `action` is optional and there is deliberately no placeholder button: brief
 * section 14 says "no decorative or non-functional buttons". An empty state
 * that offers a dead end is worse than one that just explains itself.
 */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface px-6 py-10 text-center">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {children ? <p className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Card({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return (
    <div className={"rounded-lg border border-line bg-surface " + className}>{children}</div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "neutral" | "warn" | "danger" | "accent";
}) {
  const valueTone = {
    neutral: "text-foreground",
    warn: "text-warn",
    danger: "text-danger",
    accent: "text-accent",
  }[tone];
  return (
    <Card className="p-4">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">{label}</p>
      <p className={"tabular mt-1.5 text-2xl font-semibold " + valueTone}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-muted">{sub}</p> : null}
    </Card>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
