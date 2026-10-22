import { MAX_OCCURRENCES, occurrenceDates, type RecurrenceRule } from "./recurrence";

function rule(frequency: RecurrenceRule["frequency"], start_date: string, end_date: string | null = null): RecurrenceRule {
  return { frequency, start_date, end_date };
}

describe("occurrenceDates", () => {
  it("repeats daily", () => {
    expect(occurrenceDates(rule("daily", "2026-02-27"), "2026-03-02")).toEqual({
      dates: ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"],
      truncated: false,
    });
  });

  it("repeats weekly", () => {
    expect(occurrenceDates(rule("weekly", "2026-10-01"), "2026-10-22").dates).toEqual([
      "2026-10-01",
      "2026-10-08",
      "2026-10-15",
      "2026-10-22",
    ]);
  });

  it("repeats biweekly", () => {
    expect(occurrenceDates(rule("biweekly", "2026-12-17"), "2027-01-28").dates).toEqual([
      "2026-12-17",
      "2026-12-31",
      "2027-01-14",
      "2027-01-28",
    ]);
  });

  it("clamps monthly dates from the 31st to the last day of shorter months", () => {
    expect(occurrenceDates(rule("monthly", "2026-01-31"), "2026-05-31").dates).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ]);
  });

  it("uses 29 Feb for a monthly rule in a leap year", () => {
    expect(occurrenceDates(rule("monthly", "2028-01-31"), "2028-03-31").dates).toEqual([
      "2028-01-31",
      "2028-02-29",
      "2028-03-31",
    ]);
  });

  it("repeats quarterly from the start date and clamps the day like monthly", () => {
    expect(occurrenceDates(rule("quarterly", "2026-11-30"), "2027-11-30").dates).toEqual([
      "2026-11-30",
      "2027-02-28",
      "2027-05-30",
      "2027-08-30",
      "2027-11-30",
    ]);
  });

  it("uses 28 Feb for a yearly rule from 29 Feb in non-leap years", () => {
    expect(occurrenceDates(rule("yearly", "2024-02-29"), "2028-12-31").dates).toEqual([
      "2024-02-29",
      "2025-02-28",
      "2026-02-28",
      "2027-02-28",
      "2028-02-29",
    ]);
  });

  it("stops at end_date when it is before upTo", () => {
    expect(occurrenceDates(rule("weekly", "2026-10-01", "2026-10-15"), "2026-12-31").dates).toEqual([
      "2026-10-01",
      "2026-10-08",
      "2026-10-15",
    ]);
  });

  it("stops at upTo when it is before end_date", () => {
    expect(occurrenceDates(rule("daily", "2026-10-01", "2026-12-31"), "2026-10-02").dates).toEqual([
      "2026-10-01",
      "2026-10-02",
    ]);
  });

  it("returns no dates when end_date is before start_date", () => {
    expect(occurrenceDates(rule("daily", "2026-10-10", "2026-10-01"), "2026-12-31")).toEqual({
      dates: [],
      truncated: false,
    });
  });

  it("returns no dates when upTo is before start_date", () => {
    expect(occurrenceDates(rule("monthly", "2026-10-10"), "2026-10-09").dates).toEqual([]);
  });

  it("caps the list at the latest 1000 dates and reports truncated", () => {
    const result = occurrenceDates(rule("daily", "2020-01-01"), "2026-12-31");
    expect(MAX_OCCURRENCES).toBe(1000);
    expect(result.dates).toHaveLength(1000);
    expect(result.dates[0]).toBe("2024-04-06");
    expect(result.dates[999]).toBe("2026-12-31");
    expect(result.truncated).toBe(true);
  });

  it("does not report truncated for exactly 1000 dates", () => {
    const result = occurrenceDates(rule("daily", "2020-01-01"), "2022-09-26");
    expect(result.dates).toHaveLength(1000);
    expect(result.truncated).toBe(false);
  });

  it("throws for an unknown frequency", () => {
    const bad = rule("hourly" as RecurrenceRule["frequency"], "2026-10-01");
    expect(() => occurrenceDates(bad, "2026-10-02")).toThrow("unknown frequency hourly");
  });
});
