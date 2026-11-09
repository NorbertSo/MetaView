import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { fmtDate, fmtNum, fmtSigned } from "@/lib/format";
import { ActionForm, Card, Empty, Flash, KV, PageHeader, StatusBadge } from "@/components/ui";
import { closeTradeManually } from "../../actions/control";

export const dynamic = "force-dynamic";

export default async function TradePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const sql = db();
  const [t] = await sql<{ id: string; agent_id: string; code: string; position_id: string; symbol: string; direction: string; status: string; volume_initial: number; volume_open: number;
    requested_entry_price: number | null; entry_price: number; slippage_points: number | null; initial_sl: number; initial_tp: number | null; current_sl: number | null; current_tp: number | null;
    risk_amount: number; risk_pct: number; opened_at: Date; closed_at: Date | null; exit_price: number | null; exit_reason: string | null; realized_gross_pnl: number; commission: number; swap: number;
    net_pnl: number; unrealized_pnl: number; r_multiple: number | null; mae_price: number | null; mfe_price: number | null; open_decision_id: string | null }[]>`
    select t.*, a.code from trades t join agents a on a.id = t.agent_id where t.id = ${id}`;
  if (!t) notFound();
  const [events, [review], decisions] = await Promise.all([
    sql<{ id: string; occurred_at: Date; kind: string; old_value: unknown; new_value: unknown; volume: number | null; price: number | null; pnl: number | null; decision_id: string | null; deal_id: string | null }[]>`
      select * from position_events where trade_id = ${id} order by occurred_at`,
    sql<{ thesis_held: boolean | null; process_quality: number | null; what_worked: string; what_failed: string; lesson_candidate: string | null; tags: string[]; created_at: Date }[]>`
      select * from trade_reviews where trade_id = ${id}`,
    sql<{ id: string; decided_at: Date; action: string; status: string }[]>`
      select id, decided_at, action, status from decisions where id = ${t.open_decision_id} or target_trade_id = ${id} order by decided_at`,
  ]);
  const back = `/trades/${id}`;
  const riskDist = Math.abs(t.entry_price - t.initial_sl);
  const mae = t.mae_price !== null && riskDist > 0 ? (t.direction === "long" ? (t.mae_price - t.entry_price) : (t.entry_price - t.mae_price)) / riskDist : null;
  const mfe = t.mfe_price !== null && riskDist > 0 ? (t.direction === "long" ? (t.mfe_price - t.entry_price) : (t.entry_price - t.mfe_price)) / riskDist : null;

  return (
    <>
      <PageHeader title={`${t.direction === "long" ? "▲ Long" : "▼ Short"} ${t.symbol}`}
        subtitle={<><Link className="link" href={`/agents/${t.agent_id}`}>{t.code}</Link> · pozycja #{t.position_id} · {fmtDate(t.opened_at)}{t.closed_at ? ` → ${fmtDate(t.closed_at)}` : ""}</>}
        actions={<StatusBadge status={t.status} />} />
      <Flash msg={sp.msg} err={sp.err} />
      <div className="grid lg:grid-cols-3 gap-4 mb-6">
        <Card title="Pozycja">
          <KV items={[
            ["Wolumen", `${t.volume_initial}${t.status === "open" && t.volume_open !== t.volume_initial ? ` (otwarte ${t.volume_open})` : ""}`],
            ["Wejście (żądane → realne)", `${t.requested_entry_price ?? "—"} → ${t.entry_price}`], ["Poślizg", t.slippage_points !== null ? `${t.slippage_points} pkt` : "—"],
            ["SL początkowy / aktualny", `${t.initial_sl} / ${t.current_sl ?? "—"}`], ["TP początkowy / aktualny", `${t.initial_tp ?? "—"} / ${t.current_tp ?? "—"}`],
            ["Ryzyko (1R)", `${fmtNum(t.risk_amount)} (${fmtNum(t.risk_pct, 2)}% equity agenta)`],
          ]} />
        </Card>
        <Card title="Wynik">
          <KV items={[
            ["Wyjście", `${t.exit_price ?? "—"} (${t.exit_reason ?? "otwarta"})`],
            ["Wynik brutto", fmtSigned(t.realized_gross_pnl)], ["Prowizja / swap", `${fmtNum(t.commission)} / ${fmtNum(t.swap)}`],
            ["Wynik netto", t.status === "open" ? `${fmtSigned(t.unrealized_pnl)} (niezrealizowany)` : fmtSigned(t.net_pnl)],
            ["R", fmtNum(t.r_multiple)],
            ["MAE / MFE", `${mae !== null ? `${fmtNum(mae)} R` : "—"} / ${mfe !== null ? `${fmtNum(mfe)} R` : "—"}`],
          ]} />
          <p className="text-xs text-muted mt-3">MAE/MFE: najgorszy i najlepszy ruch ceny w trakcie pozycji (próbkowane co ~30 s), w jednostkach ryzyka.</p>
        </Card>
        <Card title="Działania">
          {t.status === "open" ? (
            <ActionForm action={closeTradeManually} back={back} className="space-y-2">
              <input type="hidden" name="trade_id" value={t.id} />
              <p className="text-xs text-muted">Ręczne zamknięcie to interwencja — zapisze się z powodem i stanem kapitału.</p>
              <input name="reason" required minLength={3} placeholder="Powód" className="input w-full" />
              <button className="btn btn-danger w-full">Zamknij pozycję</button>
            </ActionForm>
          ) : <p className="text-sm text-muted">Pozycja zamknięta.</p>}
          <div className="mt-4 text-sm space-y-1">
            {decisions.map((d) => <div key={d.id}><Link className="link" href={`/decisions/${d.id}`}>{d.action}</Link> <span className="text-muted">{fmtDate(d.decided_at)}</span> <StatusBadge status={d.status} /></div>)}
          </div>
        </Card>
      </div>

      <Card title="Przegląd po transakcji" className="mb-6">
        {review ? (
          <KV items={[
            ["Teza się sprawdziła", review.thesis_held === null ? "niejasne" : review.thesis_held ? "tak" : "nie"],
            ["Jakość procesu", review.process_quality ? `${review.process_quality}/5` : "—"],
            ["Co zadziałało", review.what_worked || "—"], ["Co nie zadziałało", review.what_failed || "—"],
            ["Kandydat na wniosek", review.lesson_candidate ?? "—"], ["Tagi", review.tags.join(", ") || "—"],
          ]} />
        ) : <Empty>{t.status === "open" ? "Przegląd powstanie po zamknięciu." : "Przegląd w przygotowaniu."}</Empty>}
      </Card>

      <Card title="Historia pozycji" bodyClass="">
        {events.length === 0 ? <Empty>Brak zdarzeń.</Empty> : (
          <table className="tbl"><thead><tr><th>Czas</th><th>Zdarzenie</th><th>Zmiana</th><th className="text-right">Wolumen</th><th className="text-right">Cena</th><th className="text-right">P/L</th><th>Deal</th></tr></thead>
            <tbody>{events.map((e) => (
              <tr key={e.id}><td>{fmtDate(e.occurred_at)}</td><td>{e.kind === "external_change" ? <StatusBadge status="warn" label="zmiana poza systemem" /> : e.kind}</td>
                <td className="mono">{e.old_value ? `${JSON.stringify(e.old_value)} → ` : ""}{e.new_value ? JSON.stringify(e.new_value) : ""}</td>
                <td className="text-right">{e.volume ?? "—"}</td><td className="text-right mono">{e.price ?? "—"}</td><td className="text-right">{e.pnl !== null ? fmtSigned(e.pnl) : "—"}</td><td className="mono">{e.deal_id ?? "—"}</td></tr>))}
            </tbody></table>
        )}
      </Card>
    </>
  );
}
