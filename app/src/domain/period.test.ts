import { periodFor, periodLabel, shiftPeriod, today, type PeriodSettings } from "./period";

const settings: PeriodSettings = { week_start_day: 1, month_start_day: 1, year_start_month: 1 };

describe("periodFor", () => {
  it("gives a Monday to Sunday week with week_start_day 1", () => {
    expect(periodFor("2026-10-19", "weekly", settings)).toEqual({ start: "2026-10-19", end: "2026-10-25" });
    expect(periodFor("2026-10-25", "weekly", settings)).toEqual({ start: "2026-10-19", end: "2026-10-25" });
  });

  it("gives a Sunday to Saturday week with week_start_day 0", () => {
    const s = { ...settings, week_start_day: 0 };
    expect(periodFor("2026-10-19", "weekly", s)).toEqual({ start: "2026-10-18", end: "2026-10-24" });
    expect(periodFor("2026-10-18", "weekly", s)).toEqual({ start: "2026-10-18", end: "2026-10-24" });
  });

  it("anchors biweekly periods to the first week start on or after 2024-01-01", () => {
    // 2024-01-01 is a Monday.
    expect(periodFor("2024-01-01", "biweekly", settings)).toEqual({ start: "2024-01-01", end: "2024-01-14" });
    expect(periodFor("2024-01-15", "biweekly", settings)).toEqual({ start: "2024-01-15", end: "2024-01-28" });
    expect(periodFor("2026-10-25", "biweekly", settings)).toEqual({ start: "2026-10-19", end: "2026-11-01" });
    expect(periodFor("2023-12-31", "biweekly", settings)).toEqual({ start: "2023-12-18", end: "2023-12-31" });
  });

  it("anchors Sunday biweekly periods to 2024-01-07", () => {
    const s = { ...settings, week_start_day: 0 };
    expect(periodFor("2024-01-07", "biweekly", s)).toEqual({ start: "2024-01-07", end: "2024-01-20" });
    expect(periodFor("2024-01-06", "biweekly", s)).toEqual({ start: "2023-12-24", end: "2024-01-06" });
  });

  it("gives calendar months with month_start_day 1", () => {
    expect(periodFor("2026-10-19", "monthly", settings)).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(periodFor("2026-12-31", "monthly", settings)).toEqual({ start: "2026-12-01", end: "2026-12-31" });
  });

  it("gives 25 Sep to 24 Oct with month_start_day 25", () => {
    const s = { ...settings, month_start_day: 25 };
    expect(periodFor("2026-10-19", "monthly", s)).toEqual({ start: "2026-09-25", end: "2026-10-24" });
    expect(periodFor("2026-10-25", "monthly", s)).toEqual({ start: "2026-10-25", end: "2026-11-24" });
    expect(periodFor("2027-01-03", "monthly", s)).toEqual({ start: "2026-12-25", end: "2027-01-24" });
  });

  it("handles February and leap years", () => {
    expect(periodFor("2024-02-29", "monthly", settings)).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(periodFor("2025-02-10", "monthly", settings)).toEqual({ start: "2025-02-01", end: "2025-02-28" });
    const s = { ...settings, month_start_day: 28 };
    expect(periodFor("2024-02-28", "monthly", s)).toEqual({ start: "2024-02-28", end: "2024-03-27" });
    expect(periodFor("2025-02-27", "monthly", s)).toEqual({ start: "2025-01-28", end: "2025-02-27" });
    expect(periodFor("2024-02-29", "daily", settings)).toEqual({ start: "2024-02-29", end: "2024-02-29" });
  });

  it("gives 1 Apr to 31 Mar with year_start_month 4", () => {
    const s = { ...settings, year_start_month: 4 };
    expect(periodFor("2026-10-19", "yearly", s)).toEqual({ start: "2026-04-01", end: "2027-03-31" });
    expect(periodFor("2026-03-31", "yearly", s)).toEqual({ start: "2025-04-01", end: "2026-03-31" });
    expect(periodFor("2026-10-19", "yearly", settings)).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });

  it("gives one day for daily", () => {
    expect(periodFor("2026-10-19", "daily", settings)).toEqual({ start: "2026-10-19", end: "2026-10-19" });
  });
});

describe("shiftPeriod", () => {
  it("moves weeks and biweeks", () => {
    const week = periodFor("2026-10-19", "weekly", settings);
    expect(shiftPeriod(week, "weekly", settings, 1)).toEqual({ start: "2026-10-26", end: "2026-11-01" });
    expect(shiftPeriod(week, "weekly", settings, -1)).toEqual({ start: "2026-10-12", end: "2026-10-18" });
    const biweek = periodFor("2026-10-19", "biweekly", settings);
    expect(shiftPeriod(biweek, "biweekly", settings, 1)).toEqual({ start: "2026-11-02", end: "2026-11-15" });
    expect(shiftPeriod(biweek, "biweekly", settings, -1)).toEqual({ start: "2026-10-05", end: "2026-10-18" });
  });

  it("moves months across year ends and February", () => {
    const s = { ...settings, month_start_day: 28 };
    const jan = periodFor("2024-02-01", "monthly", s);
    expect(jan).toEqual({ start: "2024-01-28", end: "2024-02-27" });
    expect(shiftPeriod(jan, "monthly", s, 1)).toEqual({ start: "2024-02-28", end: "2024-03-27" });
    const dec = periodFor("2026-12-05", "monthly", settings);
    expect(shiftPeriod(dec, "monthly", settings, 1)).toEqual({ start: "2027-01-01", end: "2027-01-31" });
    expect(shiftPeriod(dec, "monthly", settings, -1)).toEqual({ start: "2026-11-01", end: "2026-11-30" });
  });

  it("moves years and days", () => {
    const s = { ...settings, year_start_month: 4 };
    const year = periodFor("2026-10-19", "yearly", s);
    expect(shiftPeriod(year, "yearly", s, -1)).toEqual({ start: "2025-04-01", end: "2026-03-31" });
    const day = periodFor("2024-02-28", "daily", settings);
    expect(shiftPeriod(day, "daily", settings, 1)).toEqual({ start: "2024-02-29", end: "2024-02-29" });
    expect(shiftPeriod(day, "daily", settings, -1)).toEqual({ start: "2024-02-27", end: "2024-02-27" });
  });

  it("moves a custom period by its own length", () => {
    const custom = { start: "2026-10-10", end: "2026-10-19" };
    expect(shiftPeriod(custom, "custom", settings, 1)).toEqual({ start: "2026-10-20", end: "2026-10-29" });
    expect(shiftPeriod(custom, "custom", settings, -1)).toEqual({ start: "2026-09-30", end: "2026-10-09" });
    const leap = { start: "2024-02-28", end: "2024-03-01" };
    expect(shiftPeriod(leap, "custom", settings, -1)).toEqual({ start: "2024-02-25", end: "2024-02-27" });
  });
});

describe("periodLabel", () => {
  const now = "2026-10-19";

  it("names the month, with the year only when it is not the current year", () => {
    expect(periodLabel({ start: "2026-10-01", end: "2026-10-31" }, "monthly", "en-GB", now)).toBe("October");
    expect(periodLabel({ start: "2025-10-01", end: "2025-10-31" }, "monthly", "en-GB", now)).toBe("October 2025");
  });

  it("shows a range for a month that does not start on day 1", () => {
    expect(periodLabel({ start: "2026-09-25", end: "2026-10-24" }, "monthly", "en-GB", now)).toBe("25 Sept – 24 Oct");
  });

  it("shows a day range for weeks", () => {
    expect(periodLabel({ start: "2026-10-12", end: "2026-10-18" }, "weekly", "en-GB", now)).toBe("12 – 18 Oct");
    expect(periodLabel({ start: "2026-09-28", end: "2026-10-04" }, "weekly", "en-GB", now)).toBe("28 Sept – 4 Oct");
    expect(periodLabel({ start: "2026-10-12", end: "2026-10-25" }, "biweekly", "en-GB", now)).toBe("12 – 25 Oct");
  });

  it("shows the years when a range is not inside the current year", () => {
    expect(periodLabel({ start: "2025-12-29", end: "2026-01-04" }, "weekly", "en-GB", now)).toBe(
      "29 Dec 2025 – 4 Jan 2026",
    );
  });

  it("names the year", () => {
    expect(periodLabel({ start: "2026-01-01", end: "2026-12-31" }, "yearly", "en-GB", now)).toBe("2026");
    expect(periodLabel({ start: "2026-04-01", end: "2027-03-31" }, "yearly", "en-GB", now)).toBe("Apr 2026 – Mar 2027");
  });

  it("names the day", () => {
    expect(periodLabel({ start: "2026-10-19", end: "2026-10-19" }, "daily", "en-GB", now)).toBe("Mon 19 Oct");
    expect(periodLabel({ start: "2026-10-19", end: "2026-10-19" }, "daily", "en-US", now)).toBe("Mon, Oct 19");
  });

  it("shows a range for a custom period", () => {
    expect(periodLabel({ start: "2026-10-10", end: "2026-11-02" }, "custom", "en-GB", now)).toBe("10 Oct – 2 Nov");
  });
});

describe("today", () => {
  it("returns the local date as YYYY-MM-DD", () => {
    const d = new Date();
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(today()).toBe(expected);
  });
});
