import type { CriteriaVerdict } from "@tv/core";
import { Badge } from "./ui";

export function VerdictBadge({ v }: { v: CriteriaVerdict | null }) {
  if (!v) return <Badge tone="muted">brak kryteriów</Badge>;
  if (v.verdict === "passed") return <Badge tone="good">spełnia kryteria</Badge>;
  if (v.verdict === "failed") return <Badge tone="bad">nie spełnia</Badge>;
  return <Badge tone="warn">w trakcie</Badge>;
}

export function VerdictTable({ v }: { v: CriteriaVerdict }) {
  return (
    <table className="tbl">
      <thead><tr><th>Kryterium</th><th>Wynik</th><th>Wymagane</th><th>Stan</th></tr></thead>
      <tbody>
        {v.checks.map((c) => (
          <tr key={c.key}>
            <td>{c.label}</td><td className="mono">{c.actual}</td><td className="mono">{c.required}</td>
            <td><Badge tone={c.state === "pass" ? "good" : c.state === "fail" ? "bad" : "warn"}>
              {c.state === "pass" ? "spełnione" : c.state === "fail" ? "niespełnione" : "czeka na próbkę"}</Badge></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
