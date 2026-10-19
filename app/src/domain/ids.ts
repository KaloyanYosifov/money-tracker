import { v4, v5 } from "uuid";

// Fixed namespace for occurrence IDs. Do not change it: every device must derive the same ID for a rule and date.
const OCCURRENCE_NAMESPACE = "2822269c-709c-48f0-a0e3-8d49cfcfceb4";

export function newId(): string {
  return v4();
}

/** Deterministic ID for the occurrence of a recurring rule on a `YYYY-MM-DD` date. */
export function occurrenceId(ruleId: string, date: string): string {
  return v5(`${ruleId}:${date}`, OCCURRENCE_NAMESPACE);
}
