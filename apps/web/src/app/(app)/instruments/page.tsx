import Link from "next/link";
import { db } from "@/lib/db";
import { fmtNum, fmtPct, fmtSigned } from "@/lib/format";
import { GROUPS, groupLabel, groupOf, instrumentHref, metrics, subclassLabel, sumAgg, type GroupKey, type InstrumentAgg } from "@/lib/instruments";
import { Card, Empty, PageHeader, Stat, Tabs } from "@/components/ui";
import { StatsTable, type StatsRow } from "@/components/instrument-table";
import { CostsTable } from "@/components/costs-table";
import { costRows } from "@/lib/cost-data";

export const dynamic = "force-dynamic";

type Row = InstrumentAgg & {
  symbol: string; description: string | null; asset_class: string | null; currency_profit: string | null;
  agents: number; strategies: number; max_drawdown: number; last_trade_at: Date | null;
};

export default async function InstrumentsPage({ searchParams }: { searchParams: Promise<{ group?: string; traded?: string; view?: string }> }) {
  const sp = await searchParams;
  const sql = db();
  const view = sp.view === "costs" ? "costs" : "results";
  const [all, [ccyRow], costs] = await Promise.all([
    sql<Row[]>`select * from v_instrument_stats order by trades_total desc, symbol`,
    sql<{ currency: string | null }[]>`select currency from mt_accounts where status <> 'archived' order by created_at limit 1`,
    view === "costs" ? costRows() : Promise.resolve([]),
  ]);
  const ccy = ccyRow?.currency ?? "";

  // Stocks (thousands of symbols) are listed only once something was traded on them.
  const visible = all.filter((r) => groupOf(r.asset_class) !== "stocks" || r.trades_total > 0);
  const group = (sp.group ?? "all") as GroupKey | "all";
  const tradedOnly = sp.traded === "1";
  const rows = visible.filter((r) => (group === "all" || groupOf(r.asset_class) === group) && (!tradedOnly || r.trades_total > 0));

  const present = new Set(visible.map((r) => groupOf(r.asset_class)));
  const groupKeys: GroupKey[] = [...GROUPS.map((g) => g.key), "other"].filter((k) => present.has(k as GroupKey)) as GroupKey[];
  const qs = (g: string, t: boolean, v: string = view) =>
    `/instruments?${new URLSearchParams({ ...(v === "costs" ? { view: "costs" } : {}), ...(g !== "all" ? { group: g } : {}), ...(t ? { traded: "1" } : {}) })}`;
  const tabs = [
    { key: "all", label: `Wszystkie (${visible.length})`, href: qs("all", tradedOnly) },
    ...groupKeys.map((k) => ({ key: k, label: `${groupLabel(k)} (${visible.filter((r) => groupOf(r.asset_class) === k).length})`, href: qs(k, tradedOnly) })),
  ];

  const totalAll = sumAgg(visible);
  const mAll = metrics(totalAll);
  const traded = visible.filter((r) => r.trades_total > 0);
  const withClosed = traded.filter((r) => r.closed_trades > 0);
  const best = [...withClosed].sort((a, b) => b.net_pnl - a.net_pnl)[0];
  const worst = [...withClosed].sort((a, b) => a.net_pnl - b.net_pnl)[0];

  const toStats = (r: Row): StatsRow => ({
    ...r,
    key: r.symbol,
    label: <Link href={instrumentHref(r.symbol)} className="link font-medium mono">{r.symbol}</Link>,
    sub: <>{subclassLabel(r.asset_class)}{r.description ? ` · ${r.description.replace(/ CFD.*$/, "")}` : ""}</>,
  });

  const groupRows: StatsRow[] = groupKeys.map((k) => {
    const members = visible.filter((r) => groupOf(r.asset_class) === k);
    return { ...sumAgg(members), key: k, label: <Link href={qs(k, tradedOnly)} className="link font-medium">{groupLabel(k)}</Link>,
      sub: `${members.filter((m) => m.trades_total > 0).length} z ${members.length} walorów z transakcjami` };
  });

  return (
    <>
      <PageHeader title="Walory" subtitle={<>Wszystkie instrumenty z konta MT i wyniki na każdym z nich, łącznie dla wszystkich agentów i strategii. Kwoty w walucie konta{ccy ? ` (${ccy})` : ""}. Skuteczność i wynik liczone z zamkniętych transakcji, po kosztach.</>} />

      <div className="flex gap-2 mb-5">
        <Link href={qs(group, tradedOnly, "results")} className={`btn ${view === "results" ? "btn-primary" : ""}`}>Wyniki i skuteczność</Link>
        <Link href={qs(group, tradedOnly, "costs")} className={`btn ${view === "costs" ? "btn-primary" : ""}`}>Koszty: spread, swap, depozyt</Link>
      </div>

      {view === "costs" ? (
        <>
          <Tabs items={tabs} current={group} />
          <Card bodyClass="">
            <CostsTable rows={costs.filter((c) => rows.some((r) => r.symbol === c.symbol))} ccy={ccy} />
          </Card>
          <p className="text-xs text-muted mt-2">
            Kwoty w {ccy || "walucie konta"} na 1 lot. Spread: próbki co 10 minut w godzinach handlu (mediana i 90. percentyl z 7 dni) — pierwsze sensowne wartości po kilku godzinach zbierania.
            Swap: stawka brokera przeliczona na jedną noc; ujemny = płacisz, dodatni = dostajesz. W dniu potrójnego swapu naliczane są 3 noce (weekend).
            Depozyt liczy broker dla 1 lota po bieżącej cenie. Prowizja pochodzi z faktycznie zamkniętych transakcji. Szczegóły i spread wg godzin — na stronie waloru.
          </p>
        </>
      ) : (<>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <Stat label="Transakcje" value={totalAll.trades_total} hint={`${totalAll.closed_trades} zamkniętych · ${totalAll.open_trades} otwartych · ${traded.length} walorów`} />
        <Stat label="Skuteczność" value={fmtPct(mAll.winRate, 1)} hint={`${totalAll.wins} zysków / ${totalAll.losses} strat`} tone={mAll.winRate === null ? undefined : mAll.winRate >= 50 ? "good" : undefined} />
        <Stat label="Wynik netto" value={fmtSigned(totalAll.net_pnl)} tone={totalAll.net_pnl > 0 ? "good" : totalAll.net_pnl < 0 ? "bad" : undefined} hint={`koszty ${fmtNum(totalAll.costs)}`} />
        <Stat label="Profit factor / E[R]" value={<>{mAll.profitFactor === null ? "—" : mAll.profitFactor === Infinity ? "∞" : fmtNum(mAll.profitFactor)} <span className="text-base text-muted">/ {fmtNum(mAll.expectancyR, 3)} R</span></>} hint={`suma ${fmtSigned(totalAll.total_r)} R`} />
        <Stat label="Najlepszy / najgorszy" value={<span className="text-base">{best ? <span className="text-good">{best.symbol}</span> : "—"} / {worst && worst !== best ? <span className="text-bad">{worst.symbol}</span> : "—"}</span>}
          hint={best ? `${fmtSigned(best.net_pnl)}${worst && worst !== best ? ` / ${fmtSigned(worst.net_pnl)}` : ""}` : "brak zamkniętych transakcji"} />
      </div>

      <Card title="Wyniki wg grupy" bodyClass="" className="mb-6">
        <StatsTable rows={groupRows} total={{ ...totalAll, key: "total", label: "Razem" }} firstCol="Grupa" showDrawdown={false} showLast={false} />
      </Card>

      <Tabs items={tabs} current={group} />
      <div className="flex items-center justify-between mb-3 text-sm">
        <span className="text-muted">{rows.length} walorów{group !== "all" ? ` w grupie ${groupLabel(group as GroupKey)}` : ""}</span>
        <Link href={qs(group, !tradedOnly)} className="link">{tradedOnly ? "pokaż wszystkie" : "tylko z transakcjami"}</Link>
      </div>
      <Card bodyClass="">
        {rows.length === 0 ? <Empty>{tradedOnly ? "Brak transakcji w tej grupie." : "Brak walorów — zsynchronizuj instrumenty w Konta MT."}</Empty> : (
          <StatsTable rows={rows.map(toStats)} total={rows.length > 1 ? { ...sumAgg(rows), key: "total", label: "Razem" } : undefined} />
        )}
      </Card>
      <p className="text-xs text-muted mt-2">Wyszarzone wiersze: walor dostępny, ale bez transakcji. Akcje pojawiają się tu dopiero po pierwszej transakcji. Maks. DD — największe obsunięcie krzywej wyniku zamkniętych transakcji na danym walorze.</p>
      </>)}
    </>
  );
}
