import { amountInputText, currencySymbol, formatAmount, minorUnits, parseAmount, parseSignedAmount } from "./money";

describe("parseAmount", () => {
  it("parses a dot decimal into minor units", () => {
    expect(parseAmount("12.34", "EUR")).toBe(1234);
  });

  it("uses the locale decimal separator", () => {
    expect(parseAmount("12,34", "EUR", "bg-BG")).toBe(1234);
    // The number pad shows the separator of the device region, so both work.
    expect(parseAmount("12,34", "EUR", "en-IE")).toBe(1234);
    expect(parseAmount("12.34", "EUR", "bg-BG")).toBe(1234);
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

describe("parseSignedAmount", () => {
  it("parses positive and negative amounts", () => {
    expect(parseSignedAmount("12.50", "EUR")).toBe(1250);
    expect(parseSignedAmount("-12.50", "EUR")).toBe(-1250);
    expect(parseSignedAmount("-12,50", "EUR", "de")).toBe(-1250);
  });

  it("returns 0 for empty text and zero", () => {
    expect(parseSignedAmount("", "EUR")).toBe(0);
    expect(parseSignedAmount("0", "EUR")).toBe(0);
    expect(parseSignedAmount("-0", "EUR")).toBe(0);
  });

  it("rejects text that is not an amount", () => {
    expect(parseSignedAmount("abc", "EUR")).toBeNull();
    expect(parseSignedAmount("1.234", "EUR")).toBeNull();
    expect(parseSignedAmount("-", "EUR")).toBeNull();
  });

  it("rejects values above 1000000000000 minor units", () => {
    expect(parseSignedAmount("10000000000.01", "EUR")).toBeNull();
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

describe("amountInputText", () => {
  it("writes minor units with the locale's decimal separator", () => {
    expect(amountInputText(1499, "EUR", "en-IE")).toBe("14.99");
    expect(amountInputText(1499, "EUR", "de-DE")).toBe("14,99");
    expect(amountInputText(500, "JPY", "en-IE")).toBe("500");
  });

  it("gives text that parseAmount reads back", () => {
    expect(parseAmount(amountInputText(4250, "EUR", "de-DE"), "EUR", "de-DE")).toBe(4250);
  });
});

describe("currencySymbol", () => {
  it("returns the symbol of the currency", () => {
    expect(currencySymbol("EUR", "en-IE")).toBe("€");
    expect(currencySymbol("USD", "en-US")).toBe("$");
  });
});
