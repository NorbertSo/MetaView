/** Number of decimals needed to represent a step like 0.01 or 0.001. */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) throw new Error(`invalid step ${step}`);
  const s = step.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Floors `value` to a multiple of `step` without floating-point drift. */
export function floorToStep(value: number, step: number): number {
  const d = decimalsOf(step);
  const factor = 10 ** d;
  const v = Math.round(value * factor * 1e6) / 1e6; // absorb FP noise before flooring
  const stepI = Math.round(step * factor);
  const units = Math.floor(v / stepI);
  return Number(((units * stepI) / factor).toFixed(d));
}

/** Rounds a price to the instrument's digits. */
export function roundPrice(price: number, digits: number): number {
  return Number(price.toFixed(digits));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
