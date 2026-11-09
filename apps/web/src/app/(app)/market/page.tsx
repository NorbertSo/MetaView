import { db } from "@/lib/db";
import { ago, fmtDate, fmtNum, fmtTime } from "@/lib/format";
import { ActionForm, Badge, Card, Empty, Flash, PageHeader, StatusBadge, Tabs } from "@/components/ui";
import { enqueueCommand } from "../actions/control";

export const dynamic = "force-dynamic";

export default async function MarketPage({ searchParams }: { searchParams: Promise<{ tab?: string; msg?: string; err?: string }> }) {
  const sp = await searchParams;
  const tab = sp.tab ?? "brief";
  const sql = db();
  const tabs = [
    { key: "brief", label: "Raport analityka", href: "/market?tab=brief" },
    { key: "calendar", label: "Kalendarz", href: "/market?tab=calendar" },
    { key: "news", label: "Wiadomości", href: "/market?tab=news" },
    { key: "cot", label: "COT", href: "/market?tab=cot" },
    { key: "reactions", label: "Reakcje na eventy", href: "/market?tab=reactions" },
  ];
  return (
    <>
      <PageHeader title="Rynek" subtitle="Wspólny kontekst dla wszystkich agentów. Dane pochodzą z narzędzi i źródeł — model ich nie wymyśla."
        actions={<>
          <ActionForm action={enqueueCommand} back={`/market?tab=${tab}`}><input type="hidden" name="kind" value="generate_brief" /><button className="btn">Wygeneruj raport teraz</button></ActionForm>
          <ActionForm action={enqueueCommand} back={`/market?tab=${tab}`}><input type="hidden" name="kind" value="fetch_source" /><input type="hidden" name="p_code" value="forexfactory" /><button className="btn">Odśwież kalendarz</button></ActionForm>
        </>} />
      <Flash msg={sp.msg} err={sp.err} />
      <Tabs items={tabs} current={tab} />
      {tab === "brief" && <Briefs />}
      {tab === "calendar" && <Calendar />}
      {tab === "news" && <News />}
      {tab === "cot" && <Cot />}
      {tab === "reactions" && <Reactions />}
    </>
  );

  async function Briefs() {
    const briefs = await sql<{ id: string; created_at: Date; valid_until: Date; produced_by: string; regime: string; summary_md: string; central_banks: { bank: string; stance: string; next_meeting: string | null; notes: string }[];
      calendar: { time_utc: string; currency: string; title: string; importance: string; note: string }[]; instruments: Record<string, { bias: string; confidence: number; notes: string }>; confidence: number | null; model: string | null }[]>`
      select b.*, m.display_name as model from market_briefs b left join llm_calls c on c.id = b.llm_call_id left join llm_models m on m.id = c.model_id
      order by b.created_at desc limit 10`;
    if (!briefs.length) return <Card><Empty>Brak raportów. Przypisz model analityka w Ustawieniach i wygeneruj raport.</Empty></Card>;
    const [b, ...older] = briefs;
    const valid = new Date(b!.valid_until) > new Date();
    return (
      <>
        <Card className="mb-4" title={<span className="flex items-center gap-2">Raport {fmtDate(b!.created_at)} <StatusBadge status={valid ? "ok" : "stale"} label={valid ? `ważny do ${fmtTime(b!.valid_until)}` : "nieaktualny"} /></span>}
          actions={<span className="text-xs text-muted">{b!.produced_by} · {b!.model ?? "—"} · reżim <b>{b!.regime}</b> · pewność {fmtNum(b!.confidence, 2)}</span>}>
          <div className="text-sm whitespace-pre-wrap leading-relaxed mb-5">{b!.summary_md}</div>
          <div className="grid lg:grid-cols-2 gap-5">
            <div>
              <div className="text-xs text-muted mb-2">Instrumenty</div>
              <table className="tbl"><tbody>{Object.entries(b!.instruments ?? {}).map(([sym, v]) => (
                <tr key={sym}><td className="font-medium">{sym}</td><td><Badge tone={v.bias === "long" ? "good" : v.bias === "short" ? "bad" : "muted"}>{v.bias}</Badge></td><td>{fmtNum(v.confidence, 2)}</td><td className="text-xs text-muted">{v.notes}</td></tr>))}
              </tbody></table>
            </div>
            <div>
              <div className="text-xs text-muted mb-2">Banki centralne</div>
              <table className="tbl"><tbody>{(b!.central_banks ?? []).map((c) => (
                <tr key={c.bank}><td className="font-medium">{c.bank}</td><td>{c.stance}</td><td className="text-xs">{c.next_meeting ?? "—"}</td><td className="text-xs text-muted">{c.notes}</td></tr>))}
              </tbody></table>
            </div>
          </div>
        </Card>
        {older.length > 0 && (
          <Card title="Wcześniejsze raporty" bodyClass="">
            <table className="tbl"><tbody>{older.map((o) => (
              <tr key={o.id}><td className="whitespace-nowrap">{fmtDate(o.created_at)}</td><td>{o.regime}</td><td className="text-xs text-muted max-w-3xl truncate">{o.summary_md}</td></tr>))}</tbody></table>
          </Card>
        )}
      </>
    );
  }

  async function Calendar() {
    const events = await sql<{ id: string; scheduled_at: Date; currency: string | null; title: string; importance: string; forecast_raw: string | null; previous_raw: string | null; actual_raw: string | null; surprise: number | null; source: string }[]>`
      select * from economic_events where scheduled_at between now() - interval '2 days' and now() + interval '7 days' and importance <> 'low' order by scheduled_at`;
    if (!events.length) return <Card><Empty>Brak wydarzeń. Kliknij „Odśwież kalendarz”.</Empty></Card>;
    return (
      <Card bodyClass="">
        <table className="tbl"><thead><tr><th>Czas (PL)</th><th>Waluta</th><th>Wydarzenie</th><th>Waga</th><th className="text-right">Prognoza</th><th className="text-right">Poprzednio</th><th className="text-right">Odczyt</th><th className="text-right">Niespodzianka</th><th>Źródło</th></tr></thead>
          <tbody>{events.map((e) => (
            <tr key={e.id} className={new Date(e.scheduled_at) < new Date() ? "opacity-60" : ""}>
              <td className="whitespace-nowrap">{fmtTime(e.scheduled_at)}</td><td>{e.currency}</td><td>{e.title}</td>
              <td><Badge tone={e.importance === "high" ? "bad" : e.importance === "medium" ? "warn" : "muted"}>{e.importance}</Badge></td>
              <td className="text-right mono">{e.forecast_raw ?? "—"}</td><td className="text-right mono">{e.previous_raw ?? "—"}</td><td className="text-right mono">{e.actual_raw ?? "—"}</td>
              <td className="text-right mono">{e.surprise !== null ? fmtNum(e.surprise, 2) : "—"}</td><td className="text-xs text-muted">{e.source}</td></tr>))}
          </tbody></table>
      </Card>
    );
  }

  async function News() {
    const news = await sql<{ id: string; published_at: Date; source: string; title: string; summary: string | null; url: string | null; instruments: string[]; importance: number | null; ingested_via: string }[]>`
      select * from news_items order by published_at desc limit 100`;
    if (!news.length) return <Card><Empty>Brak wiadomości. Podłącz źródło (Apify, n8n lub zaplanowane zadanie Claude) przez API w Ustawienia → Źródła danych.</Empty></Card>;
    return (
      <Card bodyClass="">
        <table className="tbl"><thead><tr><th>Czas</th><th>Źródło</th><th>Nagłówek</th><th>Instrumenty</th><th>Waga</th><th>Wpłynęło przez</th></tr></thead>
          <tbody>{news.map((n) => (
            <tr key={n.id}><td className="whitespace-nowrap text-muted">{fmtTime(n.published_at)}<div className="text-xs">{ago(n.published_at)}</div></td><td>{n.source}</td>
              <td>{n.url ? <a className="link" href={n.url} target="_blank" rel="noreferrer noopener">{n.title}</a> : n.title}{n.summary && <div className="text-xs text-muted mt-1">{n.summary}</div>}</td>
              <td className="mono">{n.instruments.join(" ")}</td><td>{n.importance ?? "—"}</td><td className="text-xs">{n.ingested_via}</td></tr>))}
          </tbody></table>
      </Card>
    );
  }

  async function Cot() {
    const rows = await sql<{ market_name: string; report_date: Date; noncomm_net: number | null; open_interest: number | null; prev_net: number | null }[]>`
      select distinct on (market_code) market_name, report_date, noncomm_net, open_interest,
             lag(noncomm_net) over (partition by market_code order by report_date) as prev_net
      from (select * from cot_reports) c order by market_code, report_date desc`;
    if (!rows.length) return <Card><Empty>Brak danych COT.</Empty></Card>;
    return (
      <Card bodyClass="">
        <table className="tbl"><thead><tr><th>Rynek</th><th>Raport z</th><th className="text-right">Net spekulantów</th><th className="text-right">Zmiana t/t</th><th className="text-right">Open interest</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.market_name}><td>{r.market_name}</td><td>{fmtDate(r.report_date).slice(0, 10)}</td><td className="text-right">{fmtNum(r.noncomm_net, 0)}</td>
              <td className={`text-right ${r.prev_net !== null && r.noncomm_net !== null ? (r.noncomm_net - r.prev_net > 0 ? "text-good" : "text-bad") : ""}`}>{r.prev_net !== null && r.noncomm_net !== null ? fmtNum(r.noncomm_net - r.prev_net, 0) : "—"}</td>
              <td className="text-right">{fmtNum(r.open_interest, 0)}</td></tr>))}
          </tbody></table>
        <p className="text-xs text-muted p-4">Zmiana t/t liczona względem poprzedniego raportu w bazie (pobierane są ostatnie 8 tygodni).</p>
      </Card>
    );
  }

  async function Reactions() {
    const rows = await sql<{ scheduled_at: Date; title: string; currency: string; surprise: number | null; symbol: string; move_1m_points: number | null; move_5m_points: number | null; move_15m_points: number | null; move_60m_points: number | null; max_spread_points: number | null }[]>`
      select e.scheduled_at, e.title, e.currency, e.surprise, r.symbol, r.move_1m_points, r.move_5m_points, r.move_15m_points, r.move_60m_points, r.max_spread_points
      from event_reactions r join economic_events e on e.id = r.event_id order by e.scheduled_at desc, r.symbol limit 200`;
    if (!rows.length) return <Card><Empty>Reakcje liczone są automatycznie dla ważnych eventów na instrumentach aktywnych agentów (ok. godzinę po evencie).</Empty></Card>;
    return (
      <Card bodyClass="">
        <table className="tbl"><thead><tr><th>Event</th><th>Instrument</th><th className="text-right">Niespodzianka</th><th className="text-right">+1 min</th><th className="text-right">+5</th><th className="text-right">+15</th><th className="text-right">+60</th><th className="text-right">Maks. spread</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}><td>{fmtTime(r.scheduled_at)} {r.currency} {r.title}</td><td>{r.symbol}</td><td className="text-right mono">{r.surprise !== null ? fmtNum(r.surprise, 2) : "—"}</td>
              <td className="text-right">{fmtNum(r.move_1m_points, 0)}</td><td className="text-right">{fmtNum(r.move_5m_points, 0)}</td><td className="text-right">{fmtNum(r.move_15m_points, 0)}</td><td className="text-right">{fmtNum(r.move_60m_points, 0)}</td>
              <td className="text-right">{fmtNum(r.max_spread_points, 1)}</td></tr>))}
          </tbody></table>
        <p className="text-xs text-muted p-4">Ruchy w punktach od ceny zamknięcia świecy przed eventem.</p>
      </Card>
    );
  }
}
