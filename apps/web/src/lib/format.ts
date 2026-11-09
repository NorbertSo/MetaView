const tz = "Europe/Warsaw";

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("pl-PL", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtMoney(n: number | null | undefined, ccy?: string | null): string {
  if (n === null || n === undefined) return "—";
  return `${fmtNum(n, 2)}${ccy ? ` ${ccy}` : ""}`;
}

export function fmtSigned(n: number | null | undefined, digits = 2, suffix = ""): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${n > 0 ? "+" : ""}${fmtNum(n, digits)}${suffix}`;
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  return n === null || n === undefined ? "—" : `${fmtNum(n, digits)}%`;
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("pl-PL", { timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("pl-PL", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function ago(d: Date | string | null | undefined): string {
  if (!d) return "nigdy";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s} s temu`;
  if (s < 3600) return `${Math.round(s / 60)} min temu`;
  if (s < 86400) return `${Math.round(s / 3600)} h temu`;
  return `${Math.round(s / 86400)} dni temu`;
}

export function pnlClass(n: number | null | undefined): string {
  if (!n) return "";
  return n > 0 ? "text-good" : "text-bad";
}
