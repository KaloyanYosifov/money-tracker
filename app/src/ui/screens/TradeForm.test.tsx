import { fireEvent, render, screen } from "@testing-library/react-native";

import type { InstrumentDetail, PortfolioHolding, TradeRow } from "../../data/portfolio";
import { toFixed } from "../../domain/decimal";
import { TradeForm } from "./TradeForm";

let mockDetail: InstrumentDetail | null = null;
jest.mock("../../data/portfolio", () => ({
  useInstrument: () => ({ data: mockDetail, isLoading: false }),
}));

let mockTrades: (TradeRow & { user_id: string })[] = [];
jest.mock("@powersync/react", () => ({
  useQuery: (sql: string, parameters: unknown[] = []) =>
    sql.includes("FROM trades")
      ? { data: mockTrades.filter((t) => t.id === parameters[0]), isLoading: false }
      : { data: [{ id: "s1", currency_code: "EUR", theme: "light", week_start_day: 1 }], isLoading: false },
  usePowerSync: () => ({}),
}));

const mockSaveTrade = jest.fn();
const mockDeleteTrade = jest.fn();
jest.mock("../../data/mutations", () => ({
  saveTrade: (...args: unknown[]) => mockSaveTrade(...args),
  deleteTrade: (...args: unknown[]) => mockDeleteTrade(...args),
}));

const mockConfirm = jest.fn();
jest.mock("../../data/session", () => ({
  confirmDialog: (...args: unknown[]) => mockConfirm(...args),
}));

jest.mock("../../hooks/useShortcuts", () => ({ useShortcuts: () => {} }));

const f = (text: string) => toFixed(text) as bigint;

const buys: TradeRow[] = [
  { id: "t1", instrument_id: "acme", side: "buy", date: "2026-03-14", quantity: "8", price: "172.5", fee: "1", note: null },
  { id: "t2", instrument_id: "acme", side: "buy", date: "2026-09-02", quantity: "4", price: "189.2", fee: "1", note: "Top up" },
];

function detail(trades: TradeRow[]): InstrumentDetail {
  const holding = {
    instrumentId: "acme",
    symbol: "ACME",
    name: "Acme Corp",
    exchange: "NASDAQ",
    kind: "stock",
    quoteCurrency: "USD",
    quantity: f("12"),
    prices: [
      { date: "2026-10-29", close: f("228.1") },
      { date: "2026-10-31", close: f("231.4") },
    ],
  } as PortfolioHolding;
  return {
    instrument: { id: "acme", symbol: "ACME", name: "Acme Corp", exchange: "NASDAQ", kind: "stock", quote_currency: "USD" } as InstrumentDetail["instrument"],
    holding,
    trades,
  };
}

beforeEach(() => {
  mockDetail = detail([...buys].reverse());
  mockTrades = buys.map((t) => ({ ...t, user_id: "u1" }));
  mockSaveTrade.mockReset().mockResolvedValue({ ok: true, id: "new-id" });
  mockDeleteTrade.mockReset().mockResolvedValue({ ok: true, id: "t2" });
  mockConfirm.mockReset().mockResolvedValue(true);
});

function renderNew(onClose = jest.fn()) {
  return render(<TradeForm id={null} instrumentId="acme" platform="ios" today="2026-10-31" onClose={onClose} />);
}

function saveButton() {
  return screen.getByRole("button", { name: "Save" });
}

describe("TradeForm", () => {
  it("starts a new trade as a buy of today with the close of today as the price", async () => {
    await renderNew();

    expect(screen.getByText("New trade")).toBeTruthy();
    expect(screen.getByText("Acme Corp")).toBeTruthy();
    expect(screen.getByText("ACME · You hold 12")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Buy" }).props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId("trade-date").props.accessibilityLabel).toBe("Date, Today");
    expect(screen.getByLabelText("Price per share (USD)").props.value).toBe("231.4");
    expect(screen.getByText("Close of 31 Oct 2026. You can change it.")).toBeTruthy();
    expect(screen.getByText("Fractions allowed")).toBeTruthy();
  });

  it("changes the price to the close of the new date while the user has not typed a price", async () => {
    await renderNew();

    await fireEvent.press(screen.getByTestId("trade-date"));
    await fireEvent.press(screen.getByTestId("day-2026-10-29"));

    expect(screen.getByLabelText("Price per share (USD)").props.value).toBe("228.1");
    expect(screen.getByText("Close of 29 Oct 2026. You can change it.")).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText("Price per share (USD)"), "230");
    await fireEvent.press(screen.getByTestId("trade-date"));
    await fireEvent.press(screen.getByTestId("day-2026-10-31"));

    expect(screen.getByLabelText("Price per share (USD)").props.value).toBe("230");
  });

  it("saves a valid trade and closes", async () => {
    const onClose = jest.fn();
    await renderNew(onClose);

    await fireEvent.changeText(screen.getByLabelText("Quantity"), "3.5");
    await fireEvent.changeText(screen.getByLabelText("Fee (USD)"), "1.00");
    await fireEvent.changeText(screen.getByLabelText("Note"), "Dip");
    await fireEvent.press(saveButton());

    expect(mockSaveTrade).toHaveBeenCalledWith(expect.anything(), {
      instrument_id: "acme",
      side: "buy",
      date: "2026-10-31",
      quantity: "3.5",
      price: "231.4",
      fee: "1.00",
      note: "Dip",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("blocks a sell of more than the held quantity", async () => {
    await renderNew();

    await fireEvent.press(screen.getByRole("tab", { name: "Sell" }));
    await fireEvent.changeText(screen.getByLabelText("Quantity"), "15");

    expect(screen.getByText("You hold 12 ACME on 31 Oct 2026. You cannot sell 15.")).toBeTruthy();
    expect(saveButton().props.accessibilityState).toEqual({ disabled: true });

    await fireEvent.changeText(screen.getByLabelText("Quantity"), "12");
    expect(screen.queryByText(/You cannot sell/)).toBeNull();
    expect(saveButton().props.accessibilityState).toEqual({ disabled: false });
  });

  it("names the later sell when a lowered buy leaves it larger than the holding", async () => {
    const sell: TradeRow = { id: "t3", instrument_id: "acme", side: "sell", date: "2026-10-01", quantity: "10", price: "200", fee: "0", note: null };
    mockDetail = detail([...buys, sell]);
    await render(<TradeForm id="t2" platform="ios" today="2026-10-31" onClose={jest.fn()} />);

    await fireEvent.changeText(screen.getByLabelText("Quantity"), "1");

    expect(screen.getByText("The sell of 10 ACME on 1 Oct 2026 would be more than you hold (9).")).toBeTruthy();
    expect(screen.queryByText(/You cannot sell/)).toBeNull();
    expect(saveButton().props.accessibilityState).toEqual({ disabled: true });
  });

  it("refuses to delete a buy that a later sell needs, without asking", async () => {
    const sell: TradeRow = { id: "t3", instrument_id: "acme", side: "sell", date: "2026-10-01", quantity: "10", price: "200", fee: "0", note: null };
    mockDetail = detail([...buys, sell]);
    await render(<TradeForm id="t2" platform="ios" today="2026-10-31" onClose={jest.fn()} />);

    await fireEvent.press(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByText("You cannot delete this trade. The sell of 10 ACME on 1 Oct 2026 would be more than you hold (8).")).toBeTruthy();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDeleteTrade).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the side",
      async () => {
        await fireEvent.press(screen.getByRole("tab", { name: "Buy" }));
      },
    ],
    [
      "the date",
      async () => {
        await fireEvent.press(screen.getByTestId("trade-date"));
        await fireEvent.press(screen.getByTestId("day-2026-10-29"));
      },
    ],
  ])("clears a server over-held error when the user changes %s", async (_, change) => {
    mockSaveTrade.mockResolvedValue({ ok: false, errors: [{ field: "quantity", code: "over_held", held: "2" }] });
    await renderNew();

    await fireEvent.press(screen.getByRole("tab", { name: "Sell" }));
    await fireEvent.changeText(screen.getByLabelText("Quantity"), "5");
    await fireEvent.press(saveButton());

    expect(screen.getByText(/You hold 2 ACME on .*\. You cannot sell 5\./)).toBeTruthy();
    expect(saveButton().props.accessibilityState).toEqual({ disabled: true });

    await change();

    expect(screen.queryByText(/You cannot sell/)).toBeNull();
    expect(saveButton().props.accessibilityState).toEqual({ disabled: false });
  });

  it("shows the errors of invalid fields on Save and does not save", async () => {
    await renderNew();

    await fireEvent.changeText(screen.getByLabelText("Price per share (USD)"), "0");
    await fireEvent.press(saveButton());

    expect(screen.getByText("Enter a quantity above 0")).toBeTruthy();
    expect(screen.getByText("Enter a price above 0")).toBeTruthy();
    expect(mockSaveTrade).not.toHaveBeenCalled();
  });

  it("edits a trade, and Delete asks first and then deletes it", async () => {
    const onClose = jest.fn();
    await render(<TradeForm id="t2" platform="ios" today="2026-10-31" onClose={onClose} />);

    expect(screen.getByText("Edit trade")).toBeTruthy();
    expect(screen.getByLabelText("Quantity").props.value).toBe("4");
    expect(screen.getByLabelText("Price per share (USD)").props.value).toBe("189.2");
    expect(screen.getByLabelText("Note").props.value).toBe("Top up");

    mockConfirm.mockResolvedValueOnce(false);
    await fireEvent.press(screen.getByRole("button", { name: "Delete" }));
    expect(mockConfirm).toHaveBeenCalledWith("Delete this trade", "Delete");
    expect(mockDeleteTrade).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole("button", { name: "Delete" }));
    expect(mockDeleteTrade).toHaveBeenCalledWith(expect.anything(), "t2");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows no Delete button for a new trade", async () => {
    await renderNew();

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});
