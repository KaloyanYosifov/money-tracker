// Fixed-point math for quantities, prices and rates: a bigint with the scale 10^12.

export const SCALE_DIGITS = 12;
export const SCALE = 10n ** BigInt(SCALE_DIGITS);

/** Divides and rounds half away from zero. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = (n * 2n + d) / (d * 2n);
  return negative ? -quotient : quotient;
}

/** Parses an unsigned decimal string with "." as the separator. Null if it has no digits or more than 12 fraction digits. */
export function toFixed(text: string): bigint | null {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || match[1] + (match[2] ?? "") === "") return null;
  const fraction = match[2] ?? "";
  if (fraction.length > SCALE_DIGITS) return null;
  return BigInt((match[1] || "0") + fraction.padEnd(SCALE_DIGITS, "0"));
}

export function fromFixed(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const digits = (value < 0n ? -value : value).toString().padStart(SCALE_DIGITS + 1, "0");
  const whole = digits.slice(0, -SCALE_DIGITS);
  const fraction = digits.slice(-SCALE_DIGITS).replace(/0+$/, "");
  return sign + whole + (fraction ? `.${fraction}` : "");
}

export function mul(a: bigint, b: bigint): bigint {
  return divRound(a * b, SCALE);
}

export function div(a: bigint, b: bigint): bigint {
  return divRound(a * SCALE, b);
}

/** Rounds to the minor units of a currency with the given number of fraction digits, for formatAmount. */
export function toMinor(value: bigint, digits: number): number {
  return Number(divRound(value, 10n ** BigInt(SCALE_DIGITS - digits)));
}
