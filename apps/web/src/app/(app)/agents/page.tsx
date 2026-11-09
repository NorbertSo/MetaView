import Link from "next/link";
import { agentSummaries, criteriaByStrategy, verdictFor } from "@/lib/queries";
import { fmtNum, fmtPct, fmtSigned, pnlClass } from "@/lib/format";
import { Card, Empty, Flash, PageHeader, StatusBadge } from "@/components/ui";
import { VerdictBadge } from "@/components/verdict";

export const dynamic = "force-dynamic";

export default async function AgentsPage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const sp = await searchParams;
  const [agents, crit] = await Promise.all([agentSummaries(), criteriaByStrategy()]);
  return (
    <>
      <PageHeader title="Agenci" subtitle="Agent = wersja strategii × model AI × konto. Ta trójka jest zamrożona po aktywacji, więc wyniki każdego agenta nigdy się nie mieszają."
        actions={<Link href="/agents/new" className="btn btn-primary">Nowy agent</Link>} />
      <Flash msg={sp.msg} err={sp.err} />
      <Card bodyClass="">
        {agents.length === 0 ? <Empty>Brak agentów.</Empty> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Agent</th><th>Strategia</th><th>Model</th><th>Konto</th><th>Status</th><th>Harmonogram</th><th className="text-right">Kapitał</th>
                <th className="text-right">Equity</th><th className="text-right">Wynik</th><th className="text-right">DD</th><th className="text-right">Tr.</th><th className="text-right">Win%</th>
                <th className="text-right">E[R]</th><th className="text-right">Brier</th><th className="text-right">AI $</th><th>Kryteria</th></tr></thead>
              <tbody>{agents.map((a) => {
                const ret = ((a.equity - a.allocated_capital) / a.allocated_capital) * 100;
                return (
                  <tr key={a.id}>
                    <td><Link href={`/agents/${a.id}`} className="link font-medium">{a.code}</Link><div className="text-xs text-muted">{a.name}</div></td>
                    <td>{a.strategy_code} v{a.version}</td><td>{a.model}</td><td>{a.account_name}</td>
                    <td><StatusBadge status={a.status} /></td><td className="mono">{a.schedule_cron}</td>
                    <td className="text-right">{fmtNum(a.allocated_capital, 0)}</td><td className="text-right">{fmtNum(a.equity)}</td>
                    <td className={`text-right ${pnlClass(ret)}`}>{fmtSigned(ret, 2, "%")}</td><td className="text-right">{fmtPct(a.max_drawdown_pct)}</td>
                    <td className="text-right">{a.closed_trades}</td><td className="text-right">{a.win_rate !== null ? fmtPct(a.win_rate * 100, 0) : "—"}</td>
                    <td className="text-right">{fmtNum(a.expectancy_r, 3)}</td><td className="text-right">{fmtNum(a.brier, 3)}</td>
                    <td className="text-right">{fmtNum(a.llm_cost_usd)}</td><td><VerdictBadge v={verdictFor(a, crit)} /></td>
                  </tr>);
              })}</tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
