import "server-only";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "./auth";

/** Postgres errors raised by our triggers carry a readable message; surface it to the user. */
function humanError(err: unknown): string {
  const e = err as { message?: string; code?: string; constraint_name?: string; detail?: string };
  if (e.code === "23505") {
    const known: Record<string, string> = {
      agents_unique_triple: "Agent z tą samą wersją strategii, modelem i kontem już istnieje. Zmień model, wersję albo konto.",
      agents_code_key: "Agent o tym kodzie już istnieje.",
      strategies_code_key: "Strategia o tym kodzie już istnieje.",
      mt_accounts_server_login_key: "To konto (serwer + login) jest już dodane.",
      llm_providers_name_key: "Dostawca o tej nazwie już istnieje.",
      llm_models_provider_id_model_key_key: "Ten model jest już dodany u tego dostawcy.",
    };
    return (e.constraint_name && known[e.constraint_name]) ?? `Taki rekord już istnieje${e.constraint_name ? ` (${e.constraint_name})` : ""}.`;
  }
  if (e.code === "23514") return `Wartość narusza regułę ${e.constraint_name ?? ""}.`;
  if (e.code === "23503") return "Rekord jest powiązany z innymi danymi i nie może zostać zmieniony w ten sposób.";
  return e.message ?? "Nieznany błąd";
}

function safeBack(fd: FormData): string {
  const back = String(fd.get("_back") ?? "/");
  return back.startsWith("/") && !back.startsWith("//") ? back : "/";
}

function withParam(path: string, key: string, value: string): string {
  const [base, q = ""] = path.split("?");
  const params = new URLSearchParams(q);
  params.delete("msg"); params.delete("err");
  params.set(key, value);
  return `${base}?${params.toString()}`;
}

export class UserError extends Error {}

/**
 * Body of every server action: checks the session, runs `fn`, revalidates, and
 * redirects back with a success or error message. `fn` may return a custom target.
 * Server actions live in "use server" modules and call this helper.
 */
export async function runAction(
  fd: FormData,
  fn: () => Promise<string | { redirect: string; msg?: string } | void>,
): Promise<never> {
  await requireSession();
  const back = safeBack(fd);
  let target: string;
  try {
    const res = await fn();
    if (res && typeof res === "object") target = res.msg ? withParam(res.redirect, "msg", res.msg) : res.redirect;
    else target = withParam(back, "msg", res || "Zapisano.");
  } catch (err) {
    target = withParam(back, "err", humanError(err));
  }
  revalidatePath("/", "layout");
  redirect(target);
}

export function req(fd: FormData, key: string): string {
  const v = String(fd.get(key) ?? "").trim();
  if (!v) throw new UserError(`Pole „${key}” jest wymagane.`);
  return v;
}

export function opt(fd: FormData, key: string): string | null {
  const v = String(fd.get(key) ?? "").trim();
  return v ? v : null;
}

export function num(fd: FormData, key: string, { min, max, optional }: { min?: number; max?: number; optional?: boolean } = {}): number {
  const raw = String(fd.get(key) ?? "").trim().replace(",", ".");
  if (!raw) {
    if (optional) return NaN;
    throw new UserError(`Pole „${key}” jest wymagane.`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UserError(`Pole „${key}” musi być liczbą.`);
  if (min !== undefined && n < min) throw new UserError(`Pole „${key}” musi być ≥ ${min}.`);
  if (max !== undefined && n > max) throw new UserError(`Pole „${key}” musi być ≤ ${max}.`);
  return n;
}
