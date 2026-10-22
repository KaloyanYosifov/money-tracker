import { existingFixture, row, sourceFixture, ticks } from "./fixtures";
import { proposeMapping, validateMapping } from "./mapping";

describe("proposeMapping", () => {
  it("takes the currency of the user, or EUR", () => {
    expect(proposeMapping(sourceFixture(), existingFixture()).currency).toBe("EUR");
    const existing = { ...existingFixture(), currency_code: "" };
    expect(proposeMapping(sourceFixture(), existing).currency).toBe("EUR");
    expect(proposeMapping(sourceFixture(), { ...existingFixture(), currency_code: "BGN" }).currency).toBe("BGN");
  });

  it("creates the used accounts and skips the unused ones", () => {
    const { accounts } = proposeMapping(sourceFixture(), existingFixture());
    expect(accounts[2]).toEqual({ name: "Bank A", action: "create", color: "#AABBCC" });
    expect(accounts[1]).toEqual({ name: "Default", action: "skip", reason: "0 transactions" });
  });

  it("matches an account by name", () => {
    const source = sourceFixture();
    source.profiles.push({ Id: 9, Name: "wallet ", Colour: "" });
    source.transactions.push(row({ Id: 900, ProfileId: 9 }));
    expect(proposeMapping(source, existingFixture()).accounts[9]).toEqual({
      name: "wallet",
      action: "match",
      target: "Wallet",
    });
  });

  it("matches, creates and skips categories", () => {
    const { categories } = proposeMapping(sourceFixture(), existingFixture());
    expect(categories[4]).toEqual({ name: "Eating Out", type: "expense", action: "match", target: "Eating Out" });
    expect(categories[25]).toMatchObject({ name: "Pet food", type: "expense", action: "create", icon: "cart" });
    expect(categories[30]).toMatchObject({ name: "Sale", type: "expense", action: "create" });
    expect(categories[31]).toMatchObject({ name: "Sale", type: "income", action: "create" });
    expect(categories[5]).toEqual({ name: "Kids", type: "expense", action: "skip", reason: "0 transactions" });
    expect(categories[14]).toEqual({
      name: "Transfer",
      type: "transfer",
      action: "skip",
      reason: "transfers have no category",
    });
  });

  it("counts a row in a category of another type under the category of its type", () => {
    const source = sourceFixture();
    source.transactions = source.transactions.filter((t) => t.Id !== 105);
    source.transactions.push(row({ Id: 106, Type: "Expense", Amount: 2, ProfileId: 4, CategoryId: 31 }));
    source.transactions = source.transactions.filter((t) => t.Id !== 104);
    const { categories } = proposeMapping(source, existingFixture());
    expect(categories[30]).toMatchObject({ action: "create" });
    expect(categories[31]).toMatchObject({ action: "skip", reason: "0 transactions" });
  });

  it("maps the Carry Over category to Other income", () => {
    expect(proposeMapping(sourceFixture(), existingFixture()).categories[15]).toEqual({
      name: "Other income",
      type: "income",
      action: "match",
      target: "Other income",
    });

    const existing = existingFixture();
    existing.categories = existing.categories.filter((c) => c.name !== "Other income");
    expect(proposeMapping(sourceFixture(), existing).categories[15]).toMatchObject({
      name: "Other income",
      type: "income",
      action: "create",
    });
  });

  it("does not match archived records", () => {
    const existing = existingFixture();
    existing.categories = existing.categories.map((c) => (c.name === "Eating Out" ? { ...c, archived: true } : c));
    expect(proposeMapping(sourceFixture(), existing).categories[4]).toMatchObject({ action: "create" });
  });

  it("proposes the earliest Carry Over row of each account as its opening balance", () => {
    expect(proposeMapping(sourceFixture(), existingFixture()).opening_balances).toEqual([110, 113]);

    const source = sourceFixture();
    source.transactions.push(row({ Id: 109, Type: "Income", Amount: 1, CategoryId: 15, Date: ticks("2024-01-01") }));
    expect(proposeMapping(source, existingFixture()).opening_balances).toEqual([109, 113]);
  });

  it("imports unpaired transfers into General and Other income, or skips them when a category is missing", () => {
    expect(proposeMapping(sourceFixture(), existingFixture()).unpaired_transfers).toEqual({
      action: "import",
      expense_category: "General",
      income_category: "Other income",
    });
    const existing = existingFixture();
    existing.categories = existing.categories.filter((c) => c.name !== "General");
    expect(proposeMapping(sourceFixture(), existing).unpaired_transfers).toEqual({
      action: "skip",
      reason: 'no expense category "General"',
    });
  });

  it("proposes carry adjustments in Other income", () => {
    expect(proposeMapping(sourceFixture(), existingFixture()).carry_adjustments).toEqual({
      action: "import",
      category: "Other income",
    });
  });

  it("skips rows without an account", () => {
    expect(proposeMapping(sourceFixture(), existingFixture()).rows_without_account).toEqual({ action: "skip" });
  });
});

describe("validateMapping", () => {
  const source = sourceFixture();
  const existing = existingFixture();
  const proposed = () => proposeMapping(source, existing);

  it("accepts the proposed mapping", () => {
    expect(validateMapping(source, proposed(), existing)).toEqual([]);
  });

  it("rejects a match target that does not exist, is archived or has the wrong type", () => {
    const mapping = proposed();
    mapping.accounts[2] = { name: "Bank A", action: "match", target: "Nowhere" };
    mapping.categories[25] = { name: "Pet food", type: "expense", action: "match", target: "Salary" };
    const archived = existingFixture();
    archived.categories = archived.categories.map((c) => (c.name === "Eating Out" ? { ...c, archived: true } : c));

    const errors = validateMapping(source, mapping, archived);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/account 2: .*"Nowhere" does not exist/),
        expect.stringMatching(/category 25: .*"Salary" is income, not expense/),
        expect.stringMatching(/category 4: .*"Eating Out" is archived/),
      ]),
    );
  });

  it("rejects a category type that is not the type in the backup", () => {
    const mapping = proposed();
    mapping.categories[15] = { name: "Rent", type: "expense", action: "match", target: "Rent" };
    expect(validateMapping(source, mapping, existing)).toEqual([expect.stringMatching(/category 15: type expense/)]);
  });

  it("rejects a target name that two records share", () => {
    const twice = existingFixture();
    twice.accounts.push({ id: "6b2a0a9c-bf9e-4f6c-8a91-738495a6b7c7", name: "wallet", sort_order: 2, opening_balance_minor: 0, archived: false });
    const mapping = proposed();
    mapping.accounts[2] = { name: "Bank A", action: "match", target: "Wallet" };
    expect(validateMapping(source, mapping, twice)).toEqual([expect.stringMatching(/account 2: .*matches 2/)]);
  });

  it("rejects a skip of a used account or category with the count", () => {
    const mapping = proposed();
    mapping.accounts[4] = { name: "Cash", action: "skip" };
    mapping.categories[25] = { name: "Pet food", type: "expense", action: "skip" };
    expect(validateMapping(source, mapping, existing)).toEqual([
      expect.stringMatching(/account 4 .*2 transactions/),
      expect.stringMatching(/category 25 .*1 transactions/),
    ]);
  });

  it("rejects an opening balance that is not a Carry Over row", () => {
    const mapping = proposed();
    mapping.opening_balances = [110, 101];
    expect(validateMapping(source, mapping, existing)).toEqual([expect.stringMatching(/101 is not a Carry Over row/)]);
  });

  it("rejects a currency that is not a 3-letter code", () => {
    const mapping = { ...proposed(), currency: "eur" };
    expect(validateMapping(source, mapping, existing)).toEqual([expect.stringMatching(/currency/)]);
  });

  it("rejects a mapping without unpaired_transfers or with an unknown category", () => {
    const old = proposed() as Partial<ReturnType<typeof proposed>>;
    delete old.unpaired_transfers;
    expect(validateMapping(source, old as ReturnType<typeof proposed>, existing)).toEqual([
      expect.stringMatching(/unpaired_transfers: missing/),
    ]);
    const mapping = proposed();
    mapping.unpaired_transfers = { action: "import", expense_category: "Nowhere", income_category: "Other income" };
    expect(validateMapping(source, mapping, existing)).toEqual([expect.stringMatching(/unpaired_transfers: expense category/)]);
  });

  it("rejects a mapping without carry_adjustments", () => {
    const old = proposed() as Partial<ReturnType<typeof proposed>>;
    delete old.carry_adjustments;
    expect(validateMapping(source, old as ReturnType<typeof proposed>, existing)).toEqual([
      expect.stringMatching(/carry_adjustments: missing/),
    ]);
  });

  it("rejects a rows_without_account target that does not exist", () => {
    const mapping = proposed();
    mapping.rows_without_account = { action: "match", target: "Nowhere" };
    expect(validateMapping(source, mapping, existing)).toEqual([expect.stringMatching(/rows_without_account/)]);
  });
});
