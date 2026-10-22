import { v5 } from "uuid";

import { minorUnits } from "../../domain/money.ts";
import { PALETTE } from "../../ui/palette.ts";

// Namespace for all import IDs. Do not change it: a second import of the same
// backup must derive the same IDs, so that it updates the rows of the first.
export const IMPORT_NAMESPACE = "be0a0f23-688b-4f22-99f7-21a4c396f209";

// .NET ticks (100 ns since 0001-01-01) at the Unix epoch.
const EPOCH_TICKS = 621355968000000000n;
const TICKS_PER_MS = 10000n;

/** The UTC date of .NET ticks as YYYY-MM-DD. */
export function ticksToDate(ticks: number | bigint): string {
  const ms = (BigInt(ticks) - EPOCH_TICKS) / TICKS_PER_MS;
  return new Date(Number(ms)).toISOString().slice(0, 10);
}

/** A float amount of the backup as positive minor units. */
export function toMinor(amount: number, currency: string): number {
  return Math.round(Math.abs(amount) * 10 ** minorUnits(currency));
}

/**
 * The import ID of a source row for one user, for example importId("transaction", 101, userId).
 * The user is part of the name, because two backups have the same small source IDs.
 */
export function importId(kind: string, sourceId: number | string, userId: string): string {
  return v5(`st:${userId}:${kind}:${sourceId}`, IMPORT_NAMESPACE);
}

const ICONS: Record<string, string> = {
  "80-shopping-cart": "cart",
  "67-tshirt": "shirt",
  "48-fork-and-knife": "fork",
  "76-baby": "baby",
  "24-gift": "gift",
  "47-fuel": "car",
  "37-suitcase": "plane",
  "15-bus": "bus",
  "31-ipod": "music",
  "63-runner": "sport",
  "172-pricetag": "tag",
  "119-piggy-bank": "piggy",
  "125-food": "groceries",
  "33-cabinet": "home",
  "161-calculator": "calculator",
  "96-book": "book",
  gas: "flame",
  "237-key": "key",
  "185-printer": "tax",
  tax: "tax",
  "154-necktie": "shirt",
  "178-city": "home",
};

export const ICON_KEYS: readonly string[] = Object.values(ICONS);

/** The app icon key for a Spending Tracker icon name. */
export function iconFor(stIcon: string | null): string {
  return (stIcon !== null && ICONS[stIcon]) || "tag";
}

/** The hex colour of the backup with a "#", or a palette colour by index. */
export function colorFor(stColour: string | null, index: number): string {
  if (stColour !== null && /^[0-9a-fA-F]{6}$/.test(stColour)) return `#${stColour}`;
  return PALETTE[index % PALETTE.length].hex;
}

const MAX_NAME = 120;

/** A transaction name from a note: the first 120 characters. A longer note also stays as the note. */
export function splitNote(text: string | null): { name: string; note: string | null } {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= MAX_NAME) return { name: trimmed, note: null };
  return { name: trimmed.slice(0, MAX_NAME), note: trimmed };
}

/** An account or category name: trimmed, at most 60 characters. */
export function cleanName(name: string | null): string {
  return (name ?? "").trim().slice(0, 60);
}

export function sameName(a: string | null, b: string | null): boolean {
  return cleanName(a).toLowerCase() === cleanName(b).toLowerCase();
}
