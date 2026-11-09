import Link from "next/link";
import { db } from "@/lib/db";
import { ActionForm, Card, Empty, Field, Flash, PageHeader } from "@/components/ui";
import { createAgent } from "../../actions/agents";

export const dynamic = "force-dynamic";

export default async function NewAgentPage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string; strategy?: string; from?: string }> }) {
  const sp = await searchParams;
  const sql = db();
  const [versions, models, accounts, [next], [from]] = await Promise.all([
    sql<{ id: string; label: string; instruments: string[]; style: string; strategy_id: string }[]>`
      select v.id, s.code || ' v' || v.version || ' — ' || s.name as label, v.instruments, s.style, s.id as strategy_id
      from strategy_versions v join strategies s on s.id = v.strategy_id
      where v.approved_at is not null and s.status in ('active','draft') order by s.code, v.version desc`,
    sql<{ id: string; label: string; has_key: boolean }[]>`
      select m.id, p.name || ' · ' || m.display_name as label, p.api_key_secret_id is not null as has_key
      from llm_models m join llm_providers p on p.id = m.provider_id where m.enabled and p.enabled order by p.name, m.display_name`,
    sql<{ id: string; label: string; margin_mode: string | null }[]>`
      select id, name || ' (' || login || ', ' || status || ')' as label, margin_mode from mt_accounts where status not in ('archived') order by created_at`,
    sql<{ n: number }[]>`select count(*)::int + 1 as n from agents`,
    sp.from ? sql<{ strategy_version_id: string; model_id: string; mt_account_id: string; name: string; allocated_capital: number; risk_per_trade_pct: number; max_open_positions: number;
      max_daily_loss_pct: number; max_drawdown_pct: number; schedule_cron: string; instruments: string[]; temperature: number }[]>`select * from agents where id = ${sp.from}` : Promise.resolve([]),
  ]);

  const missing = [!versions.length && <li key="v">zatwierdzonej wersji strategii — <Link className="link" href="/strategies">Strategie</Link></li>,
    !models.length && <li key="m">włączonego modelu — <Link className="link" href="/models">Modele AI</Link></li>,
    !accounts.length && <li key="a">konta MT — <Link className="link" href="/accounts">Konta MT</Link></li>].filter(Boolean);

  const preVersion = from?.strategy_version_id ?? versions.find((v) => v.strategy_id === sp.strategy)?.id;

  return (
    <>
      <PageHeader title={from ? `Klon agenta: ${from.name}` : "Nowy agent"} subtitle="Ustawienia pieniędzy i trójka (wersja × model × konto) zostaną zamrożone po aktywacji. Aby zmienić model lub wersję, sklonuj agenta." />
      <Flash msg={sp.msg} err={sp.err} />
      {missing.length > 0 ? (
        <Card><Empty><p className="mb-2">Aby utworzyć agenta, potrzebujesz:</p><ul className="space-y-1">{missing}</ul></Empty></Card>
      ) : (
        <Card>
          <ActionForm action={createAgent} back="/agents/new" className="grid md:grid-cols-3 gap-4">
            <Field label="Kod (3–6 znaków, w ID zleceń)"><input name="code" required defaultValue={`A${String(next?.n ?? 1).padStart(2, "0")}`} className="input w-full uppercase mono" /></Field>
            <Field label="Nazwa"><input name="name" required defaultValue={from ? `${from.name} (klon)` : ""} placeholder="np. Eventy · Sonnet" className="input w-full" /></Field>
            <div />
            <Field label="Wersja strategii"><select name="strategy_version_id" defaultValue={preVersion} className="input w-full">{versions.map((v) => <option key={v.id} value={v.id}>{v.label} [{v.instruments.join(" ")}]</option>)}</select></Field>
            <Field label="Model AI"><select name="model_id" defaultValue={from?.model_id} className="input w-full">{models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.has_key ? "" : " (brak klucza)"}</option>)}</select></Field>
            <Field label="Konto"><select name="mt_account_id" defaultValue={from?.mt_account_id} className="input w-full">{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></Field>

            <Field label="Przydzielony kapitał (wirtualny)" hint="Agent liczy ryzyko i wynik od tej kwoty, niezależnie od innych agentów na koncie.">
              <input name="allocated_capital" required defaultValue={from?.allocated_capital ?? 10000} className="input w-full" /></Field>
            <Field label="Ryzyko na transakcję (%)"><input name="risk_per_trade_pct" required defaultValue={from?.risk_per_trade_pct ?? 1} className="input w-full" /></Field>
            <Field label="Maks. otwartych pozycji"><input name="max_open_positions" required defaultValue={from?.max_open_positions ?? 3} className="input w-full" /></Field>
            <Field label="Dzienny limit straty (%)" hint="Po przekroczeniu: brak nowych wejść do końca dnia UTC."><input name="max_daily_loss_pct" required defaultValue={from?.max_daily_loss_pct ?? 3} className="input w-full" /></Field>
            <Field label="Kill switch — maks. obsunięcie (%)" hint="Po przekroczeniu: agent zatrzymany na stałe, pozycje zamknięte."><input name="max_drawdown_pct" required defaultValue={from?.max_drawdown_pct ?? 20} className="input w-full" /></Field>
            <Field label="Temperatura modelu (0–1)"><input name="temperature" required defaultValue={from?.temperature ?? 0.2} className="input w-full" /></Field>

            <Field label="Harmonogram (cron, UTC)" hint="np. */15 7-20 * * 1-5 (co 15 min w dni robocze 7–20 UTC). Min. odstęp 5 min. Strategie eventowe są też uruchamiane przed eventami.">
              <input name="schedule_cron" required defaultValue={from?.schedule_cron ?? "*/30 7-20 * * 1-5"} className="input w-full mono" /></Field>
            <div className="md:col-span-2"><Field label="Instrumenty (puste = wszystkie z wersji strategii)"><input name="instruments" defaultValue={from?.instruments.join(" ") ?? ""} className="input w-full mono" /></Field></div>

            <label className="flex items-center gap-2 text-sm md:col-span-2"><input type="checkbox" name="activate" /> Aktywuj od razu (inaczej zostanie szkicem)</label>
            <button className="btn btn-primary">Utwórz agenta</button>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
