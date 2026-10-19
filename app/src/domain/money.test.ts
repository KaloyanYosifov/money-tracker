import { evaluateExpression, formatAmount, minorUnits, parseAmount } from "./money";

describe("parseAmount", () => {
  it("parses a dot decimal into minor units", () => {
    expect(parseAmount("12.34", "EUR")).toBe(1234);
  });

  it("uses the locale decimal separator", () => {
    expect(parseAmount("12,34", "EUR", "bg-BG")).toBe(1234);
  });

  it("rejects zero, negative and non-numeric input", () => {
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("-5")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
  });

  it("rejects values above 1000000000000 minor units", () => {
    expect(parseAmount("10000000000", "EUR")).toBe(1000000000000);
    expect(parseAmount("10000000000.01", "EUR")).toBeNull();
  });
});

describe("formatAmount", () => {
  it("formats minor units with the currency", () => {
    expect(formatAmount(9243471, "EUR", "en-IE")).toBe("€92,434.71");
  });

  it("adds a plus sign when signed", () => {
    expect(formatAmount(9243471, "EUR", "en-IE", { signed: true })).toBe("+€92,434.71");
  });
});

describe("minorUnits", () => {
  it("returns the fraction digits of the currency", () => {
    expect(minorUnits("JPY")).toBe(0);
    expect(minorUnits("EUR")).toBe(2);
  });
});

describe("evaluateExpression", () => {
  it("uses normal operator precedence", () => {
    expect(evaluateExpression("12.50+3*2")).toBe(1850);
  });

  it("returns null for a division by zero", () => {
    expect(evaluateExpression("5/0")).toBeNull();
  });
});
