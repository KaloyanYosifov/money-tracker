import { fireEvent, render, screen } from "@testing-library/react-native";

import type { InstrumentRow, SwapRow, TradeRow } from "../../data/portfolio";
import { SwapForm } from "./SwapForm";

const instrument = (id: string, symbol: string, quote: string, kind: InstrumentRow["kind"] = "crypto") =>
  ({
    id,
    symbol,
    name: `${symbol} coin`,
    exchange: "CCC",
    kind,
    quote_currency: quote,
  }) as InstrumentRow;

const mockInstruments = [
  instrument("zza", "ZZA-USD", "USD"),
  instrument("zzb", "ZZB-USD", "USD"),
  instrument("zzc", "ZZC.DE", "EUR", "stock"),
  instrument("zzg", "ZZG.L", "GBP", "stock"),
  instrument("eurusd", "EURUSD=X", "USD", "fx"),
];

let mockTrades: TradeRow[] = [];
let mockSwaps: SwapRow[] = [];
let mockFxPrices: { instrument_id: string; date: string; close: string }[] = [];
jest.mock("@powersync/react", () => ({
  useQuery: (sql: string) => {
    if (sql.includes("FROM trades")) return { data: mockTrades, isLoading: false };
    if (sql.includes("FROM swaps")) return { data: mockSwaps, isLoading: false };
    if (sql.includes("FROM instrument_prices")) return { data: mockFxPrices, isLoading: false };
    if (sql.includes("FROM instruments")) return { data: mockInstruments, isLoading: false };
    return {
      data: [{ id: "s1", currency_code: "EUR", theme: "light", week_start_day: 1 }],
      isLoading: false,
    };
  },
  usePowerSync: () => ({}),
}));

const mockSaveSwap = jest.fn();
const mockDeleteSwap = jest.fn();
jest.mock("../../data/mutations", () => ({
  saveSwap: (...args: unknown[]) => mockSaveSwap(...args),
  deleteSwap: (...args: unknown[]) => mockDeleteSwap(...args),
}));

const mockConfirm = jest.fn();
jest.mock("../../data/session", () => ({
  confirmDialog: (...args: unknown[]) => mockConfirm(...args),
}));

jest.mock("../../hooks/useShortcuts", () => ({ useShortcuts: () => {} }));

const TODAY = "2026-03-02";

beforeEach(() => {
  mockTrades = [
    {
      id: "t1",
      instrument_id: "zza",
      side: "buy",
      date: "2026-01-05",
      quantity: "2",
      price: "2000",
      fee: "0",
      note: null,
    },
  ];
  mockSwaps = [];
  mockFxPrices = [{ instrument_id: "eurusd", date: TODAY, close: "1.25" }];
  mockSaveSwap.mockReset().mockResolvedValue({ ok: true, id: "new-id" });
  mockDeleteSwap.mockReset().mockResolvedValue({ ok: true, id: "sw1" });
  mockConfirm.mockReset().mockResolvedValue(true);
});

function renderNew(onClose = jest.fn()) {
  return render(<SwapForm id={null} instrumentId="zza" platform="ios" today={TODAY} onClose={onClose} />);
}

async function pickTo(symbol: string) {
  await fireEvent.press(screen.getByTestId("swap-to"));
  await fireEvent.press(screen.getByTestId(`swap-to-option-${symbol}`));
}

function saveButton() {
  return screen.getByRole("button", { name: "Save" });
}

describe("SwapForm", () => {
  it("starts with the asset as From and lists the other assets without FX as To", async () => {
    await renderNew();

    expect(screen.getByText("New swap")).toBeTruthy();
    expect(screen.getByTestId("swap-from").props.accessibilityLabel).toBe("From, ZZA-USD");

    await fireEvent.press(screen.getByTestId("swap-to"));
    const options = screen.getAllByRole("radio").map((o) => o.props.accessibilityLabel);
    expect(options).toEqual(["ZZB-USD", "ZZC.DE", "ZZG.L"]);
  });

  it("shows one value field when both assets have the same quote currency", async () => {
    await renderNew();
    await pickTo("ZZB-USD");

    expect(screen.getByLabelText("Value (USD)")).toBeTruthy();
    expect(screen.getAllByLabelText(/^Value \(/)).toHaveLength(1);
    expect(screen.getByLabelText("Fee (ZZB-USD)")).toBeTruthy();
  });

  it("fills the value in the To currency from the FX close, and keeps a value that the user typed", async () => {
    await renderNew();
    await pickTo("ZZC.DE");

    await fireEvent.changeText(screen.getByLabelText("Value (USD)"), "100");
    expect(screen.getByLabelText("Value (EUR)").props.value).toBe("80");

    await fireEvent.changeText(screen.getByLabelText("Value (EUR)"), "81");
    await fireEvent.changeText(screen.getByLabelText("Value (USD)"), "200");
    expect(screen.getByLabelText("Value (EUR)").props.value).toBe("81");
  });

  it("drops a typed To value when the To asset changes to another quote currency", async () => {
    await renderNew();
    await pickTo("ZZC.DE");
    await fireEvent.changeText(screen.getByLabelText("Value (USD)"), "100");
    await fireEvent.changeText(screen.getByLabelText("Value (EUR)"), "81");

    await pickTo("ZZG.L");

    expect(screen.getByLabelText("Value (GBP)").props.value).toBe("");
  });

  it("leaves the To value empty without an FX close, and Save asks for it", async () => {
    await renderNew();
    await pickTo("ZZG.L");

    await fireEvent.changeText(screen.getByLabelText("Quantity given"), "1");
    await fireEvent.changeText(screen.getByLabelText("Quantity received"), "30");
    await fireEvent.changeText(screen.getByLabelText("Value (USD)"), "100");

    expect(screen.getByLabelText("Value (GBP)").props.value).toBe("");
    expect(screen.getByText("No exchange rate for this date. Enter the value.")).toBeTruthy();

    await fireEvent.press(saveButton());
    expect(screen.getByTestId("error-to_value")).toHaveTextContent("Enter a value above 0");
    expect(mockSaveSwap).not.toHaveBeenCalled();
  });

  it("saves a valid swap and closes", async () => {
    const onClose = jest.fn();
    await renderNew(onClose);
    await pickTo("ZZB-USD");

    await fireEvent.changeText(screen.getByLabelText("Quantity given"), "1");
    await fireEvent.changeText(screen.getByLabelText("Quantity received"), "2498");
    await fireEvent.changeText(screen.getByLabelText("Fee (ZZB-USD)"), "2");
    await fireEvent.changeText(screen.getByLabelText("Value (USD)"), "2500");
    await fireEvent.press(saveButton());

    expect(mockSaveSwap).toHaveBeenCalledWith(expect.anything(), {
      from_instrument_id: "zza",
      to_instrument_id: "zzb",
      date: TODAY,
      from_quantity: "1",
      to_quantity: "2498",
      fee: "2",
      value: "2500",
      to_value: "2500",
      note: null,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("names the asset of a later sell from the server by its sell leg", async () => {
    mockTrades.push({ id: "t2", instrument_id: "zzb", side: "buy", date: "2026-01-10", quantity: "100", price: "1", fee: "0", note: null });
    mockSwaps = [
      {
        id: "sw2",
        from_instrument_id: "zzb",
        to_instrument_id: "zza",
        date: "2026-02-10",
        from_quantity: "100",
        to_quantity: "0.05",
        fee: "0",
        value: "100",
        to_value: "100",
        note: null,
      },
    ];
    mockSaveSwap.mockResolvedValue({
      ok: false,
      errors: [{ field: "to_quantity", code: "over_held", held: "50", sell: { id: "sw2", date: "2026-02-10", quantity: "100" } }],
    });
    await renderNew();
    await pickTo("ZZB-USD");

    await fireEvent.changeText(screen.getByLabelText("Quantity given"), "1");
    await fireEvent.changeText(screen.getByLabelText("Quantity received"), "2498");
    await fireEvent.changeText(screen.getByLabelText("Value (USD)"), "2500");
    await fireEvent.press(saveButton());

    expect(screen.getByText(/The sell of 100 ZZB-USD on/)).toBeTruthy();
  });

  it("blocks a swap of more than the held quantity", async () => {
    await renderNew();
    await pickTo("ZZB-USD");

    await fireEvent.changeText(screen.getByLabelText("Quantity given"), "3");

    expect(screen.getByText("You hold 2 ZZA-USD on 2 Mar 2026. You cannot swap 3.")).toBeTruthy();
    expect(saveButton().props.accessibilityState).toEqual({ disabled: true });

    await fireEvent.changeText(screen.getByLabelText("Quantity given"), "2");
    expect(screen.queryByText(/You cannot swap/)).toBeNull();
    expect(saveButton().props.accessibilityState).toEqual({ disabled: false });
  });

  it("edits a swap, and Delete asks first and then deletes it", async () => {
    mockSwaps = [
      {
        id: "sw1",
        from_instrument_id: "zza",
        to_instrument_id: "zzb",
        date: "2026-02-01",
        from_quantity: "1",
        to_quantity: "2498",
        fee: "2",
        value: "2500",
        to_value: "2500",
        note: "Rebalance",
      },
    ];
    const onClose = jest.fn();
    await render(<SwapForm id="sw1" platform="ios" today={TODAY} onClose={onClose} />);

    expect(screen.getByText("Edit swap")).toBeTruthy();
    expect(screen.getByTestId("swap-from").props.accessibilityLabel).toBe("From, ZZA-USD");
    expect(screen.getByTestId("swap-to").props.accessibilityLabel).toBe("To, ZZB-USD");
    expect(screen.getByLabelText("Quantity given").props.value).toBe("1");
    expect(screen.getByLabelText("Quantity received").props.value).toBe("2498");
    expect(screen.getByLabelText("Fee (ZZB-USD)").props.value).toBe("2");
    expect(screen.getByLabelText("Value (USD)").props.value).toBe("2500");
    expect(screen.getByLabelText("Note").props.value).toBe("Rebalance");

    mockConfirm.mockResolvedValueOnce(false);
    await fireEvent.press(screen.getByRole("button", { name: "Delete" }));
    expect(mockConfirm).toHaveBeenCalledWith("Delete this swap", "Delete");
    expect(mockDeleteSwap).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole("button", { name: "Delete" }));
    expect(mockDeleteSwap).toHaveBeenCalledWith(expect.anything(), "sw1");
    expect(onClose).toHaveBeenCalled();
  });
});
