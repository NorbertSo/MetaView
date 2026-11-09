import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getSettingValue } from "@/lib/queries";
import { ago, fmtDate } from "@/lib/format";
import { ActionForm, Badge, Card, Empty, Field, Flash, PageHeader, StatusBadge, Tabs } from "@/components/ui";
import { createIngestToken, revokeIngestToken, saveAnalyst, saveRiskGlobal, saveTelegram, toggleSource } from "../actions/settings";
import { enqueueCommand } from "../actions/control";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string; msg?: string; err?: string }> }) {
  const sp = await searchParams;
  const tab = sp.tab ?? "risk";
  const back = `/settings?tab=${tab}`;
  const sql = db();
  const tabs = [
    { key: "risk", label: "Ryzyko", href: "/settings?tab=risk" },
    { key: "analyst", label: "Analityk i raporty", href: "/settings?tab=analyst" },
    { key: "telegram", label: "Telegram", href: "/settings?tab=telegram" },
    { key: "sources", label: "Źródła danych i API", href: "/settings?tab=sources" },
    { key: "events", label: "Zdarzenia systemu", href: "/settings?tab=events" },
    { key: "commands", label: "Komendy", href: "/settings?tab=commands" },
  ];
  return (
    <>
      <PageHeader title="Ustawienia" />
      <Flash msg={sp.msg} err={sp.err} />
      <Tabs items={tabs} current={tab} />
      {tab === "risk" && <Risk />}
      {tab === "analyst" && <Analyst />}
      {tab === "telegram" && <Telegram />}
      {tab === "sources" && <Sources />}
      {tab === "events" && <Events />}
      {tab === "commands" && <Commands />}
    </>
  );

  async function Risk() {
    const r = await getSettingValue<{ max_account_open_risk_pct: number; max_currency_exposure_pct: number; min_rr: number; max_spread_multiple: number }>("risk_global");
    const b = await getSettingValue<{ minutes_before: number; minutes_after: number; importance: string[]; applies_to_styles: string[] }>("event_blackout");
    return (
      <Card title="Bramki ryzyka (wspólne dla wszystkich agentów)">
        <p className="text-sm text-muted mb-4">Sprawdzane w kodzie przed każdym zleceniem — model nie może ich obejść. Limity per agent (ryzyko na transakcję, dzienna strata, kill switch) ustawiasz przy agencie. Zawsze obowiązuje też: obowiązkowy SL, SL można tylko zacieśniać, konta realne są zablokowane.</p>
        <ActionForm action={saveRiskGlobal} back={back} className="grid md:grid-cols-4 gap-4">
          <Field label="Maks. łączne otwarte ryzyko konta (%)"><input name="max_account_open_risk_pct" defaultValue={r.max_account_open_risk_pct} className="input w-full" /></Field>
          <Field label="Maks. ekspozycja na jedną walutę (%)"><input name="max_currency_exposure_pct" defaultValue={r.max_currency_exposure_pct} className="input w-full" /></Field>
          <Field label="Min. stosunek zysk/ryzyko (gdy TP)"><input name="min_rr" defaultValue={r.min_rr} className="input w-full" /></Field>
          <Field label="Maks. spread (× mediana 7 dni)"><input name="max_spread_multiple" defaultValue={r.max_spread_multiple} className="input w-full" /></Field>
          <Field label="Blokada przed eventem (min)"><input name="minutes_before" defaultValue={b.minutes_before} className="input w-full" /></Field>
          <Field label="Blokada po evencie (min)"><input name="minutes_after" defaultValue={b.minutes_after} className="input w-full" /></Field>
          <div><span className="label">Waga eventów</span>{["medium", "high"].map((i) => <label key={i} className="flex items-center gap-2 text-sm"><input type="checkbox" name="importance" value={i} defaultChecked={b.importance.includes(i)} />{i}</label>)}</div>
          <div><span className="label">Dotyczy stylów</span>{["swing", "day", "event", "other"].map((s) => <label key={s} className="flex items-center gap-2 text-sm"><input type="checkbox" name="applies_to_styles" value={s} defaultChecked={b.applies_to_styles.includes(s)} />{s}</label>)}</div>
          <button className="btn btn-primary md:col-span-4">Zapisz</button>
        </ActionForm>
      </Card>
    );
  }

  async function Analyst() {
    const a = await getSettingValue<{ model_id: string | null; cron: string; valid_hours: number }>("analyst");
    const d = await getSettingValue<{ cron: string }>("daily_report");
    const models = await sql<{ id: string; label: string }[]>`select m.id, p.name || ' · ' || m.display_name as label from llm_models m join llm_providers p on p.id = m.provider_id where m.enabled order by 2`;
    return (
      <Card title="Analityk rynku i raport dzienny">
        <p className="text-sm text-muted mb-4">Analityk tworzy jeden wspólny raport (reżim rynku, banki centralne, kalendarz, bias per instrument) na podstawie kalendarza, newsów i COT z bazy. Agenci czytają najnowszy ważny raport. Raport dzienny trafia na Telegram.</p>
        <ActionForm action={saveAnalyst} back={back} className="grid md:grid-cols-4 gap-4">
          <Field label="Model analityka"><select name="model_id" defaultValue={a.model_id ?? ""} className="input w-full"><option value="">— wyłączony —</option>{models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></Field>
          <Field label="Harmonogram (cron UTC)" hint="domyślnie 6:15 i 12:15 w dni robocze"><input name="cron" defaultValue={a.cron} className="input w-full mono" /></Field>
          <Field label="Ważność raportu (h)"><input name="valid_hours" defaultValue={a.valid_hours} className="input w-full" /></Field>
          <Field label="Raport dzienny (cron UTC)"><input name="daily_cron" defaultValue={d.cron} className="input w-full mono" /></Field>
          <button className="btn btn-primary md:col-span-4">Zapisz</button>
        </ActionForm>
      </Card>
    );
  }

  async function Telegram() {
    const t = await getSettingValue<{ chat_id: string | number | null; notify_trades: boolean; notify_level: string }>("telegram");
    const [tok] = await sql<{ last4: string }[]>`select last4 from secrets where name = 'telegram_bot_token'`;
    return (
      <Card title="Powiadomienia Telegram" actions={<ActionForm action={enqueueCommand} back={back}><input type="hidden" name="kind" value="send_test_telegram" /><button className="btn btn-sm">Wyślij test</button></ActionForm>}>
        <p className="text-sm text-muted mb-4">Bot wysyła alarmy, otwarcia i zamknięcia pozycji oraz raport dzienny. Przyjmuje komendy /status, /note, /urge — tylko z podanego czatu. Token bota uzyskasz u @BotFather, chat ID np. u @userinfobot.</p>
        <ActionForm action={saveTelegram} back={back} className="grid md:grid-cols-4 gap-4">
          <Field label="Token bota"><input name="bot_token" type="password" autoComplete="off" placeholder={tok ? `zapisany •••• ${tok.last4}` : "123456:ABC…"} className="input w-full" /></Field>
          <Field label="Chat ID"><input name="chat_id" defaultValue={t.chat_id ?? ""} className="input w-full" /></Field>
          <Field label="Minimalny poziom alarmów"><select name="notify_level" defaultValue={t.notify_level} className="input w-full">{["info", "warn", "error", "critical"].map((l) => <option key={l}>{l}</option>)}</select></Field>
          <label className="flex items-center gap-2 text-sm mt-5"><input type="checkbox" name="notify_trades" defaultChecked={t.notify_trades} /> powiadamiaj o transakcjach</label>
          <button className="btn btn-primary md:col-span-4">Zapisz</button>
        </ActionForm>
      </Card>
    );
  }

  async function Sources() {
    const [sources, tokens, log] = await Promise.all([
      sql<{ id: string; code: string; name: string; kind: string; feeds: string[]; enabled: boolean; health: string; last_success_at: Date | null; last_error: string | null; expected_interval_minutes: number | null }[]>`
        select * from v_data_source_health order by kind, name`,
      sql<{ id: string; name: string; source: string; token_prefix: string; scopes: string[]; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }[]>`
        select t.*, s.name as source from ingest_tokens t join data_sources s on s.id = t.source_id order by t.created_at desc`,
      sql<{ id: number; received_at: Date; feed: string; status: string; accepted: number; rejected: number; error: string | null; source: string | null }[]>`
        select l.*, s.name as source from ingest_log l left join data_sources s on s.id = l.source_id order by received_at desc limit 30`,
    ]);
    const base = env().PUBLIC_URL;
    const newToken = (await cookies()).get("tv_new_token")?.value;
    return (
      <div className="space-y-4">
        <Card title="Źródła" bodyClass="">
          <table className="tbl"><thead><tr><th>Źródło</th><th>Rodzaj</th><th>Dane</th><th>Stan</th><th>Ostatnio</th><th>Błąd</th><th></th></tr></thead>
            <tbody>{sources.map((s) => (
              <tr key={s.id}><td>{s.name}<div className="text-xs mono text-muted">{s.code}</div></td><td>{s.kind}</td><td className="mono">{s.feeds.join(", ")}</td>
                <td><StatusBadge status={s.health} /></td><td>{ago(s.last_success_at)}</td><td className="text-xs text-bad max-w-xs break-words">{s.last_error ?? ""}</td>
                <td className="whitespace-nowrap">
                  <div className="flex gap-1">
                    {s.kind === "worker" && s.code !== "metaapi" && <ActionForm action={enqueueCommand} back={back}><input type="hidden" name="kind" value="fetch_source" /><input type="hidden" name="p_code" value={s.code} /><button className="btn btn-sm">Pobierz</button></ActionForm>}
                    <ActionForm action={toggleSource} back={back}><input type="hidden" name="id" value={s.id} /><button className="btn btn-sm">{s.enabled ? "Wyłącz" : "Włącz"}</button></ActionForm>
                  </div>
                </td></tr>))}
            </tbody></table>
        </Card>

        <Card title="API dla zewnętrznych źródeł (Apify, n8n, zaplanowane zadania Claude)">
          <p className="text-sm text-muted mb-3">Każde źródło dostaje własny token. Dane przechodzą walidację, a każdy rekord zapisuje się z oznaczeniem pochodzenia. Wysyłka ponownie z tym samym <span className="mono">Idempotency-Key</span> niczego nie zdubluje.</p>
          <pre className="mono text-xs bg-panel-2 border border-line rounded-lg p-3 overflow-auto mb-4">{`POST ${base}/api/ingest/news
Authorization: Bearer tvi_…
Idempotency-Key: apify-run-123            (opcjonalnie)
Content-Type: application/json

{ "items": [ { "source": "reuters", "source_item_id": "abc", "title": "…", "summary": "…",
  "url": "https://…", "published_at": "2026-11-10T08:00:00Z", "instruments": ["EURUSD"], "importance": 4 } ] }

POST ${base}/api/ingest/economic_events   { "items": [ { "source": "fmp", "source_event_id": "…", "scheduled_at": "…",
  "currency": "USD", "title": "CPI m/m", "importance": "high", "forecast": "0.3%", "previous": "0.2%", "actual": "0.4%" } ] }
POST ${base}/api/ingest/market_briefs     { "regime": "mixed", "summary_md": "…", "valid_hours": 12, "instruments": { "EURUSD": { "bias": "long", "confidence": 0.6, "notes": "…" } } }
POST ${base}/api/ingest/journal           { "kind": "note", "body": "…" }`}</pre>
          {newToken && <div className="mb-4 rounded-lg border border-good/40 bg-good/10 p-3"><div className="text-xs text-muted mb-1">Nowy token — skopiuj teraz, nie zostanie pokazany ponownie:</div><code className="mono text-sm break-all select-all">{newToken}</code></div>}
          <ActionForm action={createIngestToken} back={back} className="grid md:grid-cols-4 gap-3 items-end">
            <Field label="Nazwa tokenu"><input name="name" required placeholder="np. Apify newsy" className="input w-full" /></Field>
            <Field label="Źródło"><select name="source_id" className="input w-full">{sources.filter((s) => s.kind !== "worker").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <div><span className="label">Zakresy</span><div className="flex flex-wrap gap-3">{["news", "economic_events", "market_briefs", "journal"].map((s) => <label key={s} className="flex items-center gap-1 text-sm"><input type="checkbox" name="scopes" value={s} defaultChecked={s === "news"} />{s}</label>)}</div></div>
            <button className="btn btn-primary">Utwórz token</button>
          </ActionForm>
          {tokens.length > 0 && (
            <table className="tbl mt-4"><thead><tr><th>Nazwa</th><th>Źródło</th><th>Prefiks</th><th>Zakresy</th><th>Użyty</th><th>Status</th><th></th></tr></thead>
              <tbody>{tokens.map((t) => (
                <tr key={t.id}><td>{t.name}</td><td>{t.source}</td><td className="mono">{t.token_prefix}…</td><td>{t.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</td><td>{ago(t.last_used_at)}</td>
                  <td>{t.revoked_at ? <StatusBadge status="archived" label="unieważniony" /> : <StatusBadge status="active" label="aktywny" />}</td>
                  <td>{!t.revoked_at && <ActionForm action={revokeIngestToken} back={back}><input type="hidden" name="id" value={t.id} /><button className="btn btn-sm btn-danger">Unieważnij</button></ActionForm>}</td></tr>))}
              </tbody></table>
          )}
        </Card>

        <Card title="Ostatnie dostawy" bodyClass="">
          {log.length === 0 ? <Empty>Brak.</Empty> : (
            <table className="tbl"><thead><tr><th>Czas</th><th>Źródło</th><th>Dane</th><th>Status</th><th>Przyjęte / odrzucone</th><th>Błąd</th></tr></thead>
              <tbody>{log.map((l) => <tr key={l.id}><td>{fmtDate(l.received_at)}</td><td>{l.source}</td><td>{l.feed}</td><td><StatusBadge status={l.status === "ok" ? "ok" : l.status === "partial" ? "warn" : "error"} label={l.status} /></td><td>{l.accepted} / {l.rejected}</td><td className="text-xs text-bad max-w-md break-words">{l.error ?? ""}</td></tr>)}</tbody></table>
          )}
        </Card>
      </div>
    );
  }

  async function Events() {
    const rows = await sql<{ id: number; occurred_at: Date; level: string; source: string; kind: string; message: string }[]>`
      select id, occurred_at, level, source, kind, message from system_events order by occurred_at desc limit 200`;
    return (
      <Card bodyClass="">
        {rows.length === 0 ? <Empty>Brak zdarzeń.</Empty> : (
          <table className="tbl"><thead><tr><th>Czas</th><th>Poziom</th><th>Moduł</th><th>Rodzaj</th><th>Opis</th></tr></thead>
            <tbody>{rows.map((e) => <tr key={e.id}><td className="whitespace-nowrap text-muted">{fmtDate(e.occurred_at)}</td><td><StatusBadge status={e.level} /></td><td>{e.source}</td><td className="mono">{e.kind}</td><td className="text-sm break-words">{e.message}</td></tr>)}</tbody></table>
        )}
      </Card>
    );
  }

  async function Commands() {
    const rows = await sql<{ id: string; kind: string; status: string; created_at: Date; finished_at: Date | null; error: string | null; result: unknown }[]>`
      select id, kind, status, created_at, finished_at, error, result from commands order by created_at desc limit 100`;
    return (
      <Card bodyClass="">
        {rows.length === 0 ? <Empty>Brak komend.</Empty> : (
          <table className="tbl"><thead><tr><th>Zlecono</th><th>Komenda</th><th>Status</th><th>Zakończono</th><th>Wynik / błąd</th></tr></thead>
            <tbody>{rows.map((c) => <tr key={c.id}><td className="whitespace-nowrap text-muted">{fmtDate(c.created_at)}</td><td className="mono">{c.kind}</td><td><StatusBadge status={c.status} /></td><td>{fmtDate(c.finished_at)}</td>
              <td className="mono break-all max-w-xl">{c.error ? <span className="text-bad">{c.error}</span> : c.result ? JSON.stringify(c.result) : "—"}</td></tr>)}</tbody></table>
        )}
      </Card>
    );
  }
}
