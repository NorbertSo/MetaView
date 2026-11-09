import Link from "next/link";
import { db } from "@/lib/db";
import { agentSummaries, criteriaByStrategy, verdictFor } from "@/lib/queries";
import { ago, fmtMoney, fmtNum, fmtPct, fmtSigned, fmtTime, pnlClass } from "@/lib/format";
import { ActionForm, Card, Empty, Flash, PageHeader, Stat, StatusBadge } from "@/components/ui";
import { VerdictBadge } from "@/components/verdict";
import { setTradingEnabled } from "./actions/control";

export default async function Overview({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const sp = await searchParams;
  const sql = db();
  const [agents, crit, [trading], accounts, sources, [metaapi], openTrades, decisions, commitments, [today]] = await Promise.all([
    agentSummaries(),
    criteriaByStrategy(),
    sql<{ value: boolean }[]>`select value from app_settings where key = 'trading_enabled'`,
    sql<{ id: string; name: string; status: string; currency: string | null; equity: number | null; balance: number | null; beat: Date | null; latency_ms: number | null }[]>`
      select m.id, m.name, m.status, m.currency, s.equity, s.balance, h.checked_at as beat, h.latency_ms
      from mt_accounts m
      left join lateral (select equity, balance from account_snapshots where mt_account_id = m.id order by taken_at desc limit 1) s on true
      left join lateral (select checked_at, latency_ms from connection_heartbeats where mt_account_id = m.id order by checked_at desc limit 1) h on true
      where m.status <> 'archived' order by m.created_at`,
    sql<{ code: string; name: string; health: string; last_success_at: Date | null }[]>`select code, name, health, last_success_at from v_data_source_health where kind = 'worker' order by name`,
    sql<{ last4: string }[]>`select last4 from secrets where name = 'metaapi_token'`,
    sql<{ id: string; code: string; symbol: string; direction: string; volume_open: number; entry_price: number; current_sl: number | null; current_tp: number | null; unrealized_pnl: number; opened_at: Date }[]>`
      select t.id, a.code, t.symbol, t.direction, t.volume_open, t.entry_price, t.current_sl, t.current_tp, t.unrealized_pnl, t.opened_at
      from trades t join agents a on a.id = t.agent_id where t.status = 'open' order by t.opened_at desc`,
    sql<{ id: string; code: string; action: string; symbol: string | null; status: string; decided_at: Date; probability: number | null }[]>`
      select d.id, a.code, d.action, d.symbol, d.status, d.decided_at, d.probability
      from decisions d join agents a on a.id = d.agent_id order by d.decided_at desc limit 12`,
    sql<{ label: string; value: string; effective_from: Date }[]>`select label, value, effective_from from v_current_commitments order by key`,
    sql<{ pnl: number | null; trades: number }[]>`select sum(net_pnl) as pnl, count(*)::int as trades from trades where status = 'closed' and closed_at >= date_trunc('day', now())`,
  ]);

  const connected = accounts.filter((a) => a.status === "connected").length;
  const totalEquity = accounts.reduce((s, a) => s + (a.equity ?? 0), 0);
  const ccy = accounts.find((a) => a.currency)?.currency ?? null;
  const active = agents.filter((a) => a.status === "active").length;

  return (
    <>
      <PageHeader title="Przegląd" subtitle="Stan systemu, agenci i wyniki. Wszystko na koncie demo." />
      <Flash msg={sp.msg} err={sp.err} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Stat label="Kapitał kont (equity)" value={accounts.some((a) => a.equity !== null) ? fmtMoney(totalEquity, ccy) : "—"} hint={`${connected}/${accounts.length} kont połączonych`} />
        <Stat label="Wynik dziś (zamknięte)" value={fmtSigned(today?.pnl ?? 0)} tone={(today?.pnl ?? 0) > 0 ? "good" : (today?.pnl ?? 0) < 0 ? "bad" : undefined} hint={`${today?.trades ?? 0} transakcji`} />
        <Stat label="Otwarte pozycje" value={openTrades.length} hint={`niezrealizowane ${fmtSigned(openTrades.reduce((s, t) => s + t.unrealized_pnl, 0))}`} />
        <Stat label="Aktywni agenci" value={`${active}/${agents.length}`} hint={trading?.value ? "handel włączony" : "handel wyłączony"} tone={trading?.value ? undefined : "warn"} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mb-6">
        <Card title="Połączenia">
          <div className="space-y-2.5 text-sm">
            <Row label="MetaApi (token)" ok={!!metaapi} value={metaapi ? `•••• ${metaapi.last4}` : "brak — dodaj w Konta MT"} />
            {accounts.length === 0 && <Row label="Konta MT" ok={false} value="brak kont" />}
            {accounts.map((a) => (
              <Row key={a.id} label={a.name} ok={a.status === "connected"}
                value={<>{a.status}{a.beat && <span className="text-muted"> · {ago(a.beat)}{a.latency_ms !== null ? ` · ${a.latency_ms} ms` : ""}</span>}</>} />
            ))}
            {sources.map((s) => (
              <Row key={s.code} label={s.name} ok={s.health === "ok"} warn={s.health === "stale" || s.health === "never"} value={<>{s.health} <span className="text-muted">· {ago(s.last_success_at)}</span></>} />
            ))}
          </div>
        </Card>

        <Card title="Handel (wyłącznik główny)">
          <p className="text-sm text-muted mb-4">
            Wyłączony handel blokuje otwieranie nowych pozycji. Agenci dalej zarządzają otwartymi pozycjami (mogą je zamykać i zacieśniać SL).
            Każda zmiana zapisuje się jako Twoja interwencja.
          </p>
          <ActionForm action={setTradingEnabled} back="/" className="space-y-3">
            <input type="hidden" name="enable" value={trading?.value ? "false" : "true"} />
            <input name="reason" required minLength={3} placeholder="Powód zmiany" className="input w-full" />
            <button className={trading?.value ? "btn btn-danger w-full" : "btn btn-primary w-full"}>
              {trading?.value ? "Wyłącz handel" : "Włącz handel"}
            </button>
          </ActionForm>
        </Card>

        <Card title="Zobowiązania" actions={<Link href="/review?tab=commitments" className="link text-xs">zarządzaj</Link>}>
          {commitments.length === 0 ? (
            <Empty>Spisz zobowiązania, zanim pojawią się wyniki.</Empty>
          ) : (
            <dl className="space-y-3 text-sm">
              {commitments.map((c) => (
                <div key={c.label}><dt className="text-xs text-muted">{c.label}</dt><dd>{c.value}</dd></div>
              ))}
            </dl>
          )}
        </Card>
      </div>

      <Card title="Agenci" actions={<Link href="/agents/new" className="btn btn-sm">Nowy agent</Link>} bodyClass="">
        {agents.length === 0 ? <Empty>Brak agentów. Najpierw dodaj strategię, model i konto.</Empty> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Agent</th><th>Strategia</th><th>Model</th><th>Status</th><th className="text-right">Equity</th><th className="text-right">Wynik</th>
                <th className="text-right">Maks. DD</th><th className="text-right">Transakcje</th><th className="text-right">E[R]</th><th className="text-right">PF</th><th className="text-right">Koszt AI</th><th>Kryteria</th></tr></thead>
              <tbody>
                {agents.map((a) => {
                  const ret = ((a.equity - a.allocated_capital) / a.allocated_capital) * 100;
                  return (
                    <tr key={a.id}>
                      <td><Link href={`/agents/${a.id}`} className="link font-medium">{a.code}</Link> <span className="text-muted">{a.name}</span></td>
                      <td>{a.strategy_code} v{a.version}</td>
                      <td>{a.model}</td>
                      <td><StatusBadge status={a.status} /></td>
                      <td className="text-right">{fmtNum(a.equity)}</td>
                      <td className={`text-right ${pnlClass(ret)}`}>{fmtSigned(ret, 2, "%")}</td>
                      <td className="text-right">{fmtPct(a.max_drawdown_pct)}</td>
                      <td className="text-right">{a.closed_trades}{a.open_positions ? <span className="text-muted"> +{a.open_positions}</span> : null}</td>
                      <td className="text-right">{fmtNum(a.expectancy_r, 3)}</td>
                      <td className="text-right">{fmtNum(a.profit_factor)}</td>
                      <td className="text-right">${fmtNum(a.llm_cost_usd)}</td>
                      <td><VerdictBadge v={verdictFor(a, crit)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid lg:grid-cols-2 gap-4 mt-6">
        <Card title="Otwarte pozycje" bodyClass="">
          {openTrades.length === 0 ? <Empty>Brak otwartych pozycji.</Empty> : (
            <table className="tbl">
              <thead><tr><th>Agent</th><th>Instrument</th><th className="text-right">Wolumen</th><th className="text-right">Wejście</th><th className="text-right">SL / TP</th><th className="text-right">P/L</th></tr></thead>
              <tbody>{openTrades.map((t) => (
                <tr key={t.id}>
                  <td>{t.code}</td>
                  <td><Link href={`/trades/${t.id}`} className="link">{t.direction === "long" ? "▲" : "▼"} {t.symbol}</Link></td>
                  <td className="text-right">{t.volume_open}</td>
                  <td className="text-right mono">{t.entry_price}</td>
                  <td className="text-right mono">{t.current_sl ?? "—"} / {t.current_tp ?? "—"}</td>
                  <td className={`text-right ${pnlClass(t.unrealized_pnl)}`}>{fmtSigned(t.unrealized_pnl)}</td>
                </tr>))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Ostatnie decyzje" actions={<Link href="/decisions" className="link text-xs">wszystkie</Link>} bodyClass="">
          {decisions.length === 0 ? <Empty>Brak decyzji.</Empty> : (
            <table className="tbl">
              <thead><tr><th>Czas</th><th>Agent</th><th>Akcja</th><th>p</th><th>Status</th></tr></thead>
              <tbody>{decisions.map((d) => (
                <tr key={d.id}>
                  <td className="text-muted">{fmtTime(d.decided_at)}</td>
                  <td>{d.code}</td>
                  <td><Link href={`/decisions/${d.id}`} className="link">{d.action}{d.symbol ? ` ${d.symbol}` : ""}</Link></td>
                  <td>{d.probability !== null ? fmtNum(d.probability, 2) : "—"}</td>
                  <td><StatusBadge status={d.status} /></td>
                </tr>))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}

function Row({ label, ok, warn, value }: { label: string; ok: boolean; warn?: boolean; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${ok ? "bg-good" : warn ? "bg-warn" : "bg-bad"}`} />{label}
      </span>
      <span className="text-right">{value}</span>
    </div>
  );
}

export const dynamic = "force-dynamic";
