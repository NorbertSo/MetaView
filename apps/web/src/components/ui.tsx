import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-muted mt-1 max-w-3xl">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = "", bodyClass = "card-b" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-h">
          <h2 className="card-t">{title}</h2>
          {actions && <div className="flex gap-2">{actions}</div>}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "good" | "bad" | "warn" }) {
  const color = tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "";
  return (
    <div className="card px-5 py-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${color}`}>{value}</div>
      {hint && <div className="text-xs text-muted mt-1">{hint}</div>}
    </div>
  );
}

const TONES: Record<string, string> = {
  good: "bg-good/12 text-good border-good/30",
  bad: "bg-bad/12 text-bad border-bad/30",
  warn: "bg-warn/12 text-warn border-warn/30",
  info: "bg-accent/12 text-accent border-accent/30",
  muted: "bg-panel-2 text-muted border-line",
};

const STATUS_TONE: Record<string, keyof typeof TONES> = {
  active: "good", connected: "good", ok: "good", executed: "good", accepted: "good", done: "good", approved: "good", passed: "good", open: "info",
  paused: "warn", deploying: "warn", pending: "warn", queued: "warn", running: "warn", candidate: "warn", stale: "warn", untested: "muted", in_progress: "warn",
  killed: "bad", error: "bad", failed: "bad", rejected: "bad", rejected_risk: "bad", disconnected: "bad", critical: "bad", never: "muted",
  draft: "muted", archived: "muted", retired: "muted", undeployed: "muted", closed: "muted", recorded: "muted", disabled: "muted", submitted: "info",
  warn: "warn", info: "info", debug: "muted",
};

export function Badge({ tone = "muted", children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={`badge ${TONES[tone]}`}>{children}</span>;
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "muted"}>{label ?? status}</Badge>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-sm text-muted py-8 text-center">{children}</div>;
}

export function Flash({ msg, err }: { msg?: string; err?: string }) {
  if (!msg && !err) return null;
  return (
    <div className={`mb-5 rounded-lg border px-4 py-3 text-sm ${err ? "border-bad/40 bg-bad/10 text-bad" : "border-good/40 bg-good/10 text-good"}`}>
      {err ?? msg}
    </div>
  );
}

export function KV({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Tabs({ items, current }: { items: { href: string; label: string; key: string }[]; current: string }) {
  return (
    <div className="flex gap-1 border-b border-line mb-5">
      {items.map((t) => (
        <Link key={t.key} href={t.href}
          className={`px-3 py-2 text-sm -mb-px border-b-2 ${t.key === current ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}

/** Form wrapper for server actions; `back` is where the action redirects after running. */
export function ActionForm({ action, back, children, className = "" }: { action: (fd: FormData) => Promise<void>; back: string; children: ReactNode; className?: string }) {
  return (
    <form action={action} className={className}>
      <input type="hidden" name="_back" value={back} />
      {children}
    </form>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted mt-1">{hint}</span>}
    </label>
  );
}
