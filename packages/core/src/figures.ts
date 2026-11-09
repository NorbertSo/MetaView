/** Parses economic figures like "3.2%", "-0.4K", "1.25M", "205K" into value + unit (no unit scaling). */
export function parseFigure(raw: string | number | null | undefined): { value: number | null; unit: string | null } {
  if (raw === null || raw === undefined || raw === "") return { value: null, unit: null };
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw, unit: null } : { value: null, unit: null };
  const m = raw.trim().replace(",", ".").match(/^([-+]?\d+(?:\.\d+)?)\s*([%KMBT]?)$/i);
  if (!m) return { value: null, unit: null };
  return { value: Number(m[1]), unit: m[2] ? m[2].toUpperCase() : null };
}
