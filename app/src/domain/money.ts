export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

const MAX_BIG = BigInt(MAX_AMOUNT_MINOR);

export function minorUnits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;
}

function decimalSeparator(locale?: string): string {
  const format = new Intl.NumberFormat(locale);
  // Hermes on iOS has no NumberFormat.formatToParts. Without it, read the character between the 1s of "1.1".
  if (typeof format.formatToParts !== "function") {
    return /1(\D)1/.exec(format.format(1.1))?.[1] ?? ".";
  }
  const part = format.formatToParts(1.1).find((p) => p.type === "decimal");
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
  // The number pad shows the separator of the device region, so accept "," and "." either way.
  const normalized = text.replace(/\s/g, "").split(separator).join(".").replace(/,/g, ".");
  const minor = decimalToMinor(normalized, minorUnits(currency));
  if (minor === null || minor <= 0n || minor > MAX_BIG) return null;
  return Number(minor);
}

/** Like parseAmount, but also accepts 0, a leading "-" and empty text (0). */
export function parseSignedAmount(text: string, currency = "EUR", locale?: string): number | null {
  let rest = text.trim();
  if (rest === "") return 0;
  const negative = rest.startsWith("-");
  if (negative) rest = rest.slice(1);
  const separator = decimalSeparator(locale);
  const normalized = rest.replace(/\s/g, "").split(separator).join(".").replace(/,/g, ".");
  const minor = decimalToMinor(normalized, minorUnits(currency));
  if (minor === null || minor > MAX_BIG) return null;
  if (minor === 0n) return 0;
  return negative ? -Number(minor) : Number(minor);
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

/** Minor units as text for an amount field, with the locale's decimal separator: 1499 EUR as "14.99" or "14,99". */
export function amountInputText(minor: number, currency: string, locale?: string): string {
  const digits = minorUnits(currency);
  const text = (minor / 10 ** digits).toFixed(digits);
  return digits === 0 ? text : text.replace(".", decimalSeparator(locale));
}

/** The currency symbol, for example "€" for EUR. */
export function currencySymbol(currency: string, locale?: string): string {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency });
  // Hermes on iOS has no NumberFormat.formatToParts. Without it, remove the number ("0.00") from "€0.00".
  if (typeof format.formatToParts !== "function") {
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    const number = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(0);
    return format.format(0).replace(number, "").trim() || currency;
  }
  const part = format.formatToParts(0).find((p) => p.type === "currency");
  return part?.value ?? currency;
}
