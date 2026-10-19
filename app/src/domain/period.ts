import type { UserSettings } from "../generated/schema";

export type PeriodKind = UserSettings["time_period"] | "custom";
export type PeriodSettings = Pick<UserSettings, "week_start_day" | "month_start_day" | "year_start_month">;

/** Inclusive `YYYY-MM-DD` dates. */
export interface Period {
  start: string;
  end: string;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function parse(date: string): CalendarDate {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

function format({ year, month, day }: CalendarDate): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Days since 1970-01-01 in the proleptic Gregorian calendar (Howard Hinnant's days_from_civil).
function toDays({ year, month, day }: CalendarDate): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function fromDays(days: number): CalendarDate {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: era * 400 + yoe + (month <= 2 ? 1 : 0), month, day };
}

function addDays(date: string, n: number): string {
  return format(fromDays(toDays(parse(date)) + n));
}

// 0 is Sunday. 1970-01-01 was a Thursday.
function weekday(days: number): number {
  return (((days + 4) % 7) + 7) % 7;
}

function weekStart(days: number, weekStartDay: number): number {
  return days - ((weekday(days) - weekStartDay + 7) % 7);
}

function addMonths({ year, month }: CalendarDate, n: number, day: number): CalendarDate {
  const index = year * 12 + (month - 1) + n;
  return { year: Math.floor(index / 12), month: (index % 12) + 1, day };
}

export function today(): string {
  const now = new Date();
  return format({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() });
}

export function periodFor(date: string, kind: Exclude<PeriodKind, "custom">, settings: PeriodSettings): Period {
  const d = parse(date);
  const days = toDays(d);
  switch (kind) {
    case "daily":
      return { start: date, end: date };
    case "weekly": {
      const start = weekStart(days, settings.week_start_day);
      return { start: format(fromDays(start)), end: format(fromDays(start + 6)) };
    }
    case "biweekly": {
      // The first week start on or after 2024-01-01, so that all devices agree on the pairs of weeks.
      const anchor = weekStart(toDays({ year: 2024, month: 1, day: 7 }), settings.week_start_day);
      const start = anchor + Math.floor((days - anchor) / 14) * 14;
      return { start: format(fromDays(start)), end: format(fromDays(start + 13)) };
    }
    case "monthly": {
      const startDay = settings.month_start_day;
      const start = addMonths(d, d.day >= startDay ? 0 : -1, startDay);
      return { start: format(start), end: addDays(format(addMonths(start, 1, startDay)), -1) };
    }
    case "yearly": {
      const startMonth = settings.year_start_month;
      const year = d.month >= startMonth ? d.year : d.year - 1;
      const start = { year, month: startMonth, day: 1 };
      return { start: format(start), end: addDays(format({ ...start, year: year + 1 }), -1) };
    }
  }
}

export function shiftPeriod(period: Period, kind: PeriodKind, settings: PeriodSettings, step: number): Period {
  if (kind === "custom") {
    const length = toDays(parse(period.end)) - toDays(parse(period.start)) + 1;
    return { start: addDays(period.start, length * step), end: addDays(period.end, length * step) };
  }
  let result = period;
  for (let i = 0; i < Math.abs(step); i++) {
    const date = step > 0 ? addDays(result.end, 1) : addDays(result.start, -1);
    result = periodFor(date, kind, settings);
  }
  return result;
}

function formatDate(date: CalendarDate, locale: string | undefined, options: Intl.DateTimeFormatOptions): string {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(utc);
}

function rangeLabel(start: CalendarDate, end: CalendarDate, currentYear: number, locale?: string): string {
  const withYear = start.year !== end.year || start.year !== currentYear;
  const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", ...(withYear && { year: "numeric" }) };
  if (start.year === end.year && start.month === end.month) {
    // Keep the locale order of day and month, and put the range on the day: "12 – 18 Oct" or "Oct 12 – 18".
    const utc = new Date(Date.UTC(end.year, end.month - 1, end.day));
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" })
      .formatToParts(utc)
      .map((part) => (part.type === "day" ? `${start.day} – ${end.day}` : part.value))
      .join("");
  }
  return `${formatDate(start, locale, options)} – ${formatDate(end, locale, options)}`;
}

export function periodLabel(period: Period, kind: PeriodKind, locale?: string, now: string = today()): string {
  const start = parse(period.start);
  const end = parse(period.end);
  const currentYear = parse(now).year;
  switch (kind) {
    case "daily":
      return formatDate(start, locale, {
        weekday: "short",
        day: "numeric",
        month: "short",
        ...(start.year !== currentYear && { year: "numeric" }),
      });
    case "monthly":
      if (start.day !== 1) return rangeLabel(start, end, currentYear, locale);
      return formatDate(start, locale, { month: "long", ...(start.year !== currentYear && { year: "numeric" }) });
    case "yearly":
      if (start.month === 1) return String(start.year);
      return `${formatDate(start, locale, { month: "short", year: "numeric" })} – ${formatDate(end, locale, {
        month: "short",
        year: "numeric",
      })}`;
    default:
      return rangeLabel(start, end, currentYear, locale);
  }
}
