import Link from "next/link";
import { db } from "@/lib/db";
import { fmtDate, fmtNum } from "@/lib/format";
import { ActionForm, Badge, Card, Empty, Field, Flash, PageHeader, StatusBadge, Tabs } from "@/components/ui";
import { addIdea, addJournalEntry, decideIdea } from "../actions/journal";

export const dynamic = "force-dynamic";

const KINDS: Record<string, string> = { note: "notatka", observation: "obserwacja", idea: "pomysł", decision: "decyzja", urge_to_intervene: "chęć ingerencji" };

export default async function JournalPage({ searchParams }: { searchParams: Promise<{ tab?: string; msg?: string; err?: string }> }) {
  const sp = await searchParams;
  const tab = sp.tab ?? "journal";
  const back = `/journal?tab=${tab}`;
  const sql = db();
  const tabs = [
    { key: "journal", label: "Dziennik", href: "/journal?tab=journal" },
    { key: "overrides", label: "Moje interwencje", href: "/journal?tab=overrides" },
    { key: "ideas", label: "Pomysły na strategie", href: "/journal?tab=ideas" },
  ];
  return (
    <>
      <PageHeader title="Dziennik tradera" subtitle="Dane o Tobie, nie o agentach: notatki, chęci ingerencji, faktyczne interwencje i kolejka pomysłów. Z Telegrama: /note, /urge." />
      <Flash msg={sp.msg} err={sp.err} />
      <Tabs items={tabs} current={tab} />
      {tab === "journal" && <Journal />}
      {tab === "overrides" && <Overrides />}
      {tab === "ideas" && <Ideas />}
    </>
  );

  async function Journal() {
    const [entries, agents, [urges]] = await Promise.all([
      sql<{ id: string; created_at: Date; kind: string; body: string; mood: number | null; via: string; code: string | null }[]>`
        select j.*, a.code from journal_entries j left join agents a on a.id = j.agent_id order by j.created_at desc limit 200`,
      sql<{ id: string; code: string }[]>`select id, code from agents where status in ('active','paused') order by code`,
      sql<{ urges: number; overrides: number }[]>`
        select (select count(*)::int from journal_entries where kind = 'urge_to_intervene' and created_at > now() - interval '30 days') as urges,
               (select count(*)::int from manual_overrides where created_at > now() - interval '30 days' and kind not in ('change_criteria','change_commitment')) as overrides`,
    ]);
    return (
      <div className="space-y-4">
        <Card title="Nowy wpis">
          <ActionForm action={addJournalEntry} back={back} className="grid md:grid-cols-[1fr_1fr_120px_auto] gap-3 items-end">
            <Field label="Typ"><select name="kind" className="input w-full">{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Agent (opcjonalnie)"><select name="agent_id" className="input w-full"><option value="">—</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.code}</option>)}</select></Field>
            <Field label="Nastrój 1–5"><input name="mood" className="input w-full" inputMode="numeric" /></Field>
            <div />
            <div className="md:col-span-3"><Field label="Treść"><textarea name="body" required rows={2} className="input w-full" /></Field></div>
            <button className="btn btn-primary">Dodaj</button>
          </ActionForm>
          <p className="text-xs text-muted mt-3">Ostatnie 30 dni: {urges?.urges ?? 0} razy chciałeś zainterweniować, {urges?.overrides ?? 0} razy faktycznie to zrobiłeś.</p>
        </Card>
        <Card bodyClass="">
          {entries.length === 0 ? <Empty>Brak wpisów.</Empty> : (
            <table className="tbl"><thead><tr><th>Data</th><th>Typ</th><th>Agent</th><th>Nastrój</th><th>Treść</th><th>Źródło</th></tr></thead>
              <tbody>{entries.map((e) => (
                <tr key={e.id}><td className="whitespace-nowrap text-muted">{fmtDate(e.created_at)}</td>
                  <td><Badge tone={e.kind === "urge_to_intervene" ? "warn" : "muted"}>{KINDS[e.kind]}</Badge></td><td>{e.code ?? "—"}</td><td>{e.mood ?? "—"}</td>
                  <td className="whitespace-pre-wrap text-sm">{e.body}</td><td className="text-xs">{e.via}</td></tr>))}
              </tbody></table>
          )}
        </Card>
      </div>
    );
  }

  async function Overrides() {
    const rows = await sql<{ id: string; created_at: Date; kind: string; reason: string; equity_at: number | null; code: string | null; agent_id: string | null; trade_id: string | null; via: string }[]>`
      select o.*, a.code from manual_overrides o left join agents a on a.id = o.agent_id order by o.created_at desc limit 300`;
    return (
      <Card bodyClass="">
        {rows.length === 0 ? <Empty>Brak interwencji. Dobrze.</Empty> : (
          <table className="tbl"><thead><tr><th>Data</th><th>Rodzaj</th><th>Agent</th><th>Powód</th><th className="text-right">Equity w chwili</th><th>Źródło</th></tr></thead>
            <tbody>{rows.map((o) => (
              <tr key={o.id}><td className="whitespace-nowrap text-muted">{fmtDate(o.created_at)}</td><td><StatusBadge status="warn" label={o.kind} /></td>
                <td>{o.agent_id ? <Link className="link" href={`/agents/${o.agent_id}`}>{o.code}</Link> : "—"}{o.trade_id && <> · <Link className="link" href={`/trades/${o.trade_id}`}>pozycja</Link></>}</td>
                <td className="text-sm">{o.reason}</td><td className="text-right">{fmtNum(o.equity_at)}</td><td className="text-xs">{o.via}</td></tr>))}
            </tbody></table>
        )}
      </Card>
    );
  }

  async function Ideas() {
    const ideas = await sql<{ id: string; created_at: Date; title: string; body: string; source: string; status: string; decided_at: Date | null }[]>`
      select * from strategy_ideas order by case status when 'queued' then 0 else 1 end, created_at desc`;
    const [[testing]] = await Promise.all([sql<{ n: number }[]>`select count(distinct v.strategy_id)::int as n from agents a join strategy_versions v on v.id = a.strategy_version_id where a.status in ('active','paused')`]);
    return (
      <div className="space-y-4">
        <Card title="Nowy pomysł">
          <p className="text-sm text-muted mb-3">Pomysły czekają w kolejce. Zasada: nowa strategia wchodzi do testu dopiero, gdy obecna przejdzie albo odpadnie według swoich kryteriów. Teraz w teście: {testing?.n ?? 0}.</p>
          <ActionForm action={addIdea} back={back} className="grid md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
            <Field label="Tytuł"><input name="title" required className="input w-full" /></Field>
            <Field label="Źródło"><input name="source" className="input w-full" placeholder="skąd pomysł" /></Field>
            <div />
            <div className="md:col-span-2"><Field label="Opis"><textarea name="body" rows={2} className="input w-full" /></Field></div>
            <button className="btn btn-primary">Dodaj</button>
          </ActionForm>
        </Card>
        <Card bodyClass="">
          {ideas.length === 0 ? <Empty>Kolejka pusta.</Empty> : (
            <table className="tbl"><thead><tr><th>Dodany</th><th>Pomysł</th><th>Źródło</th><th>Status</th><th></th></tr></thead>
              <tbody>{ideas.map((i) => (
                <tr key={i.id}><td className="text-muted whitespace-nowrap">{fmtDate(i.created_at)}</td><td><div className="font-medium">{i.title}</div><div className="text-sm text-muted whitespace-pre-wrap">{i.body}</div></td>
                  <td className="text-sm">{i.source || "—"}</td><td><StatusBadge status={i.status === "queued" ? "pending" : i.status === "promoted" ? "ok" : "archived"} label={i.status} /></td>
                  <td>{i.status === "queued" && (
                    <ActionForm action={decideIdea} back={back} className="flex gap-1"><input type="hidden" name="id" value={i.id} />
                      <button name="to" value="promoted" className="btn btn-sm">Do realizacji</button><button name="to" value="dropped" className="btn btn-sm">Odrzuć</button></ActionForm>)}</td></tr>))}
              </tbody></table>
          )}
        </Card>
      </div>
    );
  }
}
