import { act, fireEvent, render, screen, within } from "@testing-library/react-native";

import { createTestDatabase, loadFixture, type TestDatabase } from "../../../test/sqlite";
import * as insights from "../../data/insights";
import { amountInputText } from "../../domain/money";
import type { LayoutMode } from "../../hooks/useLayoutMode";
import { InsightsScreen } from "./Insights";

let mockDb: TestDatabase;
let mockMode: LayoutMode = "tabs";

// The hooks run their SQL against the in-memory fixture database, and the
// mutations write to it.
jest.mock("@powersync/react", () => ({
  useQuery: (sql: string, parameters: unknown[] = []) => ({
    data: mockDb.prepare(sql).all(parameters),
    isLoading: false,
  }),
  usePowerSync: () => jest.requireActual("../../../test/sqlite").asyncDatabase(mockDb),
}));

jest.mock("../../hooks/useLayoutMode", () => ({
  ...jest.requireActual("../../hooks/useLayoutMode"),
  useLayoutMode: () => mockMode,
}));

const TODAY = "2026-10-24";

const userSettings = {
  id: "s1",
  user_id: "u1",
  currency_code: "EUR",
  time_period: "monthly",
  week_start_day: 1,
  month_start_day: 1,
  year_start_month: 1,
  budget_mode: false,
  carry_over: true,
  hide_future: false,
  show_note: true,
  theme: "light",
  summary_font: "mono",
  icon_style: "filled",
  insights_enabled: true,
};

const categories = [
  { id: "food", user_id: "u1", type: "expense", name: "Groceries", icon: "groceries", color: "#5aa454", sort_order: 0 },
  { id: "music", user_id: "u1", type: "expense", name: "Music", icon: "cart", color: "#2f8fd8", sort_order: 1 },
  { id: "salary", user_id: "u1", type: "income", name: "Salary", icon: "piggy", color: "#3b9d3b", sort_order: 2 },
];

const accounts = [{ id: "wallet", user_id: "u1", name: "Wallet", color: "#8a5a44", sort_order: 0 }];

function card(id: string, kind: string, createdAt: string, action: unknown, status = "open") {
  return {
    id,
    user_id: "u1",
    kind,
    title: `Title ${id}`,
    body: `Body ${id}`,
    fingerprint: `fp-${id}`,
    status,
    action: action === null ? null : JSON.stringify(action),
    created_at: createdAt,
    updated_at: createdAt,
  };
}

const budgetAction = { category_id: "food", amount_minor: 30000 };
const recurringAction = {
  type: "expense",
  category_id: "music",
  account_id: "wallet",
  amount_minor: 1099,
  frequency: "monthly",
  start_date: "2026-11-03",
  name: "Spotify",
};

const cards = [
  card("tip", "tip", "2026-10-20T06:00:00Z", null),
  card("budget", "budget", "2026-10-22T06:02:00Z", budgetAction),
  card("rule", "recurring_rule", "2026-10-21T06:00:00Z", recurringAction),
  card("old", "tip", "2026-10-23T06:00:00Z", null, "dismissed"),
];

const questions = [
  { id: "q-pending", user_id: "u1", category_id: "food", question: "Why is food higher?", status: "pending" },
  {
    id: "q-answered",
    user_id: "u1",
    category_id: "food",
    question: "How much a week?",
    answer: "About 74 EUR a week.",
    action: JSON.stringify({ category_id: "food", amount_minor: 8000 }),
    status: "answered",
    created_at: "2026-10-23T09:00:00Z",
    answered_at: "2026-10-23T09:01:00Z",
  },
  {
    id: "q-failed",
    user_id: "u1",
    category_id: "food",
    question: "Compare with last year",
    status: "failed",
    error: "AI is not available now. Try again later.",
    created_at: "2026-10-19T09:00:00Z",
  },
  { id: "q-music", user_id: "u1", category_id: "music", question: "Is Music fine?", answer: "Yes.", status: "answered", created_at: "2026-10-18T09:00:00Z" },
];

function load(withCards = cards) {
  loadFixture(mockDb, { user_settings: [userSettings], categories, accounts, insights: withCards, insight_questions: questions });
}

beforeEach(() => {
  mockMode = "tabs";
  mockDb = createTestDatabase();
});

afterEach(() => jest.restoreAllMocks());

function row(table: string, id: string) {
  return mockDb.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
}

async function pickCategory(name: string) {
  await fireEvent.press(screen.getByTestId("ask-category"));
  await fireEvent.press(screen.getByTestId(`ask-category-${name}`));
}

describe("InsightsScreen suggestions", () => {
  it("shows the open cards newest first and the last run time", async () => {
    load();
    await render(<InsightsScreen today={TODAY} />);

    const ids = screen.getAllByTestId(/^insight-card-/).map((c) => c.props.testID);
    expect(ids).toEqual(["insight-card-budget", "insight-card-rule", "insight-card-tip"]);
    expect(screen.getByTestId("insights-last-run")).toHaveTextContent(/^Updated /);
    expect(screen.queryByText("Title old")).toBeNull();
  });

  it("shows the buttons of each card kind", async () => {
    load();
    await render(<InsightsScreen today={TODAY} />);

    const tip = within(screen.getByTestId("insight-card-tip"));
    expect(tip.getByRole("button", { name: "Dismiss" })).toBeOnTheScreen();
    expect(tip.getAllByRole("button")).toHaveLength(1);

    const budget = within(screen.getByTestId("insight-card-budget"));
    expect(budget.getByRole("button", { name: "Set budget" })).toBeOnTheScreen();
    expect(budget.getByRole("button", { name: "Dismiss" })).toBeOnTheScreen();

    const rule = within(screen.getByTestId("insight-card-rule"));
    expect(rule.getByRole("button", { name: "Add recurring rule" })).toBeOnTheScreen();
    expect(rule.getByRole("button", { name: "Dismiss" })).toBeOnTheScreen();
  });

  it("opens the accept sheet with the values of a budget card and saves it", async () => {
    load();
    const spy = jest.spyOn(insights, "acceptBudgetCard");
    await render(<InsightsScreen today={TODAY} />);

    await fireEvent.press(within(screen.getByTestId("insight-card-budget")).getByRole("button", { name: "Set budget" }));
    expect(screen.getByText("Budget for Groceries")).toBeOnTheScreen();
    expect(screen.getByTestId("accept-category")).toHaveTextContent("Groceries");
    expect(screen.getByLabelText("Amount").props.value).toBe(amountInputText(30000, "EUR"));

    await fireEvent.changeText(screen.getByLabelText("Amount"), amountInputText(25000, "EUR"));
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Save" })));

    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "budget" }), 25000);
    expect(row("insights", "budget")?.status).toBe("accepted");
    expect(mockDb.prepare("SELECT amount_minor FROM budgets WHERE category_id = 'food'").get()).toEqual({ amount_minor: 25000 });
    expect(screen.queryByText("Budget for Groceries")).toBeNull();
  });

  it("opens the accept sheet of a recurring rule card and saves it", async () => {
    load();
    const spy = jest.spyOn(insights, "acceptRecurringCard");
    await render(<InsightsScreen today={TODAY} />);

    await fireEvent.press(within(screen.getByTestId("insight-card-rule")).getByRole("button", { name: "Add recurring rule" }));
    expect(screen.getByLabelText("Name").props.value).toBe("Spotify");
    expect(screen.getByLabelText("Amount").props.value).toBe(amountInputText(1099, "EUR"));
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Save" })));

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "rule" }),
      TODAY,
      { name: "Spotify", amount_minor: 1099, account_id: "wallet" },
    );
    expect(row("insights", "rule")?.status).toBe("accepted");
  });

  it("shows the accept sheet as a centered card on the wide layout", async () => {
    mockMode = "sidebar";
    load();
    await render(<InsightsScreen today={TODAY} />);

    await fireEvent.press(within(screen.getByTestId("insight-card-budget")).getByRole("button", { name: "Set budget" }));
    expect(screen.getByTestId("accept-sheet-card")).toBeOnTheScreen();
  });

  it("dismisses a card", async () => {
    load();
    const spy = jest.spyOn(insights, "dismissCard");
    await render(<InsightsScreen today={TODAY} />);

    await act(async () => fireEvent.press(within(screen.getByTestId("insight-card-tip")).getByRole("button", { name: "Dismiss" })));
    expect(spy).toHaveBeenCalledWith(expect.anything(), "tip");
    expect(row("insights", "tip")?.status).toBe("dismissed");
  });

  it("shows an empty state with no open cards", async () => {
    load([]);
    await render(<InsightsScreen today={TODAY} />);

    expect(screen.getByText("No suggestions yet.")).toBeOnTheScreen();
    expect(screen.getByTestId("insights-last-run")).toHaveTextContent("No run yet");
  });
});

describe("InsightsScreen questions", () => {
  it("asks a question about the selected category and clears the field", async () => {
    load();
    const spy = jest.spyOn(insights, "askQuestion");
    await render(<InsightsScreen today={TODAY} />);

    await pickCategory("Music");
    await fireEvent.changeText(screen.getByLabelText("Question"), "  Where can I save?  ");
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Ask" })));

    expect(spy).toHaveBeenCalledWith(expect.anything(), "music", "  Where can I save?  ");
    expect(screen.getByLabelText("Question").props.value).toBe("");
    expect(mockDb.prepare("SELECT question, status FROM insight_questions WHERE category_id = 'music' AND id != 'q-music'").get()).toEqual({
      question: "Where can I save?",
      status: "pending",
    });
  });

  it("shows pending, answered and failed questions of the category, and asks a failed one again", async () => {
    load();
    const spy = jest.spyOn(insights, "askQuestion");
    await render(<InsightsScreen today={TODAY} />);
    await pickCategory("Groceries");

    expect(within(screen.getByTestId("question-q-pending")).getByText("Waiting for answer")).toBeOnTheScreen();
    expect(within(screen.getByTestId("question-q-answered")).getByText("About 74 EUR a week.")).toBeOnTheScreen();
    const failed = within(screen.getByTestId("question-q-failed"));
    expect(failed.getByText("AI is not available now. Try again later.")).toBeOnTheScreen();
    expect(screen.queryByTestId("question-q-music")).toBeNull();

    await act(async () => fireEvent.press(failed.getByRole("button", { name: "Ask again" })));
    expect(spy).toHaveBeenCalledWith(expect.anything(), "food", "Compare with last year");
  });

  it("shows an inline accept card for an answer with an action", async () => {
    load();
    const spy = jest.spyOn(insights, "acceptBudgetCard");
    await render(<InsightsScreen today={TODAY} />);
    await pickCategory("Groceries");

    const answered = within(screen.getByTestId("question-q-answered"));
    expect(answered.getByTestId("answer-action")).toHaveTextContent(/Groceries/);
    await fireEvent.press(answered.getByRole("button", { name: "Set budget" }));
    expect(screen.getByLabelText("Amount").props.value).toBe(amountInputText(8000, "EUR"));
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Save" })));

    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "q-answered", kind: "budget" }), 8000);
    expect(mockDb.prepare("SELECT amount_minor FROM budgets WHERE category_id = 'food'").get()).toEqual({ amount_minor: 8000 });
    expect(screen.queryByTestId("answer-action")).toBeNull();
  });
});
