import Link from "next/link";
import { db } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { ActionForm, Card, Empty, Field, Flash, PageHeader, StatusBadge } from "@/components/ui";
import { createStrategy } from "../actions/strategies";

export const dynamic = "force-dynamic";

const STYLE: Record<string, string> = { swing: "swing", day: "day trading", event: "eventowa", other: "inna" };

export default async function StrategiesPage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const sp = await searchParams;
  const rows = await db()<{ id: string; code: string; name: string; style: string; status: string; created_at: Date; versions: number; approved: number | null; agents: number; has_criteria: boolean }[]>`
    select s.id, s.code, s.name, s.style, s.status, s.created_at,
           (select count(*)::int from strategy_versions v where v.strategy_id = s.id) as versions,
           (select max(version) from strategy_versions v where v.strategy_id = s.id and approved_at is not null) as approved,
           (select count(*)::int from agents a join strategy_versions v on v.id = a.strategy_version_id where v.strategy_id = s.id and a.status in ('active','paused')) as agents,
           exists (select 1 from success_criteria c where c.strategy_id = s.id) as has_criteria
    from strategies s order by s.created_at`;
  return (
    <>
      <PageHeader title="Strategie" subtitle="Reguły w wersjach. Zatwierdzona wersja jest zamrożona — agenci i decyzje zawsze wskazują dokładnie tę wersję, na której działały." />
      <Flash msg={sp.msg} err={sp.err} />
      <Card bodyClass="" className="mb-6">
        {rows.length === 0 ? <Empty>Brak strategii.</Empty> : (
          <table className="tbl">
            <thead><tr><th>Kod</th><th>Nazwa</th><th>Styl</th><th>Status</th><th>Wersje</th><th>Zatwierdzona</th><th>Agenci</th><th>Kryteria</th><th>Utworzona</th></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id}>
                <td><Link href={`/strategies/${s.id}`} className="link font-medium">{s.code}</Link></td>
                <td>{s.name}</td><td>{STYLE[s.style]}</td><td><StatusBadge status={s.status} /></td>
                <td>{s.versions}</td><td>{s.approved ? `v${s.approved}` : "—"}</td><td>{s.agents}</td>
                <td>{s.has_criteria ? <StatusBadge status="ok" label="spisane" /> : <StatusBadge status="warn" label="brak" />}</td>
                <td className="text-muted">{fmtDate(s.created_at)}</td>
              </tr>))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Nowa strategia">
        <ActionForm action={createStrategy} back="/strategies" className="grid md:grid-cols-4 gap-3 items-end">
          <Field label="Kod (2–8 znaków)"><input name="code" required pattern="[A-Za-z0-9]{2,8}" placeholder="EVT1" className="input w-full uppercase" /></Field>
          <Field label="Nazwa"><input name="name" required className="input w-full" /></Field>
          <Field label="Styl"><select name="style" className="input w-full">{Object.entries(STYLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <button className="btn btn-primary">Utwórz</button>
          <div className="md:col-span-4"><Field label="Opis"><textarea name="description" rows={2} className="input w-full" /></Field></div>
        </ActionForm>
      </Card>
    </>
  );
}
