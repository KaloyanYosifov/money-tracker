import type { RecurringRule } from "../generated/schema";

export type RecurrenceRule = Pick<RecurringRule, "frequency" | "start_date" | "end_date">;

export interface Occurrences {
  dates: string[];
  /** True when more dates exist up to the limit than MAX_OCCURRENCES. */
  truncated: boolean;
}

export const MAX_OCCURRENCES = 1000;

// All math uses UTC dates, so the local time zone never moves a day.
function parse(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month: month - 1, day };
}

function format(utc: Date): string {
  return utc.toISOString().slice(0, 10);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

const MONTHS = { monthly: 1, quarterly: 3, yearly: 12 } as const;

// Occurrence n is computed from the start date, not from occurrence n-1, so a short month does not move later dates.
function nthDate(frequency: RecurrenceRule["frequency"], start: string, n: number): string {
  const { year, month, day } = parse(start);
  switch (frequency) {
    case "daily":
      return format(new Date(Date.UTC(year, month, day + n)));
    case "weekly":
      return format(new Date(Date.UTC(year, month, day + 7 * n)));
    case "biweekly":
      return format(new Date(Date.UTC(year, month, day + 14 * n)));
    case "monthly":
    case "quarterly":
    case "yearly": {
      const first = new Date(Date.UTC(year, month + MONTHS[frequency] * n, 1));
      const y = first.getUTCFullYear();
      const m = first.getUTCMonth();
      return format(new Date(Date.UTC(y, m, Math.min(day, daysInMonth(y, m)))));
    }
    default:
      throw new Error(`unknown frequency ${String(frequency)}`);
  }
}

/**
 * All occurrence dates from `start_date` to the lower of `upTo` and `end_date`, both inclusive.
 * If there are more than MAX_OCCURRENCES, only the latest ones are returned.
 */
export function occurrenceDates(rule: RecurrenceRule, upTo: string): Occurrences {
  const limit = rule.end_date != null && rule.end_date < upTo ? rule.end_date : upTo;
  const dates: string[] = [];
  let truncated = false;
  for (let n = 0; ; n++) {
    const date = nthDate(rule.frequency, rule.start_date, n);
    if (date > limit) return { dates, truncated };
    if (dates.length === MAX_OCCURRENCES) {
      dates.shift();
      truncated = true;
    }
    dates.push(date);
  }
}
