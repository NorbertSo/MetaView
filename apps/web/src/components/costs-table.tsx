import Link from "next/link";
import { ago, fmtNum } from "@/lib/format";
import { instrumentHref, subclassLabel } from "@/lib/instruments";
import { notionalPerLot, pointsValue, sessionsLabel, swapNightsPerWeek, swapPerNight, tripleSwapDay } from "@/lib/costs";
import type { CostRow } from "@/lib/cost-data";

function money(v: number | null, digits = 2): string {
  return v === null ? "—" : fmtNum(v, digits);
}

function tone(v: number | null): string {
  if (v === null || v === 0) return "";
  return v > 0 ? "text-good" : "text-bad";
}

/** One row per instrument: spread, swap, margin, commission and sessions, all per 1 lot in account currency. */
export function CostsTable({ rows, ccy }: { rows: CostRow[]; ccy: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>Walor</th>
            <th className="text-right" title="bieżący spread w punktach">Spread teraz</th>
            <th className="text-right" title="mediana z próbek co 10 min, ostatnie 7 dni">Spread mediana 7d</th>
            <th className="text-right" title="90. percentyl — tak szeroko bywa w gorszych godzinach">Spread p90</th>
            <th className="text-right" title={`koszt spreadu (mediana) przy otwarciu 1 lota, ${ccy}`}>Spread / lot</th>
            <th className="text-right" title="spread jako % ceny">Spread % ceny</th>
            <th className="text-right" title={`swap za noc dla 1 lota long, ${ccy}`}>Swap long / noc</th>
            <th className="text-right" title={`swap za noc dla 1 lota short, ${ccy}`}>Swap short / noc</th>
            <th>Potrójny swap</th>
            <th className="text-right" title={`wymagany depozyt dla 1 lota, ${ccy}`}>Depozyt / lot</th>
            <th className="text-right" title={`wartość nominalna 1 lota, ${ccy}`}>Wartość 1 lota</th>
            <th className="text-right" title="średnia prowizja na lot z zamkniętych transakcji">Prowizja / lot</th>
            <th>Sesja (czas serwera)</th>
            <th>Notowanie</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const now = r.last_bid !== null && r.last_ask !== null ? (r.last_ask - r.last_bid) / r.point : null;
            const spreadMoney = pointsValue(r.median_7d ?? now, r);
            const mid = r.last_bid !== null && r.last_ask !== null ? (r.last_bid + r.last_ask) / 2 : null;
            const spreadPct = mid && (r.median_7d ?? now) !== null ? (((r.median_7d ?? now)! * r.point) / mid) * 100 : null;
            const sl = swapPerNight(r.swap_long, r), ss = swapPerNight(r.swap_short, r);
            return (
              <tr key={r.symbol}>
                <td className="whitespace-nowrap"><Link href={instrumentHref(r.symbol)} className="link font-medium mono">{r.symbol}</Link>
                  <div className="text-xs text-muted">{subclassLabel(r.asset_class)}</div></td>
                <td className="text-right">{now !== null ? fmtNum(now, 0) : "—"}</td>
                <td className="text-right">{r.median_7d !== null ? fmtNum(r.median_7d, 0) : <span className="text-muted">zbieram</span>}
                  {r.n_7d ? <div className="text-xs text-muted">{r.n_7d} próbek</div> : null}</td>
                <td className="text-right">{r.p90_7d !== null ? fmtNum(r.p90_7d, 0) : "—"}</td>
                <td className="text-right">{money(spreadMoney)}</td>
                <td className="text-right">{spreadPct !== null ? `${fmtNum(spreadPct, 3)}%` : "—"}</td>
                <td className={`text-right ${tone(sl)}`}>{money(sl)}</td>
                <td className={`text-right ${tone(ss)}`}>{money(ss)}</td>
                <td className="whitespace-nowrap">{tripleSwapDay(r.raw)}{swapNightsPerWeek(r.raw) !== 7 ? <span className="text-xs text-muted"> ({swapNightsPerWeek(r.raw)}×/tydz.)</span> : null}</td>
                <td className="text-right">{money(r.margin_per_lot)}</td>
                <td className="text-right">{money(notionalPerLot(r), 0)}</td>
                <td className="text-right">{r.commission_per_lot !== null ? money(r.commission_per_lot) : <span className="text-muted">brak transakcji</span>}</td>
                <td className="text-xs whitespace-nowrap">{sessionsLabel(r.raw)}</td>
                <td className="text-xs text-muted whitespace-nowrap">{r.quote_at ? ago(r.quote_at) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
