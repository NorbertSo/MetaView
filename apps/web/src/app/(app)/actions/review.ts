"use server";
import { db } from "@/lib/db";
import { opt, req, runAction, UserError } from "@/lib/action";

export async function createLesson(fd: FormData) {
  return runAction(fd, async () => {
    const sql = db();
    const strategyId = req(fd, "strategy_id");
    const reviewIds = fd.getAll("review_ids").map(String).filter(Boolean);
    if (!reviewIds.length) throw new UserError("Zaznacz przeglądy transakcji, które wspierają ten wniosek.");
    const [check] = await sql<{ n: number }[]>`
      select count(*)::int as n from trade_reviews r join agents a on a.id = r.agent_id join strategy_versions v on v.id = a.strategy_version_id
      where r.id = any(${reviewIds}) and v.strategy_id = ${strategyId}`;
    if (check?.n !== reviewIds.length) throw new UserError("Wszystkie przeglądy muszą dotyczyć tej samej strategii.");
    const tags = (opt(fd, "tags") ?? "").split(/[\s,]+/).filter(Boolean);
    await sql`insert into lessons (strategy_id, body, tags, supporting_review_ids) values (${strategyId}, ${req(fd, "body")}, ${tags}, ${reviewIds})`;
    return "Kandydat na wniosek zapisany.";
  });
}

export async function decideLesson(fd: FormData) {
  return runAction(fd, async () => {
    const sql = db();
    const id = req(fd, "id");
    const to = req(fd, "to");
    if (!["approved", "rejected", "retired"].includes(to)) throw new UserError("Nieprawidłowa decyzja.");
    const [l] = await sql<{ support: number; min_support: number }[]>`select cardinality(supporting_review_ids) as support, min_support from lessons where id = ${id}`;
    if (!l) throw new UserError("Wniosek nie istnieje.");
    if (to === "approved" && l.support < l.min_support) {
      throw new UserError(`Za mało przypadków: ${l.support}/${l.min_support}. Dołącz kolejne przeglądy, zanim zatwierdzisz — inaczej agent „nauczy się” szumu.`);
    }
    await sql`update lessons set status = ${to}, decided_at = now(), decided_note = ${opt(fd, "note")} where id = ${id}`;
    return to === "approved" ? "Wniosek zatwierdzony — agenci tej strategii zobaczą go w kontekście." : "Zapisano decyzję.";
  });
}

export async function addSupport(fd: FormData) {
  return runAction(fd, async () => {
    const id = req(fd, "id");
    const reviewIds = fd.getAll("review_ids").map(String).filter(Boolean);
    if (!reviewIds.length) throw new UserError("Zaznacz przeglądy.");
    await db()`update lessons set supporting_review_ids = (select array_agg(distinct x) from unnest(supporting_review_ids || ${reviewIds}::uuid[]) x)
               where id = ${id} and status = 'candidate'`;
    return "Dołączono przypadki.";
  });
}

export async function saveReviewSession(fd: FormData) {
  return runAction(fd, async () => {
    const sql = db();
    const strategyId = req(fd, "strategy_id");
    const [stats] = await sql<{ n: number; first: Date | null; last: Date | null; exp: number | null; pnl: number | null }[]>`
      select count(*)::int as n, min(t.closed_at) as first, max(t.closed_at) as last, avg(t.r_multiple) as exp, sum(t.net_pnl) as pnl
      from trades t join agents a on a.id = t.agent_id join strategy_versions v on v.id = a.strategy_version_id
      where v.strategy_id = ${strategyId} and t.status = 'closed'
        and t.closed_at > coalesce((select max(period_end) from review_sessions where strategy_id = ${strategyId}), '-infinity')`;
    if (!stats?.n || !stats.first || !stats.last) throw new UserError("Brak nowych zamkniętych transakcji od ostatniego przeglądu.");
    const end = stats.last.getTime() > stats.first.getTime() ? stats.last : new Date(stats.first.getTime() + 1000);
    await sql`insert into review_sessions (strategy_id, period_start, period_end, trades_count, metrics, decisions_md)
              values (${strategyId}, ${stats.first}, ${end}, ${stats.n}, ${sql.json({ expectancy_r: stats.exp, net_pnl: stats.pnl } as never)}, ${req(fd, "decisions_md")})`;
    return "Przegląd zapisany.";
  });
}

export async function saveCommitment(fd: FormData) {
  return runAction(fd, async () => {
    const sql = db();
    const key = req(fd, "key");
    const supersedes = opt(fd, "supersedes_id");
    const value = req(fd, "value");
    const rationale = opt(fd, "rationale") ?? "";
    await sql.begin(async (tx) => {
      await tx`insert into commitments (key, label, value, rationale, supersedes_id) values (${key}, ${req(fd, "label")}, ${value}, ${rationale}, ${supersedes})`;
      if (supersedes) {
        await tx`insert into manual_overrides (kind, reason, details) values ('change_commitment', ${rationale || "zmiana zobowiązania"}, ${tx.json({ key, value } as never)})`;
      }
    });
    return supersedes ? "Zmiana zaplanowana — wejdzie w życie za 7 dni." : "Zobowiązanie zapisane.";
  });
}
