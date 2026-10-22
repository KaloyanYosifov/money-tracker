import type { Existing, SourceData, SourceTransaction } from "./types.ts";

// Synthetic test data for the parser tests. It has no rows of a real backup.

const EPOCH_TICKS = 621355968000000000n;

/** .NET ticks at UTC midnight of a YYYY-MM-DD date. */
export function ticks(date: string): bigint {
  return EPOCH_TICKS + BigInt(Date.parse(`${date}T00:00:00Z`)) * 10000n;
}

export function row(fields: Partial<SourceTransaction> & Pick<SourceTransaction, "Id">): SourceTransaction {
  return {
    Type: "Expense",
    Date: ticks("2026-09-01"),
    Amount: 1,
    Note: null,
    ProfileId: 2,
    CategoryId: 4,
    RecurringTransactionId: null,
    ...fields,
  };
}

export function sourceFixture(): SourceData {
  return {
    profiles: [
      { Id: 1, Name: "Default", Colour: "" },
      { Id: 2, Name: "Bank A", Colour: "AABBCC" },
      { Id: 3, Name: "Card B", Colour: "" },
      { Id: 4, Name: "Cash", Colour: null },
    ],
    categories: [
      { Id: 1, Name: "Salary", Type: "Income", Icon: "119-piggy-bank", Colour: "" },
      { Id: 4, Name: "Eating Out", Type: "Expense", Icon: "48-fork-and-knife", Colour: "" },
      { Id: 5, Name: "Kids", Type: "Expense", Icon: "76-baby", Colour: "" },
      { Id: 14, Name: "Transfer", Type: "Transfer", Icon: "", Colour: "" },
      { Id: 15, Name: "Carry Over", Type: "Carry", Icon: "", Colour: "" },
      { Id: 25, Name: "Pet food ", Type: "Expense", Icon: "80-shopping-cart", Colour: "" },
      { Id: 30, Name: "Sale", Type: "Expense", Icon: "172-pricetag", Colour: "" },
      { Id: 31, Name: "Sale", Type: "Income", Icon: "172-pricetag", Colour: "" },
    ],
    transactions: [
      row({ Id: 101, Amount: 12.5, Note: "Lunch", Date: ticks("2026-09-01") }),
      row({ Id: 102, Type: "Income", Amount: 1000, Note: "Pay", CategoryId: 1, Date: ticks("2026-09-02") }),
      row({ Id: 103, Amount: 5, Note: "Dog food", ProfileId: 3, CategoryId: 25, Date: ticks("2026-09-03") }),
      row({ Id: 104, Amount: 3, Note: "Old lamp", ProfileId: 4, CategoryId: 30, Date: ticks("2026-09-04") }),
      row({ Id: 105, Type: "Income", Amount: 4, Note: "Old chair", ProfileId: 4, CategoryId: 31, Date: ticks("2026-09-04") }),
      // Carry Over rows: 110 and 113 are the earliest of their account, 112 is a later one.
      row({ Id: 110, Type: "Income", Amount: 100, Note: "Start", CategoryId: 15, Date: ticks("2024-01-01") }),
      row({ Id: 112, Type: "Income", Amount: 20, Note: "Found", CategoryId: 15, Date: ticks("2024-06-01") }),
      row({ Id: 113, Type: "Income", Amount: 30, Note: "Start", ProfileId: 3, CategoryId: 15, Date: ticks("2024-02-01") }),
      row({ Id: 120, Amount: 7, Note: "No account", ProfileId: null, Date: ticks("2026-09-08") }),
      // A transfer of 50.00 from Card B to Bank A.
      row({ Id: 201, Type: "Transfer", Amount: -50, ProfileId: 3, CategoryId: 14, Date: ticks("2026-09-05") }),
      row({ Id: 202, Type: "Transfer", Amount: 50, ProfileId: 2, CategoryId: 14, Date: ticks("2026-09-05") }),
      // The rows of recurring rule 1, monthly from 2026-07-31.
      row({ Id: 301, Amount: 9.99, Note: "Streaming", RecurringTransactionId: 1, Date: ticks("2026-07-31") }),
      row({ Id: 302, Amount: 9.99, Note: "Streaming", RecurringTransactionId: 1, Date: ticks("2026-08-31") }),
      row({ Id: 303, Amount: 9.99, Note: "Streaming", RecurringTransactionId: 1, Date: ticks("2026-09-30") }),
      row({ Id: 304, Amount: 9.99, Note: "Streaming", RecurringTransactionId: 1, Date: ticks("2026-10-31") }),
      row({ Id: 305, Amount: 9.99, Note: "Streaming extra", RecurringTransactionId: 1, Date: ticks("2026-08-15") }),
    ],
    strategies: [{ ProfileId: null, CarryPositiveOnly: 0 }],
    recurring: [
      {
        Id: 1,
        Type: "Expense",
        Date: ticks("2026-07-31"),
        EndDate: null,
        Amount: 9.99,
        Note: "Streaming",
        RecurringType: "Monthly",
        RecurringPeriod: 1,
        ProfileId: 2,
        CategoryId: 4,
      },
    ],
  };
}

export const USER_ID = "7d1f3a52-1c7e-4c43-9a55-2f0f6a1b9e10";
export const WALLET_ID = "0b6a4a36-5f3e-4f0c-8a3b-1d2e3f405061";
export const BANK_ID = "1c7b5b47-6a4f-4a1d-9b4c-2e3f40516272";
export const EATING_OUT_ID = "2d8c6c58-7b5a-4b2e-8c5d-3f4051627383";
export const SALARY_ID = "3e9d7d69-8c6b-4c3f-9d6e-405162738494";
export const OTHER_INCOME_ID = "4f0e8e7a-9d7c-4d4a-8e7f-5162738495a5";
export const RENT_ID = "5a1f9f8b-ae8d-4e5b-9f80-62738495a6b6";
export const GENERAL_ID = "6c2a0a9c-bf9e-4f6c-9a91-738495a6b7d8";

export function existingFixture(): Existing {
  return {
    currency_code: "EUR",
    accounts: [
      { id: WALLET_ID, name: "Wallet", sort_order: 0, opening_balance_minor: 0, archived: false },
      { id: BANK_ID, name: "Bank", sort_order: 1, opening_balance_minor: 0, archived: false },
    ],
    categories: [
      { id: EATING_OUT_ID, name: "Eating Out", type: "expense", sort_order: 0, archived: false },
      { id: SALARY_ID, name: "Salary", type: "income", sort_order: 1, archived: false },
      { id: OTHER_INCOME_ID, name: "Other income", type: "income", sort_order: 2, archived: false },
      { id: RENT_ID, name: "Rent", type: "expense", sort_order: 3, archived: false },
      { id: GENERAL_ID, name: "General", type: "expense", sort_order: 4, archived: false },
    ],
  };
}
