import type { ReactNode } from "react";
import { fmtDate, fmtNum, fmtPct, fmtSigned, pnlClass } from "@/lib/format";
import { fmtHours, metrics, type InstrumentAgg } from "@/lib/instruments";

export interface StatsRow extends InstrumentAgg {
  key: string;
  label: ReactNode;
  sub?: ReactNode;
  max_drawdown?: number | null;
  last_trade_at?: Date | null;
}

function pf(v: number | null): string {
  if (v === null) return "—";
  return v === Infinity ? "∞" : fmtNum(v);
}

function winTone(v: number | null): string {
  if (v === null) return "";
  return v >= 50 ? "text-good" : v < 35 ? "text-bad" : "";
}

/** Performance table: one row per instrument / strategy / agent, plus an optional totals row. */
export function StatsTable({ rows, total, firstCol = "Walor", showDrawdown = true, showLast = true }: {
  rows: StatsRow[]; total?: StatsRow; firstCol?: string; showDrawdown?: boolean; showLast?: boolean;
}) {
  const render = (r: StatsRow, isTotal = false) => {
    const m = metrics(r);
    return (
      <tr key={r.key} className={isTotal ? "font-medium border-t-2 border-line" : r.trades_total === 0 ? "opacity-50" : ""}>
        <td className="whitespace-nowrap">{r.label}{r.sub && <div className="text-xs text-muted font-normal">{r.sub}</div>}</td>
        <td className="text-right">{r.closed_trades}{r.open_trades ? <span className="text-muted"> +{r.open_trades}</span> : null}</td>
        <td className="text-right whitespace-nowrap"><span className="text-good">{r.wins}</span> / <span className="text-bad">{r.losses}</span></td>
        <td className={`text-right ${winTone(m.winRate)}`}>{fmtPct(m.winRate, 1)}</td>
        <td className="text-right text-xs whitespace-nowrap text-muted">
          {r.long_closed ? `▲ ${fmtPct(m.longWinRate, 0)} (${r.long_closed})` : "▲ —"}<br />
          {r.short_closed ? `▼ ${fmtPct(m.shortWinRate, 0)} (${r.short_closed})` : "▼ —"}
        </td>
        <td className={`text-right ${pnlClass(r.net_pnl)}`}>{fmtSigned(r.net_pnl)}</td>
        <td className={`text-right ${m.profitFactor !== null && m.profitFactor < 1 ? "text-bad" : m.profitFactor !== null && m.profitFactor >= 1.5 ? "text-good" : ""}`}>{pf(m.profitFactor)}</td>
        <td className={`text-right ${pnlClass(m.expectancyR)}`}>{fmtNum(m.expectancyR, 3)}</td>
        <td className={`text-right ${pnlClass(r.total_r)}`}>{r.r_count ? fmtSigned(r.total_r) : "—"}</td>
        <td className="text-right whitespace-nowrap"><span className="text-good">{fmtNum(m.avgWin)}</span> / <span className="text-bad">{fmtNum(m.avgLoss)}</span></td>
        <td className="text-right">{fmtNum(m.payoff)}</td>
        <td className="text-right whitespace-nowrap">{fmtNum(r.best_r)} / {fmtNum(r.worst_r)}</td>
        {showDrawdown && <td className="text-right">{r.max_drawdown ? fmtNum(-r.max_drawdown) : "—"}</td>}
        <td className="text-right">{r.closed_trades ? fmtNum(r.costs) : "—"}</td>
        <td className="text-right whitespace-nowrap">{fmtHours(m.avgHoldHours)}</td>
        <td className={`text-right ${pnlClass(r.open_pnl)}`}>{r.open_trades ? fmtSigned(r.open_pnl) : "—"}</td>
        {showLast && <td className="text-muted whitespace-nowrap">{r.last_trade_at ? fmtDate(r.last_trade_at) : "—"}</td>}
      </tr>
    );
  };
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>{firstCol}</th>
            <th className="text-right" title="zamknięte (+ otwarte)">Transakcje</th>
            <th className="text-right">Zysk / strata</th>
            <th className="text-right" title="odsetek zamkniętych transakcji z dodatnim wynikiem netto">Skuteczność</th>
            <th className="text-right">Long / short</th>
            <th className="text-right">Wynik netto</th>
            <th className="text-right" title="profit factor: suma zysków / suma strat">PF</th>
            <th className="text-right" title="wartość oczekiwana: średni wynik transakcji w R">E[R]</th>
            <th className="text-right">Suma R</th>
            <th className="text-right">Śr. zysk / strata</th>
            <th className="text-right" title="średni zysk / średnia strata">Payoff</th>
            <th className="text-right">Najl. / najg. R</th>
            {showDrawdown && <th className="text-right" title="największe obsunięcie krzywej wyniku z zamkniętych transakcji">Maks. DD</th>}
            <th className="text-right" title="prowizje + swap">Koszty</th>
            <th className="text-right">Śr. czas</th>
            <th className="text-right">Otwarte P/L</th>
            {showLast && <th>Ostatnia</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => render(r))}
          {total && render(total, true)}
        </tbody>
      </table>
    </div>
  );
}
