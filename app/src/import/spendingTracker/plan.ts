import { occurrenceId } from "../../domain/ids.ts";
import { occurrenceDates, type RecurrenceRule } from "../../domain/recurrence.ts";
import type { RecurringRule } from "../../generated/schema.ts";
import { cleanName, colorFor, iconFor, importId, splitNote, ticksToDate, toMinor } from "./convert.ts";
import { categoryType, findCategoryTarget, findTarget, rowCategory } from "./mapping.ts";
import type {
  CountKey,
  Existing,
  ImportPlan,
  Mapping,
  Problem,
  SourceData,
  SourceRecurring,
  SourceTransaction,
  UploadOp,
} from "./types.ts";

export interface PlanOptions {
  userId: string;
  importBatchId: string;
  /** The local date, YYYY-MM-DD. */
  today: string;
}

const FREQUENCIES: Record<string, RecurringRule["frequency"]> = {
  "Daily/1": "daily",
  "Weekly/1": "weekly",
  "Weekly/2": "biweekly",
  "Monthly/1": "monthly",
  "Yearly/1": "yearly",
};

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The first scheduled date of a rule after `after`, on the day of the month of
 * the start date, so that later dates keep the schedule. Null if the rule ends first.
 */
function nextStart(rule: RecurrenceRule, after: string): string | null {
  const day = rule.start_date.slice(8);
  const sameDay = rule.frequency === "monthly" || rule.frequency === "yearly";
  // Two years cover the next date with the same day for each frequency.
  const dates = occurrenceDates(rule, addDays(after, 2 * 366)).dates;
  return dates.find((d) => d > after && (!sameDay || d.slice(8) === day)) ?? null;
}

/** The month after a YYYY-MM month. */
function nextMonth(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, "0")}`;
}

function nextSortOrder(records: { sort_order: number }[]): number {
  return records.reduce((max, r) => Math.max(max, r.sort_order + 1), 0);
}

function resolve(records: { id: string; name: string; archived: boolean }[], name: string | undefined): string | undefined {
  const result = findTarget(records, name ?? "");
  return "record" in result ? result.record.id : undefined;
}

/**
 * The upload ops for a backup and a mapping that validateMapping accepted:
 * accounts, then categories, then recurring rules, then transactions. The
 * same input always gives the same plan.
 */
export function buildPlan(source: SourceData, mapping: Mapping, existing: Existing, options: PlanOptions): ImportPlan {
  const { userId, importBatchId, today } = options;
  const currency = mapping.currency;
  const accountOps: UploadOp[] = [];
  const categoryOps: UploadOp[] = [];
  const ruleOps: UploadOp[] = [];
  const transactionOps: UploadOp[] = [];
  const problems: Problem[] = [];
  const counts: Record<CountKey, number> = {
    accounts: 0,
    categories: 0,
    recurring_rules: 0,
    transactions: 0,
    transfers: 0,
    occurrences: 0,
    carry_adjustments: 0,
  };

  const opening = new Set(mapping.opening_balances);
  const openingBalance = new Map<number, number>();
  for (const t of source.transactions) {
    if (!opening.has(t.Id) || t.ProfileId === null) continue;
    const amount = toMinor(t.Amount, currency) * (t.Type === "Expense" ? -1 : 1);
    openingBalance.set(t.ProfileId, (openingBalance.get(t.ProfileId) ?? 0) + amount);
  }

  // Accounts. accountIds maps a source profile ID to an account ID.
  const accountIds = new Map<number, string>();
  let accountSort = nextSortOrder(existing.accounts);
  [...source.profiles]
    .sort((a, b) => a.Id - b.Id)
    .forEach((p, index) => {
      const entry = mapping.accounts[p.Id];
      if (!entry || entry.action === "skip") return;
      const balance = openingBalance.get(p.Id) ?? 0;
      if (entry.action === "match") {
        const id = resolve(existing.accounts, entry.target);
        if (!id) return;
        accountIds.set(p.Id, id);
        if (openingBalance.has(p.Id)) {
          accountOps.push({ op: "PATCH", table: "accounts", id, data: { opening_balance_minor: balance } });
        }
        return;
      }
      const id = importId("account", p.Id, userId);
      accountIds.set(p.Id, id);
      accountOps.push({
        op: "PUT",
        table: "accounts",
        id,
        data: {
          user_id: userId,
          name: cleanName(entry.name),
          color: entry.color ?? colorFor(p.Colour, index),
          sort_order: accountSort++,
          opening_balance_minor: balance,
        },
      });
      counts.accounts += 1;
    });

  // Categories. categoryIds maps a source category ID to a category ID.
  const categoryIds = new Map<number, string>();
  let categorySort = nextSortOrder(existing.categories);
  [...source.categories]
    .sort((a, b) => a.Id - b.Id)
    .forEach((c, index) => {
      const entry = mapping.categories[c.Id];
      const type = categoryType(c.Type);
      if (!entry || entry.action === "skip" || type === "transfer") return;
      if (entry.action === "match") {
        const id = resolve(
          existing.categories.filter((e) => e.type === type),
          entry.target,
        );
        if (id) categoryIds.set(c.Id, id);
        return;
      }
      const id = importId("category", c.Id, userId);
      categoryIds.set(c.Id, id);
      categoryOps.push({
        op: "PUT",
        table: "categories",
        id,
        data: {
          user_id: userId,
          type,
          name: cleanName(entry.name),
          icon: entry.icon ?? iconFor(c.Icon),
          color: entry.color ?? colorFor(c.Colour, index),
          sort_order: categorySort++,
        },
      });
      counts.categories += 1;
    });

  const carryCategories = new Set(source.categories.filter((c) => c.Type === "Carry").map((c) => c.Id));

  let withoutAccount: string | undefined;
  if (mapping.rows_without_account.action === "match") {
    withoutAccount = resolve(existing.accounts, mapping.rows_without_account.target);
  }
  const accountFor = (profileId: number | null) =>
    profileId === null ? withoutAccount : accountIds.get(profileId);

  const wrongCategory = (t: SourceTransaction | SourceRecurring, what: string): Problem | null => {
    if (rowCategory(source.categories, t).ok) return null;
    const name = source.categories.find((c) => c.Id === t.CategoryId)?.Name ?? "";
    return {
      kind: "category_type",
      sourceIds: [t.Id],
      message: `${what} ${t.Id}: ${t.Type} in a category "${cleanName(name)}" of another type, and no ${t.Type} category with that name exists`,
    };
  };

  const rowValues = (t: SourceTransaction | SourceRecurring) => {
    const { name, note } = splitNote(t.Note);
    const categoryId = rowCategory(source.categories, t).id;
    return {
      user_id: userId,
      amount_minor: toMinor(t.Amount, currency),
      name,
      category_id: categoryId === null ? null : categoryIds.get(categoryId) ?? null,
      account_id: accountFor(t.ProfileId),
      to_account_id: null,
      note,
    };
  };

  // Recurring rules, and the linked rows that are their occurrences.
  const occurrences = new Map<number, { ruleId: string; date: string }>();
  const linked = new Map<number, SourceTransaction[]>();
  for (const t of [...source.transactions].sort((a, b) => a.Id - b.Id)) {
    if (t.RecurringTransactionId === null) continue;
    const rows = linked.get(t.RecurringTransactionId) ?? [];
    rows.push(t);
    linked.set(t.RecurringTransactionId, rows);
  }

  for (const r of [...source.recurring].sort((a, b) => a.Id - b.Id)) {
    const frequency = FREQUENCIES[`${r.RecurringType}/${r.RecurringPeriod}`];
    if (!frequency || r.Type === "Transfer") {
      problems.push({
        kind: "unsupported_recurrence",
        sourceIds: [r.Id],
        message: `rule ${r.Id}: ${r.Type} every ${r.RecurringPeriod} ${r.RecurringType} is not supported; its rows import as normal rows`,
      });
      continue;
    }
    const ruleProblem = wrongCategory(r, "rule");
    if (ruleProblem) {
      problems.push({ ...ruleProblem, message: `${ruleProblem.message}; its rows import as normal rows` });
      continue;
    }
    const values = rowValues(r);
    if (!values.account_id) {
      problems.push({ kind: "no_account", sourceIds: [r.Id], message: `rule ${r.Id}: no account; its rows import as normal rows` });
      continue;
    }
    if (r.Amount <= 0 || values.amount_minor <= 0) {
      problems.push({ kind: "invalid_amount", sourceIds: [r.Id], message: `rule ${r.Id}: amount ${r.Amount} is not positive` });
      continue;
    }
    const ruleId = importId("rule", r.Id, userId);
    const rule = {
      frequency,
      start_date: ticksToDate(r.Date),
      end_date: r.EndDate === null ? null : ticksToDate(r.EndDate),
    };

    // Linked rows after today also become occurrences. The generator skips an
    // occurrence ID that already exists, so it creates no second row on that date.
    const rows = linked.get(r.Id) ?? [];
    const last = rows.reduce((max, t) => (ticksToDate(t.Date) > max ? ticksToDate(t.Date) : max), today);
    const scheduled = new Set(occurrenceDates(rule, last).dates);
    const claimed = new Map<string, number>();
    for (const t of rows) {
      const date = ticksToDate(t.Date);
      if (scheduled.has(date) && !claimed.has(date)) claimed.set(date, t.Id);
    }

    // The user deleted a past occurrence, and the generator creates a row for
    // each missing date. So the rule starts after the last missing date, and
    // the linked rows before that start import as normal rows.
    const missing = occurrenceDates(rule, today).dates.filter((date) => !claimed.has(date));
    if (missing.length > 0) {
      const gap = missing[missing.length - 1];
      const start = nextStart(rule, gap);
      problems.push({
        kind: "missing_occurrence",
        sourceIds: [r.Id],
        message: start
          ? `rule ${r.Id}: no row on ${missing.join(", ")}; the rule starts on ${start}, and the rows before it import as normal rows`
          : `rule ${r.Id}: no row on ${missing.join(", ")}; the rule has no date after it, so its rows import as normal rows`,
      });
      if (!start) continue;
      rule.start_date = start;
      for (const date of [...claimed.keys()]) if (date < start) claimed.delete(date);
    }

    for (const [date, id] of claimed) occurrences.set(id, { ruleId, date });
    ruleOps.push({
      op: "PUT",
      table: "recurring_rules",
      id: ruleId,
      data: { ...values, type: r.Type.toLowerCase(), ...rule },
    });
    counts.recurring_rules += 1;
  }

  // Transactions and transfers, by ascending source ID.
  const sorted = [...source.transactions].sort((a, b) => a.Id - b.Id);
  const transfers = sorted.filter((t) => t.Type === "Transfer");
  const nextTransfer = new Map(transfers.map((t, i) => [t.Id, transfers[i + 1]]));
  const paired = new Set<number>();

  const unpaired = mapping.unpaired_transfers;
  const unpairedCategory = (type: "expense" | "income") => {
    if (unpaired.action !== "import") return undefined;
    const result = findCategoryTarget(
      mapping,
      existing,
      type === "expense" ? unpaired.expense_category : unpaired.income_category,
      type,
    );
    if ("id" in result) return result.id;
    return "sourceId" in result ? categoryIds.get(result.sourceId) : undefined;
  };

  const pushTransaction = (id: string, data: Record<string, unknown>) =>
    transactionOps.push({ op: "PUT", table: "transactions", id, data: { currency_code: currency, ...data } });

  for (const t of sorted) {
    if (paired.has(t.Id)) continue;
    const date = ticksToDate(t.Date);

    if (t.Type === "Transfer") {
      const next = nextTransfer.get(t.Id);
      const pairs =
        next !== undefined &&
        t.ProfileId !== null &&
        next.ProfileId !== null &&
        t.ProfileId !== next.ProfileId &&
        ticksToDate(next.Date) === date &&
        Math.sign(t.Amount) === -Math.sign(next.Amount) &&
        t.Amount !== 0;
      if (!pairs) {
        const type = t.Amount < 0 ? "expense" : "income";
        const categoryId = unpairedCategory(type);
        const accountId = accountFor(t.ProfileId);
        const amount = toMinor(t.Amount, currency);
        const imported = categoryId !== undefined && accountId !== undefined && amount > 0;
        problems.push({
          kind: "unpaired_transfer",
          sourceIds: [t.Id],
          message: `transfer ${t.Id} on ${date} has no partner row${imported ? `; it imports as ${type}` : ""}`,
        });
        if (!imported) continue;
        const { name, note } = splitNote(t.Note);
        pushTransaction(importId("transaction", t.Id, userId), {
          user_id: userId,
          type,
          amount_minor: amount,
          date,
          name,
          note,
          category_id: categoryId,
          account_id: accountId,
          to_account_id: null,
          recurring_rule_id: null,
          source: "import",
          import_batch_id: importBatchId,
          external_id: `st:${t.Id}`,
        });
        counts.transactions += 1;
        continue;
      }
      paired.add(next.Id);
      const [from, to] = t.Amount < 0 ? [t, next] : [next, t];
      const fromAccount = accountFor(from.ProfileId);
      const toAccount = accountFor(to.ProfileId);
      if (!fromAccount || !toAccount) {
        problems.push({ kind: "no_account", sourceIds: [t.Id, next.Id], message: `transfer ${t.Id}+${next.Id}: no account` });
        continue;
      }
      if (fromAccount === toAccount) {
        problems.push({
          kind: "same_account_transfer",
          sourceIds: [t.Id, next.Id],
          message: `transfer ${t.Id}+${next.Id}: both rows map to one account`,
        });
        continue;
      }
      if (toMinor(from.Amount, currency) <= 0) {
        problems.push({ kind: "invalid_amount", sourceIds: [t.Id, next.Id], message: `transfer ${t.Id}+${next.Id}: amount ${from.Amount} rounds to 0` });
        continue;
      }
      const { name, note } = splitNote(from.Note);
      pushTransaction(importId("transfer", t.Id, userId), {
        user_id: userId,
        type: "transfer",
        amount_minor: toMinor(from.Amount, currency),
        date,
        name,
        note,
        category_id: null,
        account_id: fromAccount,
        to_account_id: toAccount,
        recurring_rule_id: null,
        source: "import",
        import_batch_id: importBatchId,
        external_id: `st:${t.Id}+${next.Id}`,
      });
      counts.transfers += 1;
      continue;
    }

    const isCarry = t.CategoryId !== null && carryCategories.has(t.CategoryId);
    if (isCarry && opening.has(t.Id)) continue;
    const categoryProblem = wrongCategory(t, "row");
    if (categoryProblem) {
      problems.push(categoryProblem);
      continue;
    }
    const values = rowValues(t);
    if (!values.account_id) {
      problems.push({ kind: "no_account", sourceIds: [t.Id], message: `row ${t.Id} on ${date} has no account` });
      continue;
    }
    if (t.Amount <= 0 || values.amount_minor <= 0) {
      problems.push({ kind: "invalid_amount", sourceIds: [t.Id], message: `row ${t.Id}: amount ${t.Amount} is not positive` });
      continue;
    }
    const occurrence = occurrences.get(t.Id);
    pushTransaction(occurrence ? occurrenceId(occurrence.ruleId, occurrence.date) : importId("transaction", t.Id, userId), {
      ...values,
      type: isCarry ? "income" : t.Type.toLowerCase(),
      date,
      recurring_rule_id: occurrence?.ruleId ?? null,
      source: occurrence ? "recurring" : "import",
      import_batch_id: importBatchId,
      external_id: `st:${t.Id}`,
    });
    if (occurrence) counts.occurrences += 1;
    else counts.transactions += 1;
  }

  // Carry positive only: Spending Tracker carries a negative month end as 0.
  // An income row on the first day of the next month gives the same balance.
  const adjustments = mapping.carry_adjustments;
  const adjustmentCategory = (() => {
    if (adjustments.action !== "import") return undefined;
    const result = findCategoryTarget(mapping, existing, adjustments.category, "income");
    if ("id" in result) return result.id;
    return "sourceId" in result ? categoryIds.get(result.sourceId) : undefined;
  })();
  const fallback = source.strategies.find((s) => s.ProfileId === null);
  for (const p of [...source.profiles].sort((a, b) => a.Id - b.Id)) {
    const accountId = accountIds.get(p.Id);
    const strategy = source.strategies.find((s) => s.ProfileId === p.Id) ?? fallback;
    if (!adjustmentCategory || !accountId || !strategy?.CarryPositiveOnly) continue;
    const months = new Map<string, number>();
    for (const t of source.transactions) {
      if (t.ProfileId !== p.Id) continue;
      const month = ticksToDate(t.Date).slice(0, 7);
      const minor = toMinor(t.Amount, currency);
      const delta = t.Type === "Expense" ? -minor : t.Type === "Income" ? minor : Math.sign(t.Amount) * minor;
      months.set(month, (months.get(month) ?? 0) + delta);
    }
    const sortedMonths = [...months.keys()].sort();
    if (sortedMonths.length === 0) continue;
    const lastRow = sortedMonths[sortedMonths.length - 1];
    const end = lastRow > today.slice(0, 7) ? lastRow : today.slice(0, 7);
    let balance = 0;
    for (let month = sortedMonths[0]; month < end; month = nextMonth(month)) {
      balance += months.get(month) ?? 0;
      if (balance >= 0) continue;
      const date = `${nextMonth(month)}-01`;
      pushTransaction(importId("carry_adjustment", `${p.Id}:${month}`, userId), {
        user_id: userId,
        type: "income",
        amount_minor: -balance,
        date,
        name: "Carry Over adjustment",
        note: `Spending Tracker carried the negative balance of ${month} as 0`,
        category_id: adjustmentCategory,
        account_id: accountId,
        to_account_id: null,
        recurring_rule_id: null,
        source: "import",
        import_batch_id: importBatchId,
        external_id: `st:carry:${p.Id}:${month}`,
      });
      counts.carry_adjustments += 1;
      balance = 0;
    }
  }

  return { ops: [...accountOps, ...categoryOps, ...ruleOps, ...transactionOps], problems, counts };
}
