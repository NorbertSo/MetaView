"use server";
import { db } from "@/lib/db";
import { opt, req, runAction, UserError } from "@/lib/action";

export async function addJournalEntry(fd: FormData) {
  return runAction(fd, async () => {
    const kind = req(fd, "kind");
    if (!["observation", "idea", "decision", "urge_to_intervene", "note"].includes(kind)) throw new UserError("Nieprawidłowy typ wpisu.");
    const moodRaw = opt(fd, "mood");
    const mood = moodRaw ? Number(moodRaw) : null;
    if (mood !== null && !(mood >= 1 && mood <= 5)) throw new UserError("Nastrój: 1–5.");
    await db()`insert into journal_entries (kind, body, mood, agent_id) values (${kind}, ${req(fd, "body")}, ${mood}, ${opt(fd, "agent_id")})`;
    return kind === "urge_to_intervene" ? "Zapisane. Nic nie zostało zmienione — i o to chodzi." : "Wpis dodany.";
  });
}

export async function addIdea(fd: FormData) {
  return runAction(fd, async () => {
    await db()`insert into strategy_ideas (title, body, source) values (${req(fd, "title")}, ${opt(fd, "body") ?? ""}, ${opt(fd, "source") ?? ""})`;
    return "Pomysł dodany do kolejki.";
  });
}

export async function decideIdea(fd: FormData) {
  return runAction(fd, async () => {
    const to = req(fd, "to");
    if (!["promoted", "dropped"].includes(to)) throw new UserError("Nieprawidłowa decyzja.");
    await db()`update strategy_ideas set status = ${to}, decided_at = now() where id = ${req(fd, "id")} and status = 'queued'`;
    return to === "promoted" ? "Pomysł przeniesiony do realizacji — utwórz dla niego strategię." : "Pomysł odrzucony.";
  });
}
