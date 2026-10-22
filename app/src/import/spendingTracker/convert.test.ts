import { categoryIconKeys } from "../../ui/icons/categoryIcons";
import { PALETTE } from "../../ui/palette";
import { cleanName, colorFor, ICON_KEYS, iconFor, importId, sameName, splitNote, ticksToDate, toMinor } from "./convert";

const USER = "7d1f3a52-1c7e-4c43-9a55-2f0f6a1b9e10";
const OTHER_USER = "9e2a4b63-2d8f-4d54-8b66-3a1a7b2caf21";
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("ticksToDate", () => {
  it("converts .NET ticks to a UTC date", () => {
    expect(ticksToDate(638408736000000000)).toBe("2024-01-15");
    expect(ticksToDate(638763840000000000)).toBe("2025-03-01");
  });

  it("keeps the date at 23:59:59", () => {
    expect(ticksToDate(638408736000000000n + 86399n * 10000000n)).toBe("2024-01-15");
  });
});

describe("toMinor", () => {
  it("rounds the absolute amount to minor units", () => {
    expect(toMinor(12.3399999, "EUR")).toBe(1234);
    expect(toMinor(-50, "EUR")).toBe(5000);
    expect(toMinor(0.004, "EUR")).toBe(0);
  });
});

describe("importId", () => {
  it("is a stable UUID version 5 for each kind and ID", () => {
    expect(importId("transaction", 101, USER)).toBe(importId("transaction", 101, USER));
    expect(importId("transaction", 101, USER)).not.toBe(importId("account", 101, USER));
    expect(importId("transaction", 101, USER)).toMatch(UUID_V5);
    expect(importId("transaction", 101, USER)).not.toBe(importId("transaction", 101, OTHER_USER));
  });
});

describe("iconFor", () => {
  it("maps Spending Tracker icons, with tag as the fallback", () => {
    expect(iconFor("80-shopping-cart")).toBe("cart");
    expect(iconFor("48-fork-and-knife")).toBe("fork");
    expect(iconFor("unknown-icon")).toBe("tag");
  });

  it("uses only icon keys of the app", () => {
    for (const key of ICON_KEYS) expect(categoryIconKeys).toContain(key);
  });
});

describe("colorFor", () => {
  it("adds # to a hex colour, else uses the palette", () => {
    expect(colorFor("AABBCC", 3)).toBe("#AABBCC");
    expect(colorFor("", 3)).toBe(PALETTE[3 % PALETTE.length].hex);
    expect(colorFor(null, 3)).toBe(PALETTE[3 % PALETTE.length].hex);
    expect(colorFor("zz", 0)).toBe(PALETTE[0].hex);
  });
});

describe("splitNote", () => {
  it("uses a short note as the name", () => {
    expect(splitNote("  Coffee beans ")).toEqual({ name: "Coffee beans", note: null });
  });

  it("keeps a long note as the note", () => {
    const text = "x".repeat(127);
    expect(splitNote(` ${text} `)).toEqual({ name: "x".repeat(120), note: text });
  });

  it("uses the first line of a note with more lines as the name", () => {
    expect(splitNote(" Groceries \n milk, eggs\n")).toEqual({ name: "Groceries", note: "Groceries \n milk, eggs" });
    expect(splitNote("\n\nSecond line first")).toEqual({ name: "Second line first", note: null });
  });

  it("does not cut a character in two", () => {
    const text = `${"x".repeat(119)}\u{1F600}yz`;
    expect(splitNote(text)).toEqual({ name: "x".repeat(119), note: text });
  });

  it("gives an empty name for no note", () => {
    expect(splitNote(null)).toEqual({ name: "", note: null });
  });
});

describe("names", () => {
  it("trims names and compares them without case", () => {
    expect(cleanName("Pet food ")).toBe("Pet food");
    expect(sameName("Eating out", " eating Out")).toBe(true);
  });
});
