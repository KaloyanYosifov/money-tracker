/**
 * The cross-app scenarios: one user on the iOS simulator (Maestro) and in
 * Playwright Chromium. The iOS app talks to the stack through its own
 * Toxiproxy pair, so that iOS can go offline while the web stays online.
 */
import type { Page } from "@playwright/test";

import { query } from "../support/db.ts";
import { goOffline, goOnline, type ProxyName } from "../support/toxiproxy.ts";
import type { TestUser } from "../support/users.ts";
import {
  deleteWithKey,
  expect,
  goToPage,
  openTransaction,
  serverTransactionById,
  transactionRow,
  waitForSynced,
} from "../web/fixtures.ts";

export const IOS_PROXIES: ProxyName[] = ["api_ios", "powersync_ios"];

export interface CrossContext {
  user: TestUser;
  page: Page;
  /** Runs a flow from app/e2e/maestro on the iOS simulator. */
  maestro: (flow: string, env: Record<string, string>) => void;
}

const NAME = "Cross Taxi";
const CATEGORY = "Groceries";

/** The server row of the scenario transaction. Scenario 1 sets it. */
let rowId = "";

function serverAmount(id: string): number | null {
  const row = query("SELECT amount_minor FROM transactions WHERE id = :'id';", { id })[0];
  return row ? Number(row[0]) : null;
}

/** Sets the amount of a transaction on the web, in whole euros. */
async function editAmountOnWeb(page: Page, name: string, euros: string): Promise<void> {
  await openTransaction(page, name);
  await page.getByLabel("Amount", { exact: true }).fill(euros);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Edit Transaction" })).toBeHidden();
}

async function withIosOffline(work: () => Promise<void>): Promise<void> {
  await goOffline(IOS_PROXIES);
  try {
    await work();
  } finally {
    await goOnline(IOS_PROXIES);
  }
}

/** 1. An expense added on iOS shows on the web within 10 seconds. */
export async function addOnIosShowsOnWeb({ user, page, maestro }: CrossContext): Promise<void> {
  await goToPage(page, "transactions");
  maestro("cross-add-expense.yaml", { NAME, AMOUNT: "7", CATEGORY });
  await expect(transactionRow(page, NAME)).toBeVisible({ timeout: 10_000 });

  const rows = query("SELECT id FROM transactions WHERE user_id = :'user_id' AND name = :'name';", {
    user_id: user.userId,
    name: NAME,
  });
  expect(rows).toHaveLength(1);
  rowId = rows[0][0];
  expect(serverAmount(rowId)).toBe(700);
}

/** 2. The web edits the amount and offline iOS edits the note. Both edits survive on both devices. */
export async function editsOnBothSurvive({ page, maestro }: CrossContext): Promise<void> {
  const note = "Note from iOS";
  await withIosOffline(async () => {
    await editAmountOnWeb(page, NAME, "12");
    await expect.poll(() => serverAmount(rowId), { timeout: 30_000 }).toBe(1200);
    maestro("cross-edit-note.yaml", { NAME, NOTE: note });
  });

  await expect.poll(() => serverTransactionById(rowId), { timeout: 60_000 }).toEqual({ name: NAME, note });
  expect(serverAmount(rowId)).toBe(1200);

  await waitForSynced(page);
  await openTransaction(page, NAME);
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("12.00");
  await expect(page.getByPlaceholder("Add a note", { exact: true })).toHaveValue(note);
  await page.getByRole("button", { name: "Close" }).click();

  maestro("cross-check-row.yaml", { PHASE: "present", NAME, AMOUNT: "12", NOTE: note });
}

/** 3. The web deletes the row while offline iOS edits it. The row is gone on both devices. */
export async function deleteWinsOverOfflineEdit({ page, maestro }: CrossContext): Promise<void> {
  await withIosOffline(async () => {
    maestro("cross-edit-note.yaml", { NAME, NOTE: "Edited offline" });
    await goToPage(page, "transactions");
    await deleteWithKey(page, NAME);
    // The real delete runs after the 5-second undo window.
    await expect.poll(() => serverTransactionById(rowId), { timeout: 30_000 }).toBeNull();
  });

  maestro("cross-check-row.yaml", { PHASE: "gone", NAME, AMOUNT: "", NOTE: "" });
  expect(serverTransactionById(rowId)).toBeNull();
  await waitForSynced(page);
  await goToPage(page, "transactions");
  await expect(transactionRow(page, NAME)).toHaveCount(0);
}

export const scenarios = [addOnIosShowsOnWeb, editsOnBothSurvive, deleteWinsOverOfflineEdit];
