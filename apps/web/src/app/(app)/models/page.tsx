import { db } from "@/lib/db";
import { ago, fmtNum } from "@/lib/format";
import { ActionForm, Card, Empty, Field, Flash, PageHeader, StatusBadge } from "@/components/ui";
import { saveModel, saveProvider, setProviderKey, testProvider } from "../actions/models";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  anthropic: "Anthropic (oficjalne API)", minimax: "MiniMax (API zgodne z Anthropic)",
  openrouter: "OpenRouter (API zgodne z OpenAI)", openai_compatible: "Inne API zgodne z OpenAI",
};

export default async function ModelsPage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const sp = await searchParams;
  const sql = db();
  const [providers, models, usage] = await Promise.all([
    sql<{ id: string; name: string; kind: string; base_url: string | null; enabled: boolean; status: string; last_tested_at: Date | null; last_error: string | null; last4: string | null }[]>`
      select p.id, p.name, p.kind, p.base_url, p.enabled, p.status, p.last_tested_at, p.last_error, s.last4
      from llm_providers p left join secrets s on s.id = p.api_key_secret_id order by p.created_at`,
    sql<{ id: string; provider_id: string; provider: string; model_key: string; display_name: string; input_usd_per_mtok: number; output_usd_per_mtok: number;
      cache_read_usd_per_mtok: number; cache_write_usd_per_mtok: number; max_output_tokens: number; enabled: boolean }[]>`
      select m.*, p.name as provider from llm_models m join llm_providers p on p.id = m.provider_id order by p.created_at, m.display_name`,
    sql<{ model_id: string; calls: number; cost: number; avg_latency: number; errors: number }[]>`
      select model_id, count(*)::int as calls, coalesce(sum(cost_usd),0) as cost, avg(latency_ms)::int as avg_latency,
             count(*) filter (where status <> 'ok')::int as errors
      from llm_calls where started_at > now() - interval '30 days' group by model_id`,
  ]);
  const usageBy = new Map(usage.map((u) => [u.model_id, u]));

  return (
    <>
      <PageHeader title="Modele AI" subtitle="Dostawcy, klucze API i modele dostępne dla agentów. Klucze są szyfrowane — panel może je zapisać, ale nie odczytać." />
      <Flash msg={sp.msg} err={sp.err} />

      <div className="grid lg:grid-cols-2 gap-4 mb-6">
        {providers.map((p) => (
          <Card key={p.id} title={<span className="flex items-center gap-2">{p.name} <StatusBadge status={p.enabled ? p.status : "disabled"} label={p.enabled ? p.status : "wyłączony"} /></span>}
            actions={p.last4 ? <ActionForm action={testProvider} back="/models"><input type="hidden" name="id" value={p.id} /><button className="btn btn-sm">Testuj</button></ActionForm> : null}>
            <div className="text-xs text-muted mb-3">{KIND_LABEL[p.kind]} · {p.base_url ?? "domyślny adres"} · test: {ago(p.last_tested_at)}</div>
            {p.last_error && <div className="text-xs text-bad mb-3 break-words">{p.last_error}</div>}
            <ActionForm action={setProviderKey} back="/models" className="flex gap-2 mb-4">
              <input type="hidden" name="id" value={p.id} />
              <input name="api_key" type="password" autoComplete="off" required placeholder={p.last4 ? `zapisany klucz •••• ${p.last4} — wpisz nowy, aby zmienić` : "wklej klucz API"} className="input flex-1" />
              <button className="btn btn-primary">Zapisz klucz</button>
            </ActionForm>
            <details>
              <summary className="text-xs text-muted cursor-pointer">Ustawienia dostawcy</summary>
              <ActionForm action={saveProvider} back="/models" className="grid grid-cols-2 gap-3 mt-3">
                <input type="hidden" name="id" value={p.id} />
                <Field label="Nazwa"><input name="name" defaultValue={p.name} className="input w-full" required /></Field>
                <Field label="Typ"><select name="kind" defaultValue={p.kind} className="input w-full">{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="Adres API"><input name="base_url" defaultValue={p.base_url ?? ""} className="input w-full" /></Field>
                <label className="flex items-center gap-2 text-sm mt-5"><input type="checkbox" name="enabled" defaultChecked={p.enabled} /> włączony</label>
                <button className="btn col-span-2">Zapisz</button>
              </ActionForm>
            </details>
          </Card>
        ))}
      </div>

      <Card title="Modele" bodyClass="">
        {models.length === 0 ? <Empty>Brak modeli.</Empty> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Model</th><th>Dostawca</th><th>ID w API</th><th className="text-right">Wejście $/1M</th><th className="text-right">Wyjście $/1M</th><th className="text-right">Cache odczyt/zapis</th>
                <th className="text-right">Maks. wyjście</th><th className="text-right">30 dni: wywołań / koszt / śr. czas / błędy</th><th></th></tr></thead>
              <tbody>
                {models.map((m) => {
                  const u = usageBy.get(m.id);
                  return (
                    <tr key={m.id}>
                      <td className={m.enabled ? "" : "text-muted"}>{m.display_name}{!m.enabled && " (wył.)"}</td>
                      <td>{m.provider}</td>
                      <td className="mono">{m.model_key}</td>
                      <td className="text-right">{fmtNum(m.input_usd_per_mtok)}</td>
                      <td className="text-right">{fmtNum(m.output_usd_per_mtok)}</td>
                      <td className="text-right">{fmtNum(m.cache_read_usd_per_mtok, 3)} / {fmtNum(m.cache_write_usd_per_mtok)}</td>
                      <td className="text-right">{m.max_output_tokens}</td>
                      <td className="text-right">{u ? `${u.calls} / $${fmtNum(u.cost)} / ${(u.avg_latency / 1000).toFixed(1)} s / ${u.errors}` : "—"}</td>
                      <td>
                        <details>
                          <summary className="text-xs link cursor-pointer">edytuj</summary>
                          <ModelForm providers={providers} m={m} />
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="p-5 border-t border-line">
          <div className="text-sm font-medium mb-3">Dodaj model</div>
          <ModelForm providers={providers} />
          <p className="text-xs text-muted mt-3">Ceny służą do liczenia kosztu każdego wywołania. Sprawdź je u dostawcy — wartości startowe wpisano według cenników z listopada 2026.</p>
        </div>
      </Card>

      <Card title="Dodaj dostawcę" className="mt-6">
        <ActionForm action={saveProvider} back="/models" className="grid md:grid-cols-4 gap-3 items-end">
          <Field label="Nazwa"><input name="name" required className="input w-full" placeholder="np. OpenAI" /></Field>
          <Field label="Typ"><select name="kind" className="input w-full">{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Adres API (HTTPS)"><input name="base_url" className="input w-full" placeholder="https://api.openai.com/v1" /></Field>
          <div className="flex items-center gap-3"><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked /> włączony</label><button className="btn btn-primary flex-1">Dodaj</button></div>
        </ActionForm>
      </Card>
    </>
  );
}

function ModelForm({ providers, m }: { providers: { id: string; name: string }[]; m?: { id: string; provider_id: string; model_key: string; display_name: string; input_usd_per_mtok: number; output_usd_per_mtok: number; cache_read_usd_per_mtok: number; cache_write_usd_per_mtok: number; max_output_tokens: number; enabled: boolean } }) {
  return (
    <ActionForm action={saveModel} back="/models" className="grid md:grid-cols-5 gap-3 items-end mt-3 min-w-[720px]">
      {m && <input type="hidden" name="id" value={m.id} />}
      <Field label="Dostawca"><select name="provider_id" defaultValue={m?.provider_id} className="input w-full">{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="ID w API"><input name="model_key" defaultValue={m?.model_key} required className="input w-full mono" /></Field>
      <Field label="Nazwa"><input name="display_name" defaultValue={m?.display_name} required className="input w-full" /></Field>
      <Field label="Wejście $/1M"><input name="input_usd_per_mtok" defaultValue={m?.input_usd_per_mtok} required className="input w-full" /></Field>
      <Field label="Wyjście $/1M"><input name="output_usd_per_mtok" defaultValue={m?.output_usd_per_mtok} required className="input w-full" /></Field>
      <Field label="Cache odczyt $/1M"><input name="cache_read_usd_per_mtok" defaultValue={m?.cache_read_usd_per_mtok ?? 0} required className="input w-full" /></Field>
      <Field label="Cache zapis $/1M"><input name="cache_write_usd_per_mtok" defaultValue={m?.cache_write_usd_per_mtok ?? 0} required className="input w-full" /></Field>
      <Field label="Maks. tokenów wyjścia"><input name="max_output_tokens" defaultValue={m?.max_output_tokens ?? 8192} required className="input w-full" /></Field>
      <label className="flex items-center gap-2 text-sm pb-2"><input type="checkbox" name="enabled" defaultChecked={m?.enabled ?? true} /> włączony</label>
      <button className="btn btn-primary">{m ? "Zapisz" : "Dodaj model"}</button>
    </ActionForm>
  );
}
