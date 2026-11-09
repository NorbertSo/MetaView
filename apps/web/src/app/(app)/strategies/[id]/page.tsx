import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { ActionForm, Card, Empty, Field, Flash, KV, PageHeader, StatusBadge } from "@/components/ui";
import { approveVersion, deleteDraftVersion, saveCriteria, saveVersion, updateStrategy } from "../../actions/strategies";

export const dynamic = "force-dynamic";

const DEFAULT_PARAMS = `{
  "candles": { "1h": 120, "4h": 120, "1d": 90 },
  "news_hours": 24,
  "events_hours_ahead": 72
}`;

export default async function StrategyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string; edit?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const sql = db();
  const [[s], versions, criteria, agents] = await Promise.all([
    sql<{ id: string; code: string; name: string; style: string; status: string; description: string }[]>`select * from strategies where id = ${id}`,
    sql<{ id: string; version: number; rules_md: string; system_prompt: string; params: unknown; timeframes: string[]; instruments: string[]; content_hash: string; change_note: string; created_at: Date; approved_at: Date | null }[]>`
      select * from strategy_versions where strategy_id = ${id} order by version desc`,
    sql<{ id: string; min_period_days: number; min_trades: number; min_expectancy_r: number; max_drawdown_pct: number; min_profit_factor: number; max_brier: number | null; notes: string; rationale: string; created_at: Date; effective_from: Date }[]>`
      select * from success_criteria where strategy_id = ${id} order by effective_from desc, created_at desc`,
    sql<{ id: string; code: string; name: string; status: string; version: number; model: string }[]>`
      select a.id, a.code, a.name, a.status, v.version, m.display_name as model from agents a
      join strategy_versions v on v.id = a.strategy_version_id join llm_models m on m.id = a.model_id where v.strategy_id = ${id} order by a.created_at`,
  ]);
  if (!s) notFound();
  const back = `/strategies/${id}`;
  const draft = versions.find((v) => !v.approved_at);
  const editing = sp.edit ? versions.find((v) => v.id === sp.edit && !v.approved_at) : undefined;
  const base = editing ?? draft ?? versions[0];
  const current = criteria.find((c) => c.effective_from <= new Date());
  const pending = criteria.filter((c) => c.effective_from > new Date());

  return (
    <>
      <PageHeader title={`${s.code} — ${s.name}`} subtitle={s.description || undefined}
        actions={<Link href={`/agents/new?strategy=${s.id}`} className="btn">Nowy agent na tej strategii</Link>} />
      <Flash msg={sp.msg} err={sp.err} />

      <div className="grid lg:grid-cols-3 gap-4 mb-6">
        <Card title="Strategia">
          <ActionForm action={updateStrategy} back={back} className="space-y-3">
            <input type="hidden" name="id" value={s.id} />
            <Field label="Nazwa"><input name="name" defaultValue={s.name} className="input w-full" required /></Field>
            <Field label="Opis"><textarea name="description" defaultValue={s.description} rows={3} className="input w-full" /></Field>
            <Field label="Status"><select name="status" defaultValue={s.status} className="input w-full">
              <option value="draft">szkic</option><option value="active">aktywna</option><option value="paused">wstrzymana</option><option value="retired">wycofana</option></select></Field>
            <button className="btn w-full">Zapisz</button>
          </ActionForm>
        </Card>

        <Card title="Kryteria sukcesu" className="lg:col-span-2">
          {current ? (
            <div className="mb-4">
              <KV items={[
                ["Minimalny okres", `${current.min_period_days} dni`], ["Minimalna liczba transakcji", String(current.min_trades)],
                ["Wartość oczekiwana", `> ${current.min_expectancy_r} R (po kosztach)`], ["Maks. obsunięcie", `${current.max_drawdown_pct}%`],
                ["Profit factor", `≥ ${current.min_profit_factor}`], ["Kalibracja (Brier)", current.max_brier !== null ? `≤ ${current.max_brier}` : "nie dotyczy"],
                ["Obowiązuje od", fmtDate(current.effective_from)], ["Notatki", current.notes || "—"],
              ]} />
              {pending.map((p) => (
                <p key={p.id} className="text-sm text-warn mt-3">Zaplanowana zmiana od {fmtDate(p.effective_from)}: {p.min_trades} transakcji, DD ≤ {p.max_drawdown_pct}%, PF ≥ {p.min_profit_factor}. Uzasadnienie: {p.rationale}</p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-warn mb-4">Brak kryteriów. Spisz je teraz, zanim pojawią się pierwsze wyniki — potem zmiany wchodzą w życie dopiero po 7 dniach.</p>
          )}
          <details open={!current}>
            <summary className="text-sm link cursor-pointer mb-3">{current ? "Zaproponuj zmianę (wchodzi w życie po 7 dniach)" : "Spisz kryteria"}</summary>
            <ActionForm action={saveCriteria} back={back} className="grid md:grid-cols-3 gap-3">
              <input type="hidden" name="strategy_id" value={s.id} />
              {current && <input type="hidden" name="supersedes_id" value={pending[0]?.id ?? current.id} />}
              <Field label="Minimalny okres (dni)"><input name="min_period_days" defaultValue={current?.min_period_days ?? (s.style === "swing" ? 135 : s.style === "day" ? 75 : 90)} className="input w-full" required /></Field>
              <Field label="Min. liczba transakcji"><input name="min_trades" defaultValue={current?.min_trades ?? (s.style === "swing" ? 30 : 100)} className="input w-full" required /></Field>
              <Field label="Min. wartość oczekiwana (R)"><input name="min_expectancy_r" defaultValue={current?.min_expectancy_r ?? 0} className="input w-full" required /></Field>
              <Field label="Maks. obsunięcie (%)"><input name="max_drawdown_pct" defaultValue={current?.max_drawdown_pct ?? 20} className="input w-full" required /></Field>
              <Field label="Min. profit factor"><input name="min_profit_factor" defaultValue={current?.min_profit_factor ?? 1.2} className="input w-full" required /></Field>
              <Field label="Maks. Brier (puste = nie dotyczy)"><input name="max_brier" defaultValue={current?.max_brier ?? (s.style === "event" ? 0.25 : "")} className="input w-full" /></Field>
              <div className="md:col-span-3"><Field label="Notatki"><input name="notes" defaultValue={current?.notes ?? ""} className="input w-full" /></Field></div>
              {current && <div className="md:col-span-3"><Field label="Uzasadnienie zmiany (wymagane, min. 10 znaków)"><textarea name="rationale" required minLength={10} rows={2} className="input w-full" /></Field></div>}
              <button className="btn btn-primary md:col-span-3">{current ? "Zaplanuj zmianę" : "Zapisz i zablokuj"}</button>
            </ActionForm>
          </details>
        </Card>
      </div>

      <Card title="Wersje" bodyClass="" className="mb-6">
        {versions.length === 0 ? <Empty>Brak wersji — dodaj pierwszą poniżej.</Empty> : (
          <table className="tbl">
            <thead><tr><th>Wersja</th><th>Status</th><th>Instrumenty</th><th>Interwały</th><th>Zmiana</th><th>Hash</th><th>Utworzona</th><th></th></tr></thead>
            <tbody>{versions.map((v) => (
              <tr key={v.id}>
                <td className="font-medium">v{v.version}</td>
                <td>{v.approved_at ? <StatusBadge status="approved" label={`zatwierdzona ${fmtDate(v.approved_at)}`} /> : <StatusBadge status="draft" label="szkic" />}</td>
                <td className="mono">{v.instruments.join(" ")}</td><td className="mono">{v.timeframes.join(" ")}</td>
                <td className="max-w-xs">{v.change_note || "—"}</td><td className="mono">{v.content_hash.slice(0, 10)}</td><td className="text-muted">{fmtDate(v.created_at)}</td>
                <td className="whitespace-nowrap">
                  {!v.approved_at && <div className="flex gap-2">
                    <Link href={`${back}?edit=${v.id}#editor`} className="btn btn-sm">Edytuj</Link>
                    <ActionForm action={approveVersion} back={back} className="flex items-center gap-2">
                      <input type="hidden" name="version_id" value={v.id} />
                      <label className="text-xs flex items-center gap-1"><input type="checkbox" name="confirm" required />zamroź</label>
                      <button className="btn btn-sm btn-primary">Zatwierdź</button>
                    </ActionForm>
                    <ActionForm action={deleteDraftVersion} back={back}><input type="hidden" name="version_id" value={v.id} /><button className="btn btn-sm btn-danger">Usuń</button></ActionForm>
                  </div>}
                </td>
              </tr>))}
            </tbody>
          </table>
        )}
      </Card>

      <div id="editor" />
      <Card title={editing ? `Edycja szkicu v${editing.version}` : draft ? `Nowa wersja (istnieje szkic v${draft.version} — możesz go edytować)` : "Nowa wersja"}>
        <ActionForm action={saveVersion} back={back} className="space-y-4">
          <input type="hidden" name="strategy_id" value={s.id} />
          {editing && <input type="hidden" name="version_id" value={editing.id} />}
          <Field label="Reguły strategii (markdown) — wejście, wyjście, zarządzanie pozycją, kiedy NIE handlować">
            <textarea name="rules_md" required rows={16} defaultValue={base?.rules_md ?? ""} className="input w-full mono" />
          </Field>
          <Field label="Instrukcje dla modelu (styl rozumowania, priorytety, czego unikać)">
            <textarea name="system_prompt" required rows={6} defaultValue={base?.system_prompt ?? ""} className="input w-full mono" />
          </Field>
          <div className="grid md:grid-cols-3 gap-3">
            <Field label="Instrumenty (symbole brokera)" hint="np. EURUSD GBPUSD XAUUSD — dokładnie jak w MT5">
              <input name="instruments" required defaultValue={base?.instruments.join(" ") ?? ""} className="input w-full mono" />
            </Field>
            <Field label="Interwały świec" hint="1m 5m 15m 30m 1h 4h 1d 1w">
              <input name="timeframes" defaultValue={base?.timeframes.join(" ") ?? "1h 4h 1d"} className="input w-full mono" />
            </Field>
            <Field label="Opis zmiany"><input name="change_note" defaultValue={editing?.change_note ?? ""} className="input w-full" /></Field>
          </div>
          <Field label="Parametry (JSON)" hint={<>candles: liczba świec na interwał; news_hours; events_hours_ahead; event_trigger_minutes_before (strategie eventowe, domyślnie 10).</>}>
            <textarea name="params" rows={6} defaultValue={base ? JSON.stringify(base.params, null, 2) : DEFAULT_PARAMS} className="input w-full mono" />
          </Field>
          <button className="btn btn-primary">{editing ? "Zapisz szkic" : "Utwórz szkic nowej wersji"}</button>
        </ActionForm>
      </Card>

      <Card title="Agenci na tej strategii" bodyClass="" className="mt-6">
        {agents.length === 0 ? <Empty>Brak.</Empty> : (
          <table className="tbl"><thead><tr><th>Agent</th><th>Wersja</th><th>Model</th><th>Status</th></tr></thead>
            <tbody>{agents.map((a) => (<tr key={a.id}><td><Link className="link" href={`/agents/${a.id}`}>{a.code}</Link> {a.name}</td><td>v{a.version}</td><td>{a.model}</td><td><StatusBadge status={a.status} /></td></tr>))}</tbody>
          </table>
        )}
      </Card>
    </>
  );
}
