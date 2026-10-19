import { useEffect } from "react";
import { usePowerSync, useStatus } from "@powersync/react";

import type { RecurringRule } from "../generated/schema";
import { occurrenceId } from "../domain/ids";
import { today as localToday } from "../domain/period";
import { occurrenceDates } from "../domain/recurrence";
import type { MutationDb } from "./mutations";

type RuleRow = Required<Omit<RecurringRule, "user_id">>;

const RECHECK_MS = 60_000;

/**
 * Inserts one transaction for each occurrence of each rule up to `today` that
 * has no row yet, and returns the count. An existing row with the occurrence
 * ID is never changed, also when the user edited it. PowerSync views do not
 * support INSERT OR IGNORE, so the transaction checks the IDs first.
 */
export function generateDue(db: MutationDb, today: string): Promise<number> {
  return db.writeTransaction(async (tx) => {
    const settings = await tx.getOptional<{ user_id: string; currency_code: string }>(
      "SELECT user_id, currency_code FROM user_settings LIMIT 1",
    );
    if (!settings) return 0;

    const rules = await tx.getAll<RuleRow>(
      `SELECT id, type, amount_minor, name, category_id, account_id, to_account_id, note, frequency, start_date, end_date
       FROM recurring_rules ORDER BY id`,
    );
    let inserted = 0;
    for (const rule of rules) {
      const due = occurrenceDates(rule, today).dates.map((date) => ({ id: occurrenceId(rule.id, date), date }));
      if (due.length === 0) continue;
      const existing = await tx.getAll<{ id: string }>(
        "SELECT id FROM transactions WHERE id IN (SELECT value FROM json_each(?))",
        [JSON.stringify(due.map((o) => o.id))],
      );
      const skip = new Set(existing.map((row) => row.id));
      for (const occurrence of due) {
        if (skip.has(occurrence.id)) continue;
        await tx.execute(
          `INSERT INTO transactions (id, user_id, type, amount_minor, currency_code, date, name, category_id,
             account_id, to_account_id, note, recurring_rule_id, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recurring')`,
          [
            occurrence.id,
            settings.user_id,
            rule.type,
            rule.amount_minor,
            settings.currency_code,
            occurrence.date,
            rule.name,
            rule.category_id,
            rule.account_id,
            rule.to_account_id,
            rule.note,
            rule.id,
          ],
        );
        inserted++;
      }
    }
    return inserted;
  });
}

/**
 * Runs generateDue after the first full sync, and again when the local date
 * changes. saveRecurringRule runs it after a rule is saved.
 */
export function useRecurringGenerator(): void {
  const db = usePowerSync();
  const { hasSynced } = useStatus();

  useEffect(() => {
    if (!hasSynced) return;
    let lastDate = "";
    const run = () => {
      const date = localToday();
      if (date === lastDate) return;
      lastDate = date;
      generateDue(db, date).catch((error: unknown) => {
        lastDate = "";
        console.warn("recurring generator failed", error);
      });
    };
    run();
    const timer = setInterval(run, RECHECK_MS);
    return () => clearInterval(timer);
  }, [db, hasSynced]);
}
