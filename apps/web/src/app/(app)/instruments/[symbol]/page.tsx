import Link from "next/link";
import { db } from "@/lib/db";
import { fmtNum, fmtPct, fmtSigned, fmtTime, pnlClass } from "@/lib/format";
import { fmtHours, groupLabel, groupOf, metrics, subclassLabel, sumAgg, type InstrumentAgg } from "@/lib/instruments";
import { Card, Empty, KV, PageHeader, Stat, StatusBadge } from "@/components/ui";
import { StatsTable, type StatsRow } from "@/components/instrument-table";

export const dynamic = "force-dynamic";

function decode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

type AgentAgg = InstrumentAgg & { agent_id: string; strategy_id: string; code: string; name: string; strategy_code: string; strategy_name: string; last_trade_at: Date | null };

export default async function InstrumentPage({ params }: { params: Promise<{ symbol: string }> }) {
  const symbol = decode((await params).symbol);
  const sql = db();
  const [[stats], [spec], perAgent, trades, months] = await Promise.all([
    sql<(InstrumentAgg & { description: string | null; asset_class: string | null; currency_profit: string | null; max_drawdown: number; first_trade_at: Date | null; last_trade_at: Date | null })[]>`
      select * from v_instrument_stats where symbol = ${symbol}`,
    sql<{ broker_server: string; digits: number; contract_size: number | null; volume_min: number; volume_max: number; volume_step: number; currency_profit: string | null; currency_margin: string | null;
      swap_long: number | null; swap_short: number | null; trade_mode: string | null; stops_level: number | null; updated_at: Date }[]>`
      select broker_server, digits, contract_size, volume_min, volume_max, volume_step, currency_profit, currency_margin, swap_long, swap_short, trade_mode, stops_level, updated_at
      from instruments where symbol = ${symbol} order by updated_at desc limit 1`,
    sql<AgentAgg[]>`
      select s.*, a.code, a.name, st.code as strategy_code, st.name as strategy_name
      from v_instrument_agent_stats s join agents a on a.id = s.agent_id join strategies st on st.id = s.strategy_id
      where s.symbol = ${symbol} order by st.code, a.code`,
    sql<{ id: string; code: string; direction: string; status: string; volume_initial: number; entry_price: number; exit_price: number | null; opened_at: Date; closed_at: Date | null;
      net_pnl: number; unrealized_pnl: number; r_multiple: number | null; exit_reason: string | null }[]>`
      select t.id, a.code, t.direction, t.status, t.volume_initial, t.entry_price, t.exit_price, t.opened_at, t.closed_at, t.net_pnl, t.unrealized_pnl, t.r_multiple, t.exit_reason
      from trades t join agents a on a.id = t.agent_id where t.symbol = ${symbol} order by t.opened_at desc limit 50`,
    sql<{ month: Date; trades: number; wins: number; net_pnl: number; total_r: number | null }[]>`
      select date_trunc('month', closed_at) as month, count(*)::int as trades, count(*) filter (where net_pnl > 0)::int as wins,
             sum(net_pnl) as net_pnl, sum(r_multiple) as total_r
      from trades where symbol = ${symbol} and status = 'closed' group by 1 order by 1 desc limit 24`,
  ]);

  if (!stats && !spec) {
    return (<><PageHeader title={symbol} /><Card><Empty>Nie znam tego waloru. <Link href="/instruments" className="link">Wróć do listy</Link>.</Empty></Card></>);
  }
  const s: InstrumentAgg = stats ?? sumAgg([]);
  const m = metrics(s);

  const byStrategy = new Map<string, AgentAgg[]>();
  for (const r of perAgent) byStrategy.set(r.strategy_id, [...(byStrategy.get(r.strategy_id) ?? []), r]);
  const strategyRows: StatsRow[] = [...byStrategy.values()].map((rs) => ({
    ...sumAgg(rs), key: rs[0]!.strategy_id,
    label: <Link href={`/strategies/${rs[0]!.strategy_id}`} className="link font-medium">{rs[0]!.strategy_code}</Link>,
    sub: rs[0]!.strategy_name,
    last_trade_at: rs.reduce<Date | null>((acc, r) => (r.last_trade_at && (!acc || r.last_trade_at > acc) ? r.last_trade_at : acc), null),
  }));
  const agentRows: StatsRow[] = perAgent.map((r) => ({
    ...r, key: r.agent_id,
    label: <Link href={`/agents/${r.agent_id}`} className="link font-medium">{r.code}</Link>,
    sub: `${r.name} · ${r.strategy_code}`,
  }));

  return (
    <>
      <PageHeader title={symbol} subtitle={<>{stats?.description ?? ""} <span className="text-muted">· {groupLabel(groupOf(stats?.asset_class ?? null))}, {subclassLabel(stats?.asset_class ?? null)}</span></>}
        actions={<Link href="/instruments" className="btn">← Walory</Link>} />

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4 mb-6">
        <Stat label="Transakcje" value={s.trades_total} hint={`${s.closed_trades} zamkniętych · ${s.open_trades} otwartych`} />
        <Stat label="Skuteczność" value={fmtPct(m.winRate, 1)} hint={`▲ ${fmtPct(m.longWinRate, 0)} · ▼ ${fmtPct(m.shortWinRate, 0)}`} />
        <Stat label="Wynik netto" value={fmtSigned(s.net_pnl)} tone={s.net_pnl > 0 ? "good" : s.net_pnl < 0 ? "bad" : undefined} hint={`śr. ${fmtSigned(m.avgPnl)} na transakcję`} />
        <Stat label="Profit factor" value={m.profitFactor === null ? "—" : m.profitFactor === Infinity ? "∞" : fmtNum(m.profitFactor)} hint={`payoff ${fmtNum(m.payoff)}`} />
        <Stat label="E[R] / suma R" value={fmtNum(m.expectancyR, 3)} hint={`suma ${fmtSigned(s.total_r)} R`} />
        <Stat label="Maks. DD / koszty" value={stats?.max_drawdown ? fmtNum(-stats.max_drawdown) : "—"} hint={`koszty ${fmtNum(s.costs)} · śr. czas ${fmtHours(m.avgHoldHours)}`} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mb-6">
        <Card title="Wyniki miesięczne" bodyClass="" className="lg:col-span-2">
          {months.length === 0 ? <Empty>Brak zamkniętych transakcji.</Empty> : (
            <table className="tbl"><thead><tr><th>Miesiąc</th><th className="text-right">Transakcje</th><th className="text-right">Skuteczność</th><th className="text-right">Wynik netto</th><th className="text-right">Suma R</th></tr></thead>
              <tbody>{months.map((r) => (
                <tr key={String(r.month)}><td>{new Date(r.month).toLocaleDateString("pl-PL", { month: "long", year: "numeric", timeZone: "UTC" })}</td>
                  <td className="text-right">{r.trades}</td><td className="text-right">{fmtPct((r.wins / r.trades) * 100, 1)}</td>
                  <td className={`text-right ${pnlClass(r.net_pnl)}`}>{fmtSigned(r.net_pnl)}</td><td className={`text-right ${pnlClass(r.total_r)}`}>{fmtSigned(r.total_r)}</td></tr>))}
              </tbody></table>
          )}
        </Card>
        <Card title="Specyfikacja (broker)">
          {spec ? (
            <KV items={[
              ["Serwer", spec.broker_server], ["Kontrakt", spec.contract_size !== null ? fmtNum(spec.contract_size, 0) : "—"],
              ["Wolumen", `${spec.volume_min} – ${spec.volume_max} (krok ${spec.volume_step})`], ["Cyfry", String(spec.digits)],
              ["Waluta zysku / depozytu", `${spec.currency_profit ?? "—"} / ${spec.currency_margin ?? "—"}`],
              ["Swap long / short", `${spec.swap_long ?? "—"} / ${spec.swap_short ?? "—"}`],
              ["Tryb handlu", spec.trade_mode?.replace("SYMBOL_TRADE_MODE_", "").toLowerCase() ?? "—"],
              ["Min. odległość stopów", spec.stops_level !== null ? `${spec.stops_level} pkt` : "—"],
              ["Zsynchronizowano", fmtTime(spec.updated_at)],
            ]} />
          ) : <Empty>Walor nie jest zsynchronizowany z kontem MT.</Empty>}
        </Card>
      </div>

      <Card title="Wg strategii" bodyClass="" className="mb-6">
        {strategyRows.length === 0 ? <Empty>Żadna strategia jeszcze nie handlowała tym walorem.</Empty> : <StatsTable rows={strategyRows} firstCol="Strategia" showDrawdown={false} />}
      </Card>
      <Card title="Wg agenta" bodyClass="" className="mb-6">
        {agentRows.length === 0 ? <Empty>Brak.</Empty> : <StatsTable rows={agentRows} firstCol="Agent" showDrawdown={false} />}
      </Card>

      <Card title="Ostatnie transakcje" bodyClass="">
        {trades.length === 0 ? <Empty>Brak transakcji.</Empty> : (
          <div className="overflow-x-auto"><table className="tbl">
            <thead><tr><th>Otwarcie</th><th>Agent</th><th>Kierunek</th><th>Status</th><th className="text-right">Wolumen</th><th className="text-right">Wejście</th><th className="text-right">Wyjście</th><th>Powód wyjścia</th><th className="text-right">P/L netto</th><th className="text-right">R</th></tr></thead>
            <tbody>{trades.map((t) => {
              const pnl = t.status === "open" ? t.unrealized_pnl : t.net_pnl;
              return (
                <tr key={t.id}>
                  <td className="whitespace-nowrap"><Link href={`/trades/${t.id}`} className="link">{fmtTime(t.opened_at)}</Link></td>
                  <td>{t.code}</td><td>{t.direction === "long" ? "▲ long" : "▼ short"}</td><td><StatusBadge status={t.status} /></td>
                  <td className="text-right">{t.volume_initial}</td><td className="text-right mono">{t.entry_price}</td><td className="text-right mono">{t.exit_price ?? "—"}</td>
                  <td>{t.exit_reason ?? "—"}</td><td className={`text-right ${pnlClass(pnl)}`}>{fmtSigned(pnl)}{t.status === "open" ? " *" : ""}</td><td className="text-right">{fmtNum(t.r_multiple)}</td>
                </tr>);
            })}</tbody></table></div>
        )}
      </Card>
    </>
  );
}
