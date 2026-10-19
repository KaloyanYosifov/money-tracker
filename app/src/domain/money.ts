export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

const MAX_BIG = BigInt(MAX_AMOUNT_MINOR);

export function minorUnits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;
}

function decimalSeparator(locale?: string): string {
  const part = new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === "decimal");
  return part?.value ?? ".";
}

// Converts an unsigned decimal string with "." as the separator to minor units.
// Returns null if the string has more fraction digits than the currency allows.
function decimalToMinor(text: string, digits: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > digits) return null;
  return BigInt(match[1] + fraction.padEnd(digits, "0"));
}

export function parseAmount(text: string, currency = "EUR", locale?: string): number | null {
  const separator = decimalSeparator(locale);
  const normalized = text.replace(/\s/g, "").split(separator).join(".");
  const minor = decimalToMinor(normalized, minorUnits(currency));
  if (minor === null || minor <= 0n || minor > MAX_BIG) return null;
  return Number(minor);
}

export function formatAmount(
  minor: number,
  currency: string,
  locale?: string,
  options: { signed?: boolean } = {},
): string {
  const digits = minorUnits(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    signDisplay: options.signed ? "exceptZero" : "auto",
  }).format(minor / 10 ** digits);
}

// Divides and rounds half away from zero.
function divRound(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (2n * n + d) / (2n * d);
  return negative ? -q : q;
}

// Evaluates a keypad expression with + - * / and normal precedence.
// Operands and the result are in minor units of the currency.
export function evaluateExpression(expression: string, currency = "EUR"): number | null {
  const digits = minorUnits(currency);
  const scale = 10n ** BigInt(digits);
  const tokens = expression.replace(/\s/g, "").match(/\d+(?:\.\d+)?|[-+*/]|./g) ?? [];
  if (tokens.length === 0 || tokens.length % 2 === 0) return null;

  const terms: bigint[] = [];
  const signs: bigint[] = [1n];
  let current: bigint | null = null;
  let operator = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (i % 2 === 0) {
      const value = decimalToMinor(token, digits);
      if (value === null) return null;
      if (current === null) {
        current = value;
      } else if (operator === "*") {
        current = divRound(current * value, scale);
      } else {
        if (value === 0n) return null;
        current = divRound(current * scale, value);
      }
    } else if (token === "*" || token === "/") {
      operator = token;
    } else if (token === "+" || token === "-") {
      terms.push(current as bigint);
      signs.push(token === "+" ? 1n : -1n);
      current = null;
    } else {
      return null;
    }
  }
  terms.push(current as bigint);

  const result = terms.reduce((sum, term, i) => sum + signs[i] * term, 0n);
  if (result > MAX_BIG || result < -MAX_BIG) return null;
  return Number(result);
}
