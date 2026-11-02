import { div, fromFixed, mul, toFixed, toMinor } from "./decimal";

function fixed(text: string): bigint {
  const negative = text.startsWith("-");
  const value = toFixed(negative ? text.slice(1) : text);
  if (value === null) throw new Error(`bad decimal ${text}`);
  return negative ? -value : value;
}

describe("toFixed", () => {
  it("scales a decimal string by 10^12", () => {
    expect(toFixed("172.5")).toBe(172500000000000n);
    expect(toFixed("0.000000000001")).toBe(1n);
    expect(toFixed("42")).toBe(42000000000000n);
    expect(toFixed(".5")).toBe(500000000000n);
  });

  it("rejects text that is not a decimal or has more than 12 fraction digits", () => {
    expect(toFixed("abc")).toBeNull();
    expect(toFixed("1.0000000000001")).toBeNull();
    expect(toFixed("")).toBeNull();
    expect(toFixed(".")).toBeNull();
    expect(toFixed("1,5")).toBeNull();
    expect(toFixed("-1")).toBeNull();
  });
});

describe("fromFixed", () => {
  it("writes the shortest decimal string", () => {
    expect(fromFixed(172500000000000n)).toBe("172.5");
    expect(fromFixed(0n)).toBe("0");
    expect(fromFixed(1n)).toBe("0.000000000001");
    expect(fromFixed(12000000000000n)).toBe("12");
  });

  it("keeps the sign of negative values", () => {
    expect(fromFixed(-172500000000000n)).toBe("-172.5");
    expect(fromFixed(-1n)).toBe("-0.000000000001");
  });
});

describe("mul", () => {
  it("multiplies two fixed values", () => {
    expect(mul(fixed("0.0425"), fixed("68120"))).toBe(fixed("2895.1"));
    expect(mul(fixed("-2"), fixed("1.5"))).toBe(fixed("-3"));
  });

  it("rounds half up at the 12th digit", () => {
    expect(mul(fixed("0.000000000001"), fixed("0.5"))).toBe(1n);
    expect(mul(fixed("0.000000000001"), fixed("0.4"))).toBe(0n);
    expect(mul(fixed("-0.000000000001"), fixed("0.5"))).toBe(-1n);
  });
});

describe("div", () => {
  it("divides two fixed values and rounds half up at the 12th digit", () => {
    // 2895.1 / 1.0846 = 2669.278996865203|76...
    expect(div(fixed("2895.1"), fixed("1.0846"))).toBe(fixed("2669.278996865204"));
    // 2 / 3 = 0.666666666666|67
    expect(div(fixed("2"), fixed("3"))).toBe(fixed("0.666666666667"));
    // 10^-10 / 8 = 0.0000000000125 rounds up to 0.000000000013
    expect(div(fixed("0.0000000001"), fixed("8"))).toBe(fixed("0.000000000013"));
    expect(div(fixed("-2"), fixed("3"))).toBe(fixed("-0.666666666667"));
  });
});

describe("toMinor", () => {
  it("rounds half up to the minor units of a currency", () => {
    expect(toMinor(fixed("2669.285"), 2)).toBe(266929);
    expect(toMinor(fixed("2669.284"), 2)).toBe(266928);
    expect(toMinor(fixed("1234.5"), 0)).toBe(1235);
    expect(toMinor(fixed("-2669.285"), 2)).toBe(-266929);
  });
});
