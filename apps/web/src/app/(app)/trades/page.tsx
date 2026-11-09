import Link from "next/link";
import { db } from "@/lib/db";
import { fmtNum, fmtSigned, fmtTime, pnlClass } from "@/lib/format";
import { Card, Empty, PageHeader, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";
const PAGE = 50;

export default async function TradesPage({ searchParams }: { searchParams: Promise<{ agent?: string; status?: string; page?: string }> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const agent = sp.agent || null, status = sp.status || null;
  const sql = db();
  const [rows, agents, [sum]] = await Promise.all([
    sql<{ id: string; code: string; symbol: string; direction: string; status: string; volume_initial: number; entry_price: number; exit_price: number | null; opened_at: Date; closed_at: Date | null;
      net_pnl: number; unrealized_pnl: number; r_multiple: number | null; exit_reason: string | null; commission: number; swap: number; slippage_points: number | null }[]>`
      select t.id, a.code, t.symbol, t.direction, t.status, t.volume_initial, t.entry_price, t.exit_price, t.opened_at, t.closed_at, t.net_pnl, t.unrealized_pnl,
             t.r_multiple, t.exit_reason, t.commission, t.swap, t.slippage_points
      from trades t join agents a on a.id = t.agent_id
      where (${agent}::uuid is null or t.agent_id = ${agent}::uuid) and (${status}::text is null or t.status = ${status})
      order by t.opened_at desc limit ${PAGE + 1} offset ${(page - 1) * PAGE}`,
    sql<{ id: string; code: string }[]>`select id, code from agents order by code`,
    sql<{ n: number; pnl: number | null; r: number | null; costs: number | null }[]>`
      select count(*)::int as n, sum(net_pnl) as pnl, sum(r_multiple) as r, sum(commission + swap) as costs from trades
      where status = 'closed' and (${agent}::uuid is null or agent_id = ${agent}::uuid)`,
  ]);
  const qs = (p: number) => `?${new URLSearchParams({ ...(agent ? { agent } : {}), ...(status ? { status } : {}), page: String(p) })}`;
  return (
    <>
      <PageHeader title="Transakcje" subtitle={`Zamknięte: ${sum?.n ?? 0} · wynik netto ${fmtSigned(sum?.pnl ?? 0)} · suma ${fmtNum(sum?.r ?? 0)} R · koszty (prowizje + swap) ${fmtNum(sum?.costs ?? 0)}`} />
      <form className="card p-4 mb-4 flex flex-wrap gap-3 items-end">
        <label><span className="label">Agent</span><select name="agent" defaultValue={agent ?? ""} className="input"><option value="">wszyscy</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.code}</option>)}</select></label>
        <label><span className="label">Status</span><select name="status" defaultValue={status ?? ""} className="input"><option value="">wszystkie</option><option value="open">otwarte</option><option value="closed">zamknięte</option></select></label>
        <button className="btn">Filtruj</button>
      </form>
      <Card bodyClass="">
        {rows.length === 0 ? <Empty>Brak transakcji.</Empty> : (
          <div className="overflow-x-auto"><table className="tbl">
            <thead><tr><th>Otwarcie</th><th>Agent</th><th>Instrument</th><th>Status</th><th className="text-right">Wolumen</th><th className="text-right">Wejście</th><th className="text-right">Wyjście</th>
              <th>Powód wyjścia</th><th className="text-right">Poślizg (pkt)</th><th className="text-right">Koszty</th><th className="text-right">P/L netto</th><th className="text-right">R</th></tr></thead>
            <tbody>{rows.slice(0, PAGE).map((t) => {
              const pnl = t.status === "open" ? t.unrealized_pnl : t.net_pnl;
              return (
                <tr key={t.id}>
                  <td className="text-muted whitespace-nowrap"><Link className="link" href={`/trades/${t.id}`}>{fmtTime(t.opened_at)}</Link></td>
                  <td>{t.code}</td><td>{t.direction === "long" ? "▲" : "▼"} {t.symbol}</td><td><StatusBadge status={t.status} /></td>
                  <td className="text-right">{t.volume_initial}</td><td className="text-right mono">{t.entry_price}</td><td className="text-right mono">{t.exit_price ?? "—"}</td>
                  <td>{t.exit_reason ?? "—"}</td><td className="text-right">{t.slippage_points ?? "—"}</td><td className="text-right">{fmtNum(t.commission + t.swap)}</td>
                  <td className={`text-right ${pnlClass(pnl)}`}>{fmtSigned(pnl)}{t.status === "open" ? " *" : ""}</td><td className="text-right">{fmtNum(t.r_multiple)}</td>
                </tr>);
            })}</tbody></table></div>
        )}
      </Card>
      <p className="text-xs text-muted mt-2">* niezrealizowany wynik otwartej pozycji</p>
      <div className="flex gap-2 mt-4">
        {page > 1 && <Link className="btn btn-sm" href={qs(page - 1)}>← nowsze</Link>}
        {rows.length > PAGE && <Link className="btn btn-sm" href={qs(page + 1)}>starsze →</Link>}
      </div>
    </>
  );
}
