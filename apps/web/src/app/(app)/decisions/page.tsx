import Link from "next/link";
import { db } from "@/lib/db";
import { fmtNum, fmtSigned, fmtTime, pnlClass } from "@/lib/format";
import { Card, Empty, PageHeader, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";
const PAGE = 50;

export default async function DecisionsPage({ searchParams }: { searchParams: Promise<{ agent?: string; action?: string; status?: string; page?: string }> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const sql = db();
  const agent = sp.agent || null, action = sp.action || null, status = sp.status || null;
  const [rows, agents] = await Promise.all([
    sql<{ id: string; decided_at: Date; code: string; model: string; action: string; symbol: string | null; probability: number | null; expected_r: number | null;
      volume: number | null; status: string; outcome_r: number | null; rationale: string; failed_gates: string | null }[]>`
      select d.id, d.decided_at, a.code, m.display_name as model, d.action, d.symbol, d.probability, d.expected_r, d.volume, d.status, d.outcome_r, d.rationale,
             (select string_agg(g->>'gate', ', ') from jsonb_array_elements(d.risk_check->'gates') g where (g->>'passed')::boolean = false) as failed_gates
      from decisions d join agents a on a.id = d.agent_id join llm_models m on m.id = d.model_id
      where (${agent}::uuid is null or d.agent_id = ${agent}::uuid)
        and (${action}::text is null or d.action = ${action})
        and (${status}::text is null or d.status = ${status})
      order by d.decided_at desc limit ${PAGE + 1} offset ${(page - 1) * PAGE}`,
    sql<{ id: string; code: string }[]>`select id, code from agents order by code`,
  ]);
  const more = rows.length > PAGE;
  const qs = (p: number) => `?${new URLSearchParams({ ...(agent ? { agent } : {}), ...(action ? { action } : {}), ...(status ? { status } : {}), page: String(p) })}`;
  return (
    <>
      <PageHeader title="Decyzje" subtitle="Każde uruchomienie agenta, także „nic nie robię”. Kliknij, aby zobaczyć pełny kontekst, który widział model, i wynik bramek ryzyka." />
      <form className="card p-4 mb-4 flex flex-wrap gap-3 items-end">
        <label><span className="label">Agent</span><select name="agent" defaultValue={agent ?? ""} className="input"><option value="">wszyscy</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.code}</option>)}</select></label>
        <label><span className="label">Akcja</span><select name="action" defaultValue={action ?? ""} className="input"><option value="">wszystkie</option>
          {["open_long", "open_short", "add", "modify_position", "partial_close", "close", "hold", "skip"].map((x) => <option key={x}>{x}</option>)}</select></label>
        <label><span className="label">Status</span><select name="status" defaultValue={status ?? ""} className="input"><option value="">wszystkie</option>
          {["recorded", "rejected_risk", "submitted", "executed", "failed"].map((x) => <option key={x}>{x}</option>)}</select></label>
        <button className="btn">Filtruj</button>
      </form>
      <Card bodyClass="">
        {rows.length === 0 ? <Empty>Brak decyzji.</Empty> : (
          <div className="overflow-x-auto"><table className="tbl">
            <thead><tr><th>Czas</th><th>Agent</th><th>Model</th><th>Akcja</th><th>p</th><th>E[R]</th><th>Wolumen</th><th>Status</th><th>Zablokowane przez</th><th className="text-right">Wynik R</th><th>Uzasadnienie</th></tr></thead>
            <tbody>{rows.slice(0, PAGE).map((d) => (
              <tr key={d.id}>
                <td className="text-muted whitespace-nowrap"><Link className="link" href={`/decisions/${d.id}`}>{fmtTime(d.decided_at)}</Link></td>
                <td>{d.code}</td><td className="text-xs">{d.model}</td>
                <td className="whitespace-nowrap">{d.action}{d.symbol ? ` ${d.symbol}` : ""}</td>
                <td>{d.probability !== null ? fmtNum(d.probability, 2) : "—"}</td><td>{d.expected_r !== null ? fmtNum(d.expected_r, 1) : "—"}</td>
                <td>{d.volume ?? "—"}</td><td><StatusBadge status={d.status} /></td>
                <td className="text-xs text-bad">{d.failed_gates ?? ""}</td>
                <td className={`text-right ${pnlClass(d.outcome_r)}`}>{d.outcome_r !== null ? fmtSigned(d.outcome_r) : "—"}</td>
                <td className="text-xs text-muted max-w-md truncate" title={d.rationale}>{d.rationale}</td>
              </tr>))}
            </tbody></table></div>
        )}
      </Card>
      <div className="flex gap-2 mt-4">
        {page > 1 && <Link className="btn btn-sm" href={qs(page - 1)}>← nowsze</Link>}
        {more && <Link className="btn btn-sm" href={qs(page + 1)}>starsze →</Link>}
      </div>
    </>
  );
}
