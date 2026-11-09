import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { NavLinks } from "@/components/nav";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  const sql = db();
  const [[trading], [worker], [issues]] = await Promise.all([
    sql<{ value: boolean }[]>`select value from app_settings where key = 'trading_enabled'`,
    sql<{ beat_at: Date | null }[]>`select max(beat_at) as beat_at from worker_heartbeats`,
    sql<{ n: number }[]>`select (select count(*) from reconciliation_issues where resolved_at is null)
                              + (select count(*) from system_events where level = 'critical' and occurred_at > now() - interval '24 hours') as n`,
  ]);
  const workerAlive = !!worker?.beat_at && Date.now() - new Date(worker.beat_at).getTime() < 90_000;

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 shrink-0 border-r border-line bg-panel/60 flex flex-col">
        <Link href="/" className="px-5 py-5 block">
          <div className="text-base font-semibold">Trading 2.2</div>
          <div className="text-xs text-muted">agenci na koncie demo</div>
        </Link>
        <NavLinks />
        <div className="mt-auto p-4 space-y-2 text-xs border-t border-line">
          <div className="flex items-center justify-between">
            <span className="text-muted">Handel</span>
            <span className={trading?.value ? "text-good" : "text-bad"}>{trading?.value ? "włączony" : "wyłączony"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">Worker</span>
            <span className={workerAlive ? "text-good" : "text-bad"}>{workerAlive ? "działa" : "brak sygnału"}</span>
          </div>
          {!!issues?.n && (
            <Link href="/settings?tab=events" className="block text-warn">⚠ {issues.n} do sprawdzenia</Link>
          )}
          <form method="post" action="/api/auth/logout">
            <button className="text-muted hover:text-ink">Wyloguj</button>
          </form>
        </div>
      </aside>
      <main className="flex-1 min-w-0 p-8 max-w-[1400px]">{children}</main>
    </div>
  );
}
