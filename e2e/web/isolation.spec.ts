import { WEB_URL } from "../support/stack.ts";
import {
  addTransaction,
  expect,
  goToPage,
  logIn,
  newAppContext,
  newUser,
  serverTransactionById,
  test,
  transactionRow,
  waitForServerTransaction,
  waitForSynced,
} from "./fixtures.ts";

test("user B never sees the rows of user A and cannot change them", async ({ browser, page }) => {
  const userA = await newUser();
  const userB = await newUser();

  await logIn(page, userA);
  await waitForSynced(page);
  await addTransaction(page, { type: "expense", amount: "99", name: "Secret of A", category: "Gifts" });
  await waitForSynced(page);
  const rowA = await waitForServerTransaction(userA.userId, "Secret of A");

  const b = await newAppContext(browser);
  const tokenB = await logIn(b.page, userB);
  await waitForSynced(b.page);
  await goToPage(b.page, "transactions");
  await expect(transactionRow(b.page, "Secret of A")).toHaveCount(0);
  await goToPage(b.page, "spending");
  await expect(b.page.getByTestId("chalkboard-summary").filter({ visible: true })).toHaveAttribute(
    "aria-label",
    "Income 0 euro, expense 0 euro, balance 0 euro",
  );

  // A forged upload with the record ID of A, sent with the session of B.
  const res = await b.page.request.post(`${WEB_URL}/api/sync/upload`, {
    headers: { Authorization: `Bearer ${tokenB}` },
    data: {
      schema_version: 1,
      ops: [{ op: "PATCH", table: "transactions", id: rowA.id, data: { name: "Changed by B" } }],
    },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { rejected: { index: number; code: string }[] };
  expect(body.rejected).toEqual([expect.objectContaining({ index: 0, code: "forbidden" })]);
  expect(serverTransactionById(rowA.id)?.name).toBe("Secret of A");

  await b.context.close();
});
