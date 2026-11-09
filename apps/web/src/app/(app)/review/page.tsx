import Link from "next/link";
import { db } from "@/lib/db";
import { fmtDate, fmtNum, fmtSigned } from "@/lib/format";
import { ActionForm, Badge, Card, Empty, Field, Flash, PageHeader, StatusBadge, Tabs } from "@/components/ui";
import { addSupport, createLesson, decideLesson, saveCommitment, saveReviewSession } from "../actions/review";

export const dynamic = "force-dynamic";

const COMMITMENT_KEYS: Record<string, string> = {
  max_real_capital: "Maksymalna kwota na realne konto (bez dopłacania)",
  real_account_conditions: "Warunki przejścia na realne konto",
  project_end_condition: "Kiedy kończę projekt",
  project_end_date: "Data ostatecznej oceny",
  other: "Inne",
};

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ tab?: string; strategy?: string; msg?: string; err?: string }> }) {
  const sp = await searchParams;
  const tab = sp.tab ?? "lessons";
  const sql = db();
  const strategies = await sql<{ id: string; code: string; name: string; closed: number; since_review: number }[]>`
    select s.id, s.code, s.name,
           (select count(*)::int from trades t join agents a on a.id = t.agent_id join strategy_versions v on v.id = a.strategy_version_id where v.strategy_id = s.id and t.status = 'closed') as closed,
           (select count(*)::int from trades t join agents a on a.id = t.agent_id join strategy_versions v on v.id = a.strategy_version_id
             where v.strategy_id = s.id and t.status = 'closed' and t.closed_at > coalesce((select max(period_end) from review_sessions r where r.strategy_id = s.id), '-infinity')) as since_review
    from strategies s order by s.code`;
  const strategyId = sp.strategy ?? strategies[0]?.id;
  const back = `/review?tab=${tab}${strategyId ? `&strategy=${strategyId}` : ""}`;
  const tabs = [
    { key: "lessons", label: "Wnioski", href: `/review?tab=lessons${strategyId ? `&strategy=${strategyId}` : ""}` },
    { key: "sessions", label: "Przeglądy okresowe", href: `/review?tab=sessions${strategyId ? `&strategy=${strategyId}` : ""}` },
    { key: "commitments", label: "Zobowiązania", href: "/review?tab=commitments" },
  ];

  return (
    <>
      <PageHeader title="Przegląd i wnioski" subtitle="Agent proponuje wnioski po każdej transakcji. Do jego kontekstu trafiają tylko te, które zatwierdzisz i które wspiera co najmniej 5 podobnych przypadków." />
      <Flash msg={sp.msg} err={sp.err} />
      <Tabs items={tabs} current={tab} />
      {tab !== "commitments" && strategies.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-5">
          {strategies.map((s) => (
            <Link key={s.id} href={`/review?tab=${tab}&strategy=${s.id}`} className={`btn btn-sm ${s.id === strategyId ? "btn-primary" : ""}`}>
              {s.code} <span className="opacity-70">({s.since_review} nowych / {s.closed})</span>
            </Link>
          ))}
        </div>
      )}
      {tab === "lessons" && (strategyId ? <Lessons strategyId={strategyId} back={back} /> : <Card><Empty>Brak strategii.</Empty></Card>)}
      {tab === "sessions" && (strategyId ? <Sessions strategyId={strategyId} back={back} sinceReview={strategies.find((s) => s.id === strategyId)?.since_review ?? 0} /> : <Card><Empty>Brak strategii.</Empty></Card>)}
      {tab === "commitments" && <Commitments back={back} />}
    </>
  );

  async function Lessons({ strategyId, back }: { strategyId: string; back: string }) {
    const [lessons, reviews] = await Promise.all([
      sql<{ id: string; body: string; tags: string[]; support: number; min_support: number; status: string; created_at: Date; decided_at: Date | null; decided_note: string | null }[]>`
        select id, body, tags, cardinality(supporting_review_ids) as support, min_support, status, created_at, decided_at, decided_note
        from lessons where strategy_id = ${strategyId} order by case status when 'candidate' then 0 when 'approved' then 1 else 2 end, created_at desc`,
      sql<{ id: string; trade_id: string; code: string; symbol: string; r_multiple: number | null; process_quality: number | null; thesis_held: boolean | null; lesson_candidate: string | null; tags: string[]; created_at: Date }[]>`
        select r.id, r.trade_id, a.code, t.symbol, t.r_multiple, r.process_quality, r.thesis_held, r.lesson_candidate, r.tags, r.created_at
        from trade_reviews r join trades t on t.id = r.trade_id join agents a on a.id = r.agent_id join strategy_versions v on v.id = a.strategy_version_id
        where v.strategy_id = ${strategyId} order by r.created_at desc limit 200`,
    ]);
    const candidates = lessons.filter((l) => l.status === "candidate");
    return (
      <div className="space-y-4">
        <Card title="Wnioski" bodyClass="">
          {lessons.length === 0 ? <Empty>Brak wniosków. Utwórz kandydata z przeglądów poniżej.</Empty> : (
            <table className="tbl"><thead><tr><th>Wniosek</th><th>Tagi</th><th>Przypadki</th><th>Status</th><th>Decyzja</th></tr></thead>
              <tbody>{lessons.map((l) => (
                <tr key={l.id}><td className="max-w-xl">{l.body}{l.decided_note && <div className="text-xs text-muted mt-1">{l.decided_note}</div>}</td>
                  <td>{l.tags.map((t) => <Badge key={t}>{t}</Badge>)}</td>
                  <td className={l.support >= l.min_support ? "text-good" : "text-warn"}>{l.support}/{l.min_support}</td>
                  <td><StatusBadge status={l.status} /></td>
                  <td>{l.status === "candidate" || l.status === "approved" ? (
                    <ActionForm action={decideLesson} back={back} className="flex flex-wrap gap-1">
                      <input type="hidden" name="id" value={l.id} />
                      <input name="note" placeholder="notatka" className="input w-32" />
                      {l.status === "candidate" && <button name="to" value="approved" className="btn btn-sm btn-primary" disabled={l.support < l.min_support}>Zatwierdź</button>}
                      {l.status === "candidate" && <button name="to" value="rejected" className="btn btn-sm">Odrzuć</button>}
                      {l.status === "approved" && <button name="to" value="retired" className="btn btn-sm">Wycofaj</button>}
                    </ActionForm>) : fmtDate(l.decided_at)}</td>
                </tr>))}
              </tbody></table>
          )}
        </Card>

        <Card title="Przeglądy transakcji">
          {reviews.length === 0 ? <Empty>Przeglądy pojawiają się automatycznie po zamknięciu transakcji.</Empty> : (
            <form>
              <div className="overflow-x-auto -mx-5 mb-5">
                <table className="tbl"><thead><tr><th></th><th>Data</th><th>Agent</th><th>Transakcja</th><th className="text-right">R</th><th>Proces</th><th>Teza</th><th>Kandydat na wniosek</th><th>Tagi</th></tr></thead>
                  <tbody>{reviews.map((r) => (
                    <tr key={r.id}><td><input type="checkbox" name="review_ids" value={r.id} /></td><td className="whitespace-nowrap text-muted">{fmtDate(r.created_at)}</td><td>{r.code}</td>
                      <td><Link className="link" href={`/trades/${r.trade_id}`}>{r.symbol}</Link></td><td className="text-right">{r.r_multiple !== null ? fmtSigned(r.r_multiple) : "—"}</td>
                      <td>{r.process_quality ?? "—"}/5</td><td>{r.thesis_held === null ? "?" : r.thesis_held ? "tak" : "nie"}</td>
                      <td className="text-sm max-w-md">{r.lesson_candidate ?? <span className="text-muted">—</span>}</td><td>{r.tags.map((t) => <Badge key={t}>{t}</Badge>)}</td></tr>))}
                  </tbody></table>
              </div>
              <input type="hidden" name="_back" value={back} />
              <input type="hidden" name="strategy_id" value={strategyId} />
              <div className="grid md:grid-cols-[2fr_1fr_auto] gap-3 items-end">
                <Field label="Nowy kandydat na wniosek (z zaznaczonych przeglądów)"><input name="body" placeholder="Ogólna, sprawdzalna reguła" className="input w-full" /></Field>
                <Field label="Tagi"><input name="tags" className="input w-full" /></Field>
                <button formAction={createLesson} className="btn btn-primary">Utwórz kandydata</button>
              </div>
              {candidates.length > 0 && (
                <div className="flex gap-3 items-end mt-3">
                  <Field label="…lub dołącz zaznaczone do kandydata"><select name="id" className="input">{candidates.map((c) => <option key={c.id} value={c.id}>{c.body.slice(0, 80)}</option>)}</select></Field>
                  <button formAction={addSupport} className="btn">Dołącz</button>
                </div>
              )}
            </form>
          )}
        </Card>
      </div>
    );
  }

  async function Sessions({ strategyId, back, sinceReview }: { strategyId: string; back: string; sinceReview: number }) {
    const sessions = await sql<{ id: string; period_start: Date; period_end: Date; trades_count: number; metrics: { expectancy_r: number | null; net_pnl: number | null }; decisions_md: string; created_at: Date }[]>`
      select * from review_sessions where strategy_id = ${strategyId} order by created_at desc`;
    const [last] = sessions;
    const daysSince = last ? (Date.now() - new Date(last.created_at).getTime()) / 86_400_000 : Infinity;
    const due = sinceReview >= 30 && daysSince >= 30;
    return (
      <div className="space-y-4">
        <Card title="Nowy przegląd okresowy">
          <p className={`text-sm mb-3 ${due ? "text-good" : "text-muted"}`}>
            {due ? "Czas na przegląd: " : "Zasada: przegląd co 30 zamkniętych transakcji, nie częściej niż raz w miesiącu. Teraz: "}
            {sinceReview} transakcji od ostatniego przeglądu{last ? `, ${Math.floor(daysSince)} dni temu` : ""}.
          </p>
          <ActionForm action={saveReviewSession} back={back} className="space-y-3">
            <input type="hidden" name="strategy_id" value={strategyId} />
            <Field label="Decyzje z przeglądu (zatwierdzone wnioski, nowa wersja strategii, pauza, nic)"><textarea name="decisions_md" required rows={4} className="input w-full" /></Field>
            <button className="btn btn-primary" disabled={sinceReview === 0}>Zapisz przegląd</button>
          </ActionForm>
        </Card>
        <Card title="Historia" bodyClass="">
          {sessions.length === 0 ? <Empty>Brak przeglądów.</Empty> : (
            <table className="tbl"><thead><tr><th>Data</th><th>Okres</th><th>Transakcje</th><th>E[R]</th><th>Wynik</th><th>Decyzje</th></tr></thead>
              <tbody>{sessions.map((s) => (
                <tr key={s.id}><td>{fmtDate(s.created_at)}</td><td className="text-xs">{fmtDate(s.period_start)} – {fmtDate(s.period_end)}</td><td>{s.trades_count}</td>
                  <td>{fmtNum(s.metrics.expectancy_r, 3)}</td><td>{fmtSigned(s.metrics.net_pnl)}</td><td className="text-sm whitespace-pre-wrap max-w-xl">{s.decisions_md}</td></tr>))}
              </tbody></table>
          )}
        </Card>
      </div>
    );
  }

  async function Commitments({ back }: { back: string }) {
    const rows = await sql<{ id: string; key: string; label: string; value: string; rationale: string; created_at: Date; effective_from: Date }[]>`
      select * from commitments order by key, effective_from desc, created_at desc`;
    const current = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (r.effective_from <= new Date() && !current.has(r.key)) current.set(r.key, r);
    const pendingFor = (key: string) => rows.find((r) => r.key === key && r.effective_from > new Date());
    return (
      <div className="space-y-4">
        <Card title="Twoje zobowiązania">
          <p className="text-sm text-muted mb-4">Spisane teraz, zanim pojawią się wyniki. Zmiana wymaga uzasadnienia i wchodzi w życie dopiero po 7 dniach — to bramka ryzyka dla Ciebie, nie dla agenta.</p>
          <div className="grid lg:grid-cols-2 gap-4">
            {Object.entries(COMMITMENT_KEYS).filter(([k]) => k !== "other").map(([key, label]) => {
              const cur = current.get(key);
              const pend = pendingFor(key);
              return (
                <div key={key} className="border border-line rounded-lg p-4">
                  <div className="text-xs text-muted">{label}</div>
                  <div className="text-base mt-1 mb-2">{cur?.value ?? <span className="text-warn">nie spisane</span>}</div>
                  {cur && <div className="text-xs text-muted mb-2">od {fmtDate(cur.effective_from)}</div>}
                  {pend && <div className="text-xs text-warn mb-2">Zaplanowana zmiana od {fmtDate(pend.effective_from)}: „{pend.value}” — {pend.rationale}</div>}
                  <details open={!cur}>
                    <summary className="text-xs link cursor-pointer">{cur ? "zaproponuj zmianę" : "spisz"}</summary>
                    <ActionForm action={saveCommitment} back={back} className="space-y-2 mt-2">
                      <input type="hidden" name="key" value={key} /><input type="hidden" name="label" value={label} />
                      {cur && <input type="hidden" name="supersedes_id" value={pend?.id ?? cur.id} />}
                      <textarea name="value" required rows={2} className="input w-full" placeholder={key === "max_real_capital" ? "np. 2000 zł, bez dopłat" : key === "project_end_condition" ? "np. jeśli po 4 miesiącach demo żadna strategia nie spełni kryteriów, kończę" : ""} />
                      {cur && <textarea name="rationale" required minLength={10} rows={2} className="input w-full" placeholder="Uzasadnienie zmiany (min. 10 znaków)" />}
                      <button className="btn btn-sm btn-primary">{cur ? "Zaplanuj zmianę" : "Zapisz"}</button>
                    </ActionForm>
                  </details>
                </div>
              );
            })}
          </div>
        </Card>
        <Card title="Historia zobowiązań" bodyClass="">
          {rows.length === 0 ? <Empty>Brak.</Empty> : (
            <table className="tbl"><thead><tr><th>Zobowiązanie</th><th>Treść</th><th>Uzasadnienie</th><th>Obowiązuje od</th></tr></thead>
              <tbody>{rows.map((r) => <tr key={r.id}><td>{r.label}</td><td>{r.value}</td><td className="text-sm text-muted">{r.rationale || "—"}</td><td>{fmtDate(r.effective_from)}</td></tr>)}</tbody></table>
          )}
        </Card>
      </div>
    );
  }
}
