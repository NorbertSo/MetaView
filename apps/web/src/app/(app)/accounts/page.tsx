import { db } from "@/lib/db";
import { ago, fmtDate, fmtMoney, fmtNum } from "@/lib/format";
import { ActionForm, Card, Empty, Field, Flash, KV, PageHeader, StatusBadge } from "@/components/ui";
import { addAccount, archiveAccount, redeployAccount, resolveIssue, setMetaApiToken } from "../actions/accounts";
import { enqueueCommand } from "../actions/control";

export const dynamic = "force-dynamic";

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const sp = await searchParams;
  const sql = db();
  const [[token], accounts, issues] = await Promise.all([
    sql<{ last4: string; created_at: Date; rotated_at: Date | null }[]>`select last4, created_at, rotated_at from secrets where name = 'metaapi_token'`,
    sql<{ id: string; name: string; login: string; server: string; platform: string; account_type: string; status: string; last_error: string | null;
      metaapi_account_id: string | null; currency: string | null; leverage: number | null; margin_mode: string | null; created_at: Date;
      balance: number | null; equity: number | null; margin: number | null; free_margin: number | null; snap_at: Date | null;
      beat_at: Date | null; latency_ms: number | null; beat_error: string | null; instruments: number; uptime: number | null }[]>`
      select m.*, s.balance, s.equity, s.margin, s.free_margin, s.taken_at as snap_at, h.checked_at as beat_at, h.latency_ms, h.error as beat_error,
             (select count(*)::int from instruments i where i.broker_server = m.server) as instruments,
             (select avg(case when broker_connected then 1.0 else 0 end) from connection_heartbeats where mt_account_id = m.id and checked_at > now() - interval '24 hours') as uptime
      from mt_accounts m
      left join lateral (select * from account_snapshots where mt_account_id = m.id order by taken_at desc limit 1) s on true
      left join lateral (select * from connection_heartbeats where mt_account_id = m.id order by checked_at desc limit 1) h on true
      where m.status <> 'archived' order by m.created_at`,
    sql<{ id: string; detected_at: Date; kind: string; position_id: string | null; details: unknown; account: string }[]>`
      select r.id, r.detected_at, r.kind, r.position_id, r.details, m.name as account
      from reconciliation_issues r join mt_accounts m on m.id = r.mt_account_id where r.resolved_at is null order by r.detected_at desc`,
  ]);

  return (
    <>
      <PageHeader title="Konta MT" subtitle="Połączenie z brokerem przez MetaApi. Terminal MT5 działa w chmurze MetaApi — nie potrzebujesz Windowsa ani włączonego komputera." />
      <Flash msg={sp.msg} err={sp.err} />

      <div className="grid lg:grid-cols-2 gap-4 mb-6">
        <Card title="Token MetaApi">
          <p className="text-sm text-muted mb-3">
            {token ? <>Zapisany: •••• {token.last4} (od {fmtDate(token.rotated_at ?? token.created_at)}).</> : "Brak tokenu."} Token wygenerujesz w app.metaapi.cloud → API access.
          </p>
          <ActionForm action={setMetaApiToken} back="/accounts" className="flex gap-2">
            <input name="token" type="password" autoComplete="off" required placeholder="wklej token" className="input flex-1" />
            <button className="btn btn-primary">Zapisz</button>
          </ActionForm>
        </Card>

        <Card title="Dodaj konto demo">
          <ActionForm action={addAccount} back="/accounts" className="grid grid-cols-2 gap-3">
            <Field label="Nazwa"><input name="name" required placeholder="Admirals demo 1" className="input w-full" /></Field>
            <Field label="Platforma"><select name="platform" className="input w-full"><option value="mt5">MT5</option><option value="mt4">MT4</option></select></Field>
            <Field label="Login (numer konta)"><input name="login" required inputMode="numeric" className="input w-full" /></Field>
            <Field label="Serwer" hint="dokładnie jak w MT5, np. z okna logowania"><input name="server" required placeholder="AdmiralsGroup-Demo" className="input w-full" /></Field>
            <Field label="Hasło główne (nie inwestorskie)" hint="Użyte jednorazowo do utworzenia konta w MetaApi. Nie jest przechowywane w bazie.">
              <input name="password" type="password" autoComplete="off" required className="input w-full" />
            </Field>
            <div className="flex items-end"><button className="btn btn-primary w-full">Dodaj i połącz</button></div>
          </ActionForm>
        </Card>
      </div>

      {accounts.length === 0 ? <Card><Empty>Brak kont.</Empty></Card> : accounts.map((a) => (
        <Card key={a.id} className="mb-4"
          title={<span className="flex items-center gap-2">{a.name} <StatusBadge status={a.status} /> {a.account_type === "real" ? <StatusBadge status="critical" label="REALNE — handel zablokowany" /> : <StatusBadge status="info" label="demo" />}</span>}
          actions={<>
            <ActionForm action={enqueueCommand} back="/accounts"><input type="hidden" name="kind" value="refresh_account" /><input type="hidden" name="p_mt_account_id" value={a.id} /><button className="btn btn-sm">Odśwież</button></ActionForm>
            <ActionForm action={enqueueCommand} back="/accounts"><input type="hidden" name="kind" value="undeploy_account" /><input type="hidden" name="p_mt_account_id" value={a.id} /><button className="btn btn-sm">Odłącz</button></ActionForm>
            <ActionForm action={archiveAccount} back="/accounts"><input type="hidden" name="id" value={a.id} /><button className="btn btn-sm">Archiwizuj</button></ActionForm>
          </>}>
          <div className="grid lg:grid-cols-3 gap-6">
            <KV items={[
              ["Login / serwer", `${a.login} · ${a.server}`],
              ["Platforma", a.platform.toUpperCase()],
              ["MetaApi ID", <span key="m" className="mono">{a.metaapi_account_id ?? "—"}</span>],
              ["Waluta / dźwignia", `${a.currency ?? "—"} · ${a.leverage ? `1:${a.leverage}` : "—"}`],
              ["Tryb", a.margin_mode === "ACCOUNT_MARGIN_MODE_RETAIL_HEDGING" ? "hedging (wymagany przy wielu agentach)" : a.margin_mode ?? "—"],
            ]} />
            <KV items={[
              ["Balance", fmtMoney(a.balance, a.currency)],
              ["Equity", fmtMoney(a.equity, a.currency)],
              ["Margin / wolny", `${fmtNum(a.margin)} / ${fmtNum(a.free_margin)}`],
              ["Stan z", ago(a.snap_at)],
            ]} />
            <KV items={[
              ["Ostatni heartbeat", `${ago(a.beat_at)}${a.latency_ms !== null ? ` · ${a.latency_ms} ms` : ""}`],
              ["Dostępność 24h", a.uptime !== null ? `${fmtNum(a.uptime * 100, 1)}%` : "—"],
              ["Instrumenty w bazie", a.instruments],
              ["Błąd", <span key="e" className="text-bad break-words">{a.last_error ?? a.beat_error ?? "—"}</span>],
            ]} />
          </div>
          {a.margin_mode && a.margin_mode !== "ACCOUNT_MARGIN_MODE_RETAIL_HEDGING" && (
            <p className="text-sm text-warn mt-4">Konto nie jest w trybie hedging. Przy kilku agentach na tym koncie pozycje na tym samym instrumencie zostałyby połączone (netting). Użyj osobnego konta na każdego agenta albo konta hedging.</p>
          )}
          <div className="grid md:grid-cols-2 gap-4 mt-5">
            <ActionForm action={enqueueCommand} back="/accounts" className="flex gap-2">
              <input type="hidden" name="kind" value="sync_instruments" /><input type="hidden" name="p_mt_account_id" value={a.id} />
              <input name="p_symbols" placeholder="symbole, np. EURUSD GBPUSD XAUUSD (puste = wszystkie)" className="input flex-1" />
              <button className="btn">Pobierz specyfikacje</button>
            </ActionForm>
            {(a.status === "error" || a.status === "undeployed" || a.status === "disconnected") && (
              <ActionForm action={redeployAccount} back="/accounts" className="flex gap-2">
                <input type="hidden" name="id" value={a.id} />
                {!a.metaapi_account_id && <input name="password" type="password" required placeholder="hasło główne" className="input flex-1" />}
                <button className="btn btn-primary">Połącz ponownie</button>
              </ActionForm>
            )}
          </div>
        </Card>
      ))}

      <Card title="Rozbieżności z brokerem (nierozwiązane)" bodyClass="" className="mt-6">
        {issues.length === 0 ? <Empty>Brak — wszystkie pozycje na kontach należą do agentów i zgadzają się z bazą.</Empty> : (
          <table className="tbl">
            <thead><tr><th>Wykryto</th><th>Konto</th><th>Rodzaj</th><th>Pozycja</th><th>Szczegóły</th><th>Rozwiąż</th></tr></thead>
            <tbody>{issues.map((i) => (
              <tr key={i.id}><td>{fmtDate(i.detected_at)}</td><td>{i.account}</td><td><StatusBadge status="warn" label={i.kind} /></td>
                <td className="mono">{i.position_id ?? "—"}</td><td className="mono break-all">{JSON.stringify(i.details)}</td>
                <td><ActionForm action={resolveIssue} back="/accounts" className="flex gap-2"><input type="hidden" name="id" value={i.id} />
                  <input name="resolution" required placeholder="co zrobiono" className="input input-sm w-40" /><button className="btn btn-sm">OK</button></ActionForm></td></tr>))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
