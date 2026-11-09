import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { fmtDate, fmtNum, fmtSigned } from "@/lib/format";
import { Badge, Card, KV, PageHeader, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

interface Gate { gate: string; passed: boolean; detail: string }

export default async function DecisionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sql = db();
  const [d] = await sql<{ id: string; decided_at: Date; agent_id: string; code: string; model: string; strategy: string; version: number; action: string; symbol: string | null;
    probability: number | null; expected_r: number | null; entry_price: number | null; stop_loss: number | null; take_profit: number | null; close_fraction: number | null;
    volume: number | null; rationale: string; factors: string[]; context_snapshot: Record<string, unknown>; risk_check: { passed: boolean; gates: Gate[]; sizing?: { volume: number; riskAmount: number } | null } | null;
    status: string; error: string | null; outcome_r: number | null; outcome_hit: boolean | null; target_trade_id: string | null; run_id: string; brief_id: string | null; lessons_used: string[] }[]>`
    select d.*, a.code, m.display_name as model, s.code as strategy, v.version
    from decisions d join agents a on a.id = d.agent_id join llm_models m on m.id = d.model_id
    join strategy_versions v on v.id = d.strategy_version_id join strategies s on s.id = v.strategy_id where d.id = ${id}`;
  if (!d) notFound();
  const [orders, [opened], [call]] = await Promise.all([
    sql<{ id: string; created_at: Date; order_kind: string; side: string | null; volume: number | null; status: string; retcode: string | null; error: string | null; latency_ms: number | null; client_id: string }[]>`
      select id, created_at, order_kind, side, volume, status, retcode, error, latency_ms, client_id from orders where decision_id = ${id} order by created_at`,
    sql<{ id: string }[]>`select id from trades where open_decision_id = ${id}`,
    sql<{ id: string; cost_usd: number; latency_ms: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; status: string }[]>`
      select c.id, c.cost_usd, c.latency_ms, c.input_tokens, c.output_tokens, c.cache_read_tokens, c.status from agent_runs r join llm_calls c on c.id = r.llm_call_id where r.id = ${d.run_id}`,
  ]);
  const ref = (d.context_snapshot as { _ref?: { market_view?: string } })._ref;
  const { _ref, ...context } = d.context_snapshot as Record<string, unknown> & { _ref?: unknown };
  void _ref;

  return (
    <>
      <PageHeader title={`${d.action}${d.symbol ? ` ${d.symbol}` : ""}`}
        subtitle={<><Link className="link" href={`/agents/${d.agent_id}`}>{d.code}</Link> · {d.strategy} v{d.version} · {d.model} · {fmtDate(d.decided_at)}</>}
        actions={<StatusBadge status={d.status} />} />

      <div className="grid lg:grid-cols-3 gap-4 mb-6">
        <Card title="Decyzja">
          <KV items={[
            ["Prawdopodobieństwo", d.probability !== null ? fmtNum(d.probability, 3) : "—"],
            ["Oczekiwany wynik", d.expected_r !== null ? `${fmtNum(d.expected_r, 2)} R` : "—"],
            ["Wejście (rynek)", d.entry_price ?? "—"], ["SL / TP", `${d.stop_loss ?? "—"} / ${d.take_profit ?? "—"}`],
            ["Wolumen (wyliczony)", d.volume ?? "—"], ["Część do zamknięcia", d.close_fraction ?? "—"],
            ["Czynniki", d.factors.length ? d.factors.map((f) => <Badge key={f}>{f}</Badge>) : "—"],
            ["Wynik", d.outcome_r !== null ? <span key="o" className={d.outcome_r > 0 ? "text-good" : "text-bad"}>{fmtSigned(d.outcome_r)} R</span> : "—"],
            ["Transakcja", opened ? <Link key="t" className="link" href={`/trades/${opened.id}`}>otwórz</Link> : d.target_trade_id ? <Link key="t2" className="link" href={`/trades/${d.target_trade_id}`}>pozycja</Link> : "—"],
            ["Błąd", d.error ?? "—"],
          ]} />
        </Card>
        <Card title="Uzasadnienie" className="lg:col-span-2">
          <p className="text-sm whitespace-pre-wrap">{d.rationale}</p>
          {ref?.market_view && <><div className="text-xs text-muted mt-4 mb-1">Ocena rynku (całe uruchomienie)</div><p className="text-sm whitespace-pre-wrap text-muted">{ref.market_view}</p></>}
          {call && <p className="text-xs text-muted mt-4">Wywołanie modelu: ${fmtNum(call.cost_usd, 4)} · {(call.latency_ms / 1000).toFixed(1)} s · wejście {call.input_tokens} (+{call.cache_read_tokens} z cache) · wyjście {call.output_tokens} tok.</p>}
        </Card>
      </div>

      {d.risk_check && (
        <Card title={<span className="flex items-center gap-2">Bramki ryzyka <StatusBadge status={d.risk_check.passed ? "passed" : "rejected"} label={d.risk_check.passed ? "przeszło" : "zablokowane"} /></span>} bodyClass="" className="mb-6">
          <table className="tbl"><thead><tr><th>Bramka</th><th>Wynik</th><th>Szczegóły</th></tr></thead>
            <tbody>{d.risk_check.gates.map((g) => (
              <tr key={g.gate}><td className="mono">{g.gate}</td><td>{g.passed ? <Badge tone="good">ok</Badge> : <Badge tone="bad">blokada</Badge>}</td><td className="text-sm">{g.detail}</td></tr>))}
            </tbody></table>
        </Card>
      )}

      {orders.length > 0 && (
        <Card title="Zlecenia" bodyClass="" className="mb-6">
          <table className="tbl"><thead><tr><th>Czas</th><th>Rodzaj</th><th>Strona</th><th>Wolumen</th><th>Status</th><th>Kod brokera</th><th>Opóźnienie</th><th>Client ID</th></tr></thead>
            <tbody>{orders.map((o) => (
              <tr key={o.id}><td>{fmtDate(o.created_at)}</td><td>{o.order_kind}</td><td>{o.side ?? "—"}</td><td>{o.volume ?? "—"}</td><td><StatusBadge status={o.status} /></td>
                <td className="mono">{o.retcode ?? "—"}{o.error ? ` · ${o.error}` : ""}</td><td>{o.latency_ms !== null ? `${o.latency_ms} ms` : "—"}</td><td className="mono">{o.client_id}</td></tr>))}
            </tbody></table>
        </Card>
      )}

      <Card title="Kontekst, który widział model">
        <pre className="mono text-xs overflow-auto max-h-[600px] whitespace-pre-wrap">{JSON.stringify(context, null, 2)}</pre>
      </Card>
    </>
  );
}
