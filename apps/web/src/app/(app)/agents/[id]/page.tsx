import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { agentSummaries, criteriaByStrategy, verdictFor } from "@/lib/queries";
import { ago, fmtDate, fmtNum, fmtPct, fmtSigned, fmtTime, pnlClass } from "@/lib/format";
import { ActionForm, Card, Empty, Field, Flash, KV, PageHeader, Stat, StatusBadge } from "@/components/ui";
import { EquityChart } from "@/components/equity-chart";
import { VerdictBadge, VerdictTable } from "@/components/verdict";
import { killAgent, runAgentNow, setAgentStatus } from "../../actions/control";
import { updateDraftAgent } from "../../actions/agents";

export const dynamic = "force-dynamic";

export default async function AgentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const sql = db();
  const [[a], crit] = await Promise.all([agentSummaries({ id }), criteriaByStrategy()]);
  if (!a) notFound();
  const back = `/agents/${id}`;
  const [equity, decisions, trades, runs, [cfg], gateStats, actionStats] = await Promise.all([
    sql<{ taken_at: Date; equity: number }[]>`
      select taken_at, equity from (
        select taken_at, equity, row_number() over (order by taken_at) as rn, count(*) over () as n from agent_equity_snapshots where agent_id = ${id}
      ) s where n <= 600 or rn % ceil(n / 600.0)::int = 0 or rn = n order by taken_at`,
    sql<{ id: string; decided_at: Date; action: string; symbol: string | null; probability: number | null; status: string; outcome_r: number | null; rationale: string }[]>`
      select id, decided_at, action, symbol, probability, status, outcome_r, rationale from decisions where agent_id = ${id} order by decided_at desc limit 25`,
    sql<{ id: string; symbol: string; direction: string; status: string; opened_at: Date; closed_at: Date | null; net_pnl: number; unrealized_pnl: number; r_multiple: number | null; exit_reason: string | null }[]>`
      select id, symbol, direction, status, opened_at, closed_at, net_pnl, unrealized_pnl, r_multiple, exit_reason from trades where agent_id = ${id} order by opened_at desc limit 25`,
    sql<{ id: string; started_at: Date; trigger: string; status: string; skip_reason: string | null; error: string | null; cost: number | null; latency: number | null }[]>`
      select r.id, r.started_at, r.trigger, r.status, r.skip_reason, r.error, c.cost_usd as cost, c.latency_ms as latency
      from agent_runs r left join llm_calls c on c.id = r.llm_call_id where r.agent_id = ${id} order by r.started_at desc limit 15`,
    sql<{ max_open_positions: number; max_daily_loss_pct: number; max_drawdown_pct: number; temperature: number; schedule_cron: string; instruments: string[]; version_instruments: string[] }[]>`
      select a.max_open_positions, a.max_daily_loss_pct, a.max_drawdown_pct, a.temperature, a.schedule_cron, a.instruments, v.instruments as version_instruments
      from agents a join strategy_versions v on v.id = a.strategy_version_id where a.id = ${id}`,
    sql<{ gate: string; n: number }[]>`
      select g->>'gate' as gate, count(*)::int as n from decisions d cross join lateral jsonb_array_elements(d.risk_check->'gates') g
      where d.agent_id = ${id} and d.status = 'rejected_risk' and (g->>'passed')::boolean = false group by 1 order by 2 desc limit 8`,
    sql<{ action: string; n: number }[]>`select action, count(*)::int as n from decisions where agent_id = ${id} group by 1 order by 2 desc`,
  ]);
  const verdict = verdictFor(a, crit);
  const ret = ((a.equity - a.allocated_capital) / a.allocated_capital) * 100;
  const live = a.status === "active" || a.status === "paused";

  return (
    <>
      <PageHeader title={`${a.code} — ${a.name}`}
        subtitle={<>
          <Link className="link" href={`/strategies/${a.strategy_id}`}>{a.strategy_code} v{a.version}</Link> · {a.provider} {a.model} · {a.account_name} · magic {a.magic}
          {a.status_reason && <> · <span className="text-warn">{a.status_reason}</span></>}
        </>}
        actions={<>
          <StatusBadge status={a.status} />
          {a.status === "active" && <ActionForm action={runAgentNow} back={back}><input type="hidden" name="agent_id" value={a.id} /><button className="btn">Uruchom teraz</button></ActionForm>}
          <Link href={`/agents/new?from=${a.id}`} className="btn">Klonuj (inna wersja / model)</Link>
        </>} />
      <Flash msg={sp.msg} err={sp.err} />

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4 mb-6">
        <Stat label="Equity (wirtualne)" value={fmtNum(a.equity)} hint={`z ${fmtNum(a.allocated_capital, 0)} ${a.currency ?? ""}`} />
        <Stat label="Wynik" value={fmtSigned(ret, 2, "%")} tone={ret > 0 ? "good" : ret < 0 ? "bad" : undefined} hint={`zreal. ${fmtSigned(a.realized_pnl)} · otw. ${fmtSigned(a.unrealized_pnl)}`} />
        <Stat label="Maks. obsunięcie" value={fmtPct(a.max_drawdown_pct)} hint={`kill switch przy ${cfg?.max_drawdown_pct}%`} tone={a.max_drawdown_pct > (cfg?.max_drawdown_pct ?? 100) * 0.7 ? "warn" : undefined} />
        <Stat label="Transakcje" value={a.closed_trades} hint={`win rate ${a.win_rate !== null ? fmtPct(a.win_rate * 100, 0) : "—"} · otwarte ${a.open_positions}`} />
        <Stat label="Wartość oczekiwana" value={`${fmtNum(a.expectancy_r, 3)} R`} hint={`PF ${fmtNum(a.profit_factor)} · Brier ${fmtNum(a.brier, 3)}`} />
        <Stat label="Koszt AI" value={`$${fmtNum(a.llm_cost_usd)}`} hint={`${a.llm_calls} wywołań`} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mb-6">
        <Card title="Krzywa kapitału" className="lg:col-span-2"><EquityChart points={equity.map((e) => ({ t: new Date(e.taken_at), v: e.equity }))} baseline={a.allocated_capital} /></Card>
        <Card title={<span className="flex items-center gap-2">Kryteria strategii <VerdictBadge v={verdict} /></span>} bodyClass="">
          {verdict ? <VerdictTable v={verdict} /> : <Empty>Strategia nie ma spisanych kryteriów.</Empty>}
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mb-6">
        <Card title="Sterowanie">
          {live ? (
            <div className="space-y-4">
              <ActionForm action={setAgentStatus} back={back} className="space-y-2">
                <input type="hidden" name="agent_id" value={a.id} />
                <input type="hidden" name="to" value={a.status === "active" ? "paused" : "active"} />
                <input name="reason" required minLength={3} placeholder="Powód (zapisze się jako interwencja)" className="input w-full" />
                <button className="btn w-full">{a.status === "active" ? "Wstrzymaj" : "Wznów"}</button>
              </ActionForm>
              <ActionForm action={killAgent} back={back} className="space-y-2 pt-3 border-t border-line">
                <input type="hidden" name="agent_id" value={a.id} />
                <p className="text-xs text-muted">Zatrzymanie na stałe: zamyka wszystkie pozycje agenta. Nieodwracalne — agenta można potem tylko sklonować.</p>
                <input name="reason" required minLength={3} placeholder="Powód" className="input w-full" />
                <input name="confirm" required placeholder="wpisz KILL" className="input w-full" />
                <button className="btn btn-danger w-full">Zatrzymaj agenta</button>
              </ActionForm>
            </div>
          ) : a.status === "draft" ? (
            <ActionForm action={setAgentStatus} back={back} className="space-y-2">
              <input type="hidden" name="agent_id" value={a.id} /><input type="hidden" name="to" value="active" />
              <input type="hidden" name="reason" value="aktywacja szkicu" />
              <p className="text-sm text-muted">Agent jest szkicem. Po aktywacji wersja, model, konto i kapitał zostaną zamrożone.</p>
              <button className="btn btn-primary w-full">Aktywuj</button>
            </ActionForm>
          ) : (
            a.status !== "archived" && a.open_positions === 0 ? (
              <ActionForm action={setAgentStatus} back={back} className="space-y-2">
                <input type="hidden" name="agent_id" value={a.id} /><input type="hidden" name="to" value="archived" />
                <input name="reason" required placeholder="Powód archiwizacji" className="input w-full" />
                <button className="btn w-full">Archiwizuj</button>
              </ActionForm>
            ) : <p className="text-sm text-muted">Agent nie działa ({a.status}).</p>
          )}
        </Card>

        <Card title="Konfiguracja" className="lg:col-span-2">
          <KV items={[
            ["Harmonogram (UTC)", <span key="c" className="mono">{a.schedule_cron}</span>],
            ["Instrumenty", <span key="i" className="mono">{a.instruments.join(" ")}</span>],
            ["Ryzyko / transakcję", `${a.risk_per_trade_pct}% equity agenta`],
            ["Limity", `maks. ${cfg?.max_open_positions} poz. · dzienna strata ${cfg?.max_daily_loss_pct}% · kill switch ${cfg?.max_drawdown_pct}%`],
            ["Temperatura", String(cfg?.temperature)],
            ["Utworzony / aktywowany", `${fmtDate(a.created_at)} / ${fmtDate(a.activated_at)}`],
          ]} />
          {a.status !== "killed" && a.status !== "archived" && cfg && (
            <details className="mt-4">
              <summary className="text-sm link cursor-pointer">Zmień harmonogram i limity</summary>
              <ActionForm action={updateDraftAgent} back={back} className="grid md:grid-cols-3 gap-3 mt-3">
                <input type="hidden" name="id" value={a.id} />
                <Field label="Nazwa"><input name="name" defaultValue={a.name} required className="input w-full" /></Field>
                <Field label="Harmonogram (cron UTC)"><input name="schedule_cron" defaultValue={cfg.schedule_cron} required className="input w-full mono" /></Field>
                <Field label={`Instrumenty (z: ${cfg.version_instruments.join(" ")})`}><input name="instruments" defaultValue={cfg.instruments.join(" ")} required className="input w-full mono" /></Field>
                <Field label="Ryzyko / transakcję (%)"><input name="risk_per_trade_pct" defaultValue={a.risk_per_trade_pct} required className="input w-full" /></Field>
                <Field label="Maks. pozycji"><input name="max_open_positions" defaultValue={cfg.max_open_positions} required className="input w-full" /></Field>
                <Field label="Dzienny limit straty (%)"><input name="max_daily_loss_pct" defaultValue={cfg.max_daily_loss_pct} required className="input w-full" /></Field>
                <Field label="Kill switch (%)"><input name="max_drawdown_pct" defaultValue={cfg.max_drawdown_pct} required className="input w-full" /></Field>
                <Field label="Temperatura"><input name="temperature" defaultValue={cfg.temperature} required className="input w-full" /></Field>
                {a.activated_at && <Field label="Powód zmiany (interwencja)"><input name="reason" required className="input w-full" /></Field>}
                <button className="btn btn-primary md:col-span-3">Zapisz</button>
              </ActionForm>
            </details>
          )}
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mb-6">
        <Card title="Rozkład decyzji">
          {actionStats.length === 0 ? <Empty>Brak decyzji.</Empty> : (
            <KV items={actionStats.map((s) => [s.action, String(s.n)])} />
          )}
        </Card>
        <Card title="Najczęściej blokujące bramki ryzyka" className="lg:col-span-2">
          {gateStats.length === 0 ? <Empty>Żadna decyzja nie została zablokowana.</Empty> : <KV items={gateStats.map((g) => [g.gate, String(g.n)])} />}
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-6">
        <Card title="Decyzje" actions={<Link className="link text-xs" href={`/decisions?agent=${a.id}`}>wszystkie</Link>} bodyClass="">
          {decisions.length === 0 ? <Empty>Brak.</Empty> : (
            <table className="tbl"><thead><tr><th>Czas</th><th>Akcja</th><th>p</th><th>Status</th><th className="text-right">Wynik R</th></tr></thead>
              <tbody>{decisions.map((d) => (
                <tr key={d.id}><td className="text-muted">{fmtTime(d.decided_at)}</td>
                  <td><Link className="link" href={`/decisions/${d.id}`}>{d.action}{d.symbol ? ` ${d.symbol}` : ""}</Link></td>
                  <td>{d.probability !== null ? fmtNum(d.probability, 2) : "—"}</td><td><StatusBadge status={d.status} /></td>
                  <td className={`text-right ${pnlClass(d.outcome_r)}`}>{d.outcome_r !== null ? fmtSigned(d.outcome_r) : "—"}</td></tr>))}
              </tbody></table>
          )}
        </Card>
        <Card title="Transakcje" actions={<Link className="link text-xs" href={`/trades?agent=${a.id}`}>wszystkie</Link>} bodyClass="">
          {trades.length === 0 ? <Empty>Brak.</Empty> : (
            <table className="tbl"><thead><tr><th>Otwarcie</th><th>Instrument</th><th>Status</th><th>Wyjście</th><th className="text-right">P/L</th><th className="text-right">R</th></tr></thead>
              <tbody>{trades.map((t) => {
                const pnl = t.status === "open" ? t.unrealized_pnl : t.net_pnl;
                return (
                  <tr key={t.id}><td className="text-muted">{fmtTime(t.opened_at)}</td>
                    <td><Link className="link" href={`/trades/${t.id}`}>{t.direction === "long" ? "▲" : "▼"} {t.symbol}</Link></td>
                    <td><StatusBadge status={t.status} /></td><td>{t.exit_reason ?? "—"}</td>
                    <td className={`text-right ${pnlClass(pnl)}`}>{fmtSigned(pnl)}</td><td className="text-right">{fmtNum(t.r_multiple)}</td></tr>);
              })}</tbody></table>
          )}
        </Card>
      </div>

      <Card title="Ostatnie uruchomienia" bodyClass="">
        {runs.length === 0 ? <Empty>Agent jeszcze nie był uruchamiany.</Empty> : (
          <table className="tbl"><thead><tr><th>Start</th><th>Wyzwalacz</th><th>Status</th><th>Powód / błąd</th><th className="text-right">Koszt</th><th className="text-right">Czas modelu</th></tr></thead>
            <tbody>{runs.map((r) => (
              <tr key={r.id}><td className="text-muted">{fmtTime(r.started_at)} <span className="text-xs">({ago(r.started_at)})</span></td><td>{r.trigger}</td>
                <td><StatusBadge status={r.status} /></td><td className="max-w-md break-words text-xs">{r.skip_reason ?? r.error ?? "—"}</td>
                <td className="text-right">{r.cost !== null ? `$${fmtNum(r.cost, 4)}` : "—"}</td><td className="text-right">{r.latency !== null ? `${(r.latency / 1000).toFixed(1)} s` : "—"}</td></tr>))}
            </tbody></table>
        )}
      </Card>
    </>
  );
}
