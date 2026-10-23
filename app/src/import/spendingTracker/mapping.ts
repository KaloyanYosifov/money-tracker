import { cleanName, colorFor, iconFor, sameName } from "./convert.ts";
import type { CategoryEntry, Existing, Mapping, SourceCategory, SourceData, SourceType } from "./types.ts";

export const CARRY_TARGET = "Other income";

export function categoryType(type: SourceType): CategoryEntry["type"] {
  if (type === "Transfer") return "transfer";
  if (type === "Expense") return "expense";
  return "income";
}

type Named = { id: string; name: string; archived: boolean };

/**
 * The existing record with this name, or an error text. An archived record
 * or a name that two records share is an error.
 */
export function findTarget<T extends Named>(records: T[], name: string): { record: T } | { error: string } {
  const matches = records.filter((r) => sameName(r.name, name));
  const active = matches.filter((r) => !r.archived);
  if (active.length === 1) return { record: active[0] };
  if (active.length > 1) return { error: `"${name}" matches ${active.length} records` };
  if (matches.length > 0) return { error: `"${name}" is archived` };
  return { error: `"${name}" does not exist` };
}

function activeMatch<T extends Named>(records: T[], name: string): T | undefined {
  const result = findTarget(records, name);
  return "record" in result ? result.record : undefined;
}

/**
 * The source category of a row. If the row type is not the type of its
 * category, the row uses the category with the same name and the row type.
 * ok is false when the backup has no such category.
 */
export function rowCategory(
  categories: SourceCategory[],
  row: { Type: string; CategoryId: number | null },
): { id: number | null; ok: boolean } {
  const category = categories.find((c) => c.Id === row.CategoryId);
  const type = row.Type.toLowerCase();
  if (!category || categoryType(category.Type) === type) return { id: row.CategoryId, ok: true };
  const sibling = categories.find((c) => categoryType(c.Type) === type && sameName(c.Name, category.Name));
  return sibling ? { id: sibling.Id, ok: true } : { id: row.CategoryId, ok: false };
}

/** The number of transactions and rules of each source profile and category. */
function usage(source: SourceData, opening: Set<number>) {
  const profiles = new Map<number, number>();
  const categories = new Map<number, number>();
  const add = (map: Map<number, number>, id: number | null) => {
    if (id !== null) map.set(id, (map.get(id) ?? 0) + 1);
  };
  for (const t of source.transactions) {
    add(profiles, t.ProfileId);
    if (!opening.has(t.Id)) add(categories, rowCategory(source.categories, t).id);
  }
  for (const r of source.recurring) {
    add(profiles, r.ProfileId);
    add(categories, rowCategory(source.categories, r).id);
  }
  return { profiles, categories };
}

/**
 * The category with this name and type: an existing one, or one that the
 * mapping creates (then sourceId is its source category ID).
 */
export function findCategoryTarget(
  mapping: Mapping,
  existing: Existing,
  name: string,
  type: "expense" | "income",
): { id: string } | { sourceId: number } | { error: string } {
  const result = findTarget(existing.categories.filter((c) => c.type === type), name);
  if ("record" in result) return { id: result.record.id };
  const created = Object.entries(mapping.categories).find(
    ([, e]) => e.action === "create" && e.type === type && sameName(e.name, name),
  );
  if (created) return { sourceId: Number(created[0]) };
  return { error: `${type} category ${result.error}` };
}

export const UNPAIRED_EXPENSE = "General";
export const NO_ACCOUNT = "No account";

/** The earliest Carry row of each profile. Rows on the same date go by the lower ID. */
function proposeOpeningBalances(source: SourceData): number[] {
  const carry = new Set(source.categories.filter((c) => c.Type === "Carry").map((c) => c.Id));
  const earliest = new Map<number, { id: number; date: bigint }>();
  for (const t of source.transactions) {
    if (t.ProfileId === null || t.CategoryId === null || !carry.has(t.CategoryId)) continue;
    const date = BigInt(t.Date);
    const best = earliest.get(t.ProfileId);
    if (!best || date < best.date || (date === best.date && t.Id < best.id)) {
      earliest.set(t.ProfileId, { id: t.Id, date });
    }
  }
  return [...earliest.values()].map((e) => e.id).sort((a, b) => a - b);
}

/** A first mapping: match by name where possible, else create, and skip what nothing uses. */
export function proposeMapping(source: SourceData, existing: Existing): Mapping {
  const opening_balances = proposeOpeningBalances(source);
  const used = usage(source, new Set(opening_balances));

  const accounts: Mapping["accounts"] = {};
  [...source.profiles]
    .sort((a, b) => a.Id - b.Id)
    .forEach((p, index) => {
      const name = cleanName(p.Name);
      if (!used.profiles.get(p.Id)) {
        accounts[p.Id] = { name, action: "skip", reason: "0 transactions" };
        return;
      }
      const match = activeMatch(existing.accounts, name);
      accounts[p.Id] = match
        ? { name, action: "match", target: match.name }
        : { name, action: "create", color: colorFor(p.Colour, index) };
    });

  const categories: Mapping["categories"] = {};
  [...source.categories]
    .sort((a, b) => a.Id - b.Id)
    .forEach((c, index) => {
      const type = categoryType(c.Type);
      if (type === "transfer") {
        categories[c.Id] = { name: cleanName(c.Name), type, action: "skip", reason: "transfers have no category" };
        return;
      }
      const name = c.Type === "Carry" ? CARRY_TARGET : cleanName(c.Name);
      if (!used.categories.get(c.Id)) {
        categories[c.Id] = { name, type, action: "skip", reason: "0 transactions" };
        return;
      }
      const match = activeMatch(
        existing.categories.filter((e) => e.type === type),
        name,
      );
      categories[c.Id] = match
        ? { name, type, action: "match", target: match.name }
        : { name, type, action: "create", icon: iconFor(c.Icon), color: colorFor(c.Colour, index) };
    });

  const mapping: Mapping = {
    currency: existing.currency_code || "EUR",
    accounts,
    categories,
    opening_balances,
    rows_without_account: source.transactions.some((t) => t.ProfileId === null && t.Type !== "Transfer")
      ? { action: "create", name: NO_ACCOUNT }
      : { action: "skip" },
    unpaired_transfers: { action: "import", expense_category: UNPAIRED_EXPENSE, income_category: CARRY_TARGET },
    carry_adjustments: { action: "import", category: CARRY_TARGET },
  };
  const missing = [
    ["expense", UNPAIRED_EXPENSE],
    ["income", CARRY_TARGET],
  ].find(([type, name]) => "error" in findCategoryTarget(mapping, existing, name, type as "expense" | "income"));
  if (missing) {
    mapping.unpaired_transfers = { action: "skip", reason: `no ${missing[0]} category "${missing[1]}"` };
  }
  mapping.carry_adjustments =
    "error" in findCategoryTarget(mapping, existing, CARRY_TARGET, "income")
      ? { action: "skip", reason: `no income category "${CARRY_TARGET}"` }
      : { action: "import", category: CARRY_TARGET };
  return mapping;
}

function describeAction(entry: { action: string; target?: string }): string {
  return entry.action === "match" ? `match "${entry.target}"` : entry.action;
}

/**
 * A saved mapping, with each match that has no existing target replaced by
 * the proposed entry. A target that is archived or that two records share
 * stays, so that validateMapping reports it. changes lists the replaced entries.
 */
export function refreshMapping(
  source: SourceData,
  mapping: Mapping,
  existing: Existing,
): { mapping: Mapping; changes: string[] } {
  const proposed = proposeMapping(source, existing);
  const accounts = { ...mapping.accounts };
  const categories = { ...mapping.categories };
  const changes: string[] = [];
  const missing = (records: Named[], target: string | undefined) =>
    !records.some((r) => sameName(r.name, target ?? ""));

  for (const [id, entry] of Object.entries(accounts)) {
    const next = proposed.accounts[id];
    if (entry.action !== "match" || !next || !missing(existing.accounts, entry.target)) continue;
    accounts[id] = next;
    changes.push(`account ${id} "${entry.name}": "${entry.target}" does not exist, now ${describeAction(next)}`);
  }
  for (const [id, entry] of Object.entries(categories)) {
    const next = proposed.categories[id];
    const records = existing.categories.filter((c) => c.type === entry.type);
    if (entry.action !== "match" || !next || !missing(records, entry.target)) continue;
    categories[id] = next;
    changes.push(`category ${id} "${entry.name}": "${entry.target}" does not exist, now ${describeAction(next)}`);
  }
  return { mapping: { ...mapping, accounts, categories }, changes };
}

/** The errors of a mapping that the user edited. An empty list means buildPlan can use it. */
export function validateMapping(source: SourceData, mapping: Mapping, existing: Existing): string[] {
  const errors: string[] = [];
  if (!/^[A-Z]{3}$/.test(mapping.currency)) errors.push(`currency "${mapping.currency}" is not a 3-letter code`);

  const used = usage(source, new Set(mapping.opening_balances));

  for (const p of source.profiles) {
    const entry = mapping.accounts[p.Id];
    const count = used.profiles.get(p.Id) ?? 0;
    if (!entry) {
      if (count > 0) errors.push(`account ${p.Id}: no entry in the mapping`);
      continue;
    }
    if (entry.action === "skip") {
      if (count > 0) errors.push(`account ${p.Id} "${entry.name}": skip, but ${count} transactions and rules use it`);
    } else if (entry.action === "match") {
      const result = findTarget(existing.accounts, entry.target ?? "");
      if ("error" in result) errors.push(`account ${p.Id}: target ${result.error}`);
    } else if (cleanName(entry.name) === "") {
      errors.push(`account ${p.Id}: the name is empty`);
    }
  }

  for (const c of source.categories) {
    if (c.Type === "Transfer") continue;
    const entry = mapping.categories[c.Id];
    const count = used.categories.get(c.Id) ?? 0;
    if (!entry) {
      if (count > 0) errors.push(`category ${c.Id}: no entry in the mapping`);
      continue;
    }
    if (entry.type !== categoryType(c.Type)) {
      errors.push(`category ${c.Id}: type ${entry.type} is not the backup type ${categoryType(c.Type)}`);
    } else if (entry.action === "skip") {
      if (count > 0) errors.push(`category ${c.Id} "${entry.name}": skip, but ${count} transactions and rules use it`);
    } else if (entry.action === "match") {
      const target = entry.target ?? "";
      const result = findTarget(existing.categories.filter((e) => e.type === entry.type), target);
      if ("error" in result) {
        const other = activeMatch(existing.categories, target);
        errors.push(
          other
            ? `category ${c.Id}: target "${target}" is ${other.type}, not ${entry.type}`
            : `category ${c.Id}: target ${result.error}`,
        );
      }
    } else if (cleanName(entry.name) === "") {
      errors.push(`category ${c.Id}: the name is empty`);
    }
  }

  const carry = new Set(source.categories.filter((c) => c.Type === "Carry").map((c) => c.Id));
  const rows = new Map(source.transactions.map((t) => [t.Id, t]));
  for (const id of mapping.opening_balances) {
    const t = rows.get(id);
    if (!t || t.CategoryId === null || !carry.has(t.CategoryId)) {
      errors.push(`opening_balances: ${id} is not a Carry Over row`);
    }
  }

  const unpaired = mapping.unpaired_transfers;
  if (!unpaired) {
    errors.push("unpaired_transfers: missing; add it, or delete the mapping file to get a new one");
  } else if (unpaired.action === "import") {
    for (const [type, name] of [
      ["expense", unpaired.expense_category],
      ["income", unpaired.income_category],
    ] as const) {
      const result = findCategoryTarget(mapping, existing, name, type);
      if ("error" in result) errors.push(`unpaired_transfers: ${result.error}`);
    }
  }

  const adjustments = mapping.carry_adjustments;
  if (!adjustments) {
    errors.push("carry_adjustments: missing; add it, or delete the mapping file to get a new one");
  } else if (adjustments.action === "import") {
    const result = findCategoryTarget(mapping, existing, adjustments.category, "income");
    if ("error" in result) errors.push(`carry_adjustments: ${result.error}`);
  }

  const without = mapping.rows_without_account;
  if (without.action === "create" && cleanName(without.name) === "") errors.push("rows_without_account: the name is empty");
  if (without.action === "match") {
    const result = findTarget(existing.accounts, without.target);
    if ("error" in result) errors.push(`rows_without_account: target ${result.error}`);
  }
  return errors;
}
