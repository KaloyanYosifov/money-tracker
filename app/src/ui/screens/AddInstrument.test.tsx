import { act, fireEvent, render, screen } from "@testing-library/react-native";

import type { InstrumentsApi, SearchResult } from "../../data/instrumentsApi";
import { AddInstrumentScreen } from "./AddInstrument";

jest.mock("@powersync/react", () => ({
  useQuery: () => ({ data: [{ id: "s1", currency_code: "EUR", theme: "light" }], isLoading: false }),
}));

const results: SearchResult[] = [
  { symbol: "ACME", name: "Acme Corp", exchange: "NASDAQ", kind: "stock" },
  { symbol: "ACWX", name: "Acme World ETF", exchange: "Xetra", kind: "etf" },
];

function fakeApi(overrides: Partial<InstrumentsApi> = {}): jest.Mocked<InstrumentsApi> {
  return {
    search: jest.fn().mockResolvedValue({ ok: true, value: results }),
    add: jest.fn().mockResolvedValue({
      ok: true,
      value: { ...results[0], id: "inst-acme", quote_currency: "USD" },
    }),
    ...overrides,
  } as jest.Mocked<InstrumentsApi>;
}

async function type(text: string) {
  await fireEvent.changeText(screen.getByLabelText("Name or ticker"), text);
}

async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("AddInstrumentScreen", () => {
  it("searches 300 ms after the last key, and not for one letter", async () => {
    const api = fakeApi();
    await render(<AddInstrumentScreen api={api} onCancel={jest.fn()} onAdded={jest.fn()} />);

    await type("a");
    await wait(1000);
    expect(api.search).not.toHaveBeenCalled();

    await type("ac");
    await wait(100);
    await type("acm");
    await wait(100);
    await type("acme");
    await wait(299);
    expect(api.search).not.toHaveBeenCalled();
    await wait(1);

    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.search).toHaveBeenCalledWith("acme");
  });

  it("shows the name, the symbol, the exchange and the kind of each result", async () => {
    await render(<AddInstrumentScreen api={fakeApi()} onCancel={jest.fn()} onAdded={jest.fn()} />);

    await type("acme");
    await wait(300);

    expect(screen.getByText("Results from Yahoo Finance")).toBeTruthy();
    expect(screen.getByText("Acme Corp")).toBeTruthy();
    expect(screen.getByText("ACME · NASDAQ · Stock")).toBeTruthy();
    expect(screen.getByText("Acme World ETF")).toBeTruthy();
    expect(screen.getByText("ACWX · Xetra · ETF")).toBeTruthy();
    expect(screen.getByText("Pick a result to add it and enter your first trade.")).toBeTruthy();
  });

  it("adds the tapped result, then calls onAdded with its id", async () => {
    const api = fakeApi();
    const onAdded = jest.fn();
    await render(<AddInstrumentScreen api={api} onCancel={jest.fn()} onAdded={onAdded} />);

    await type("acme");
    await wait(300);
    await fireEvent.press(screen.getByRole("button", { name: "Acme Corp, ACME · NASDAQ · Stock" }));

    expect(api.add).toHaveBeenCalledWith("ACME");
    expect(onAdded).toHaveBeenCalledWith("inst-acme");
  });

  it("shows the offline state for a network error", async () => {
    const api = fakeApi({ search: jest.fn().mockResolvedValue({ ok: false, error: "network" }) });
    await render(<AddInstrumentScreen api={api} onCancel={jest.fn()} onAdded={jest.fn()} />);

    await type("acme");
    await wait(300);

    expect(screen.getByText("Search needs a connection")).toBeTruthy();
    expect(screen.getByText(/Trades for assets that you already hold work offline\./)).toBeTruthy();
  });

  it("shows the rate limit and the server errors", async () => {
    const search = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "rate_limited" })
      .mockResolvedValueOnce({ ok: false, error: "server" });
    await render(<AddInstrumentScreen api={fakeApi({ search })} onCancel={jest.fn()} onAdded={jest.fn()} />);

    await type("acme");
    await wait(300);
    expect(screen.getByText("Too many searches. Wait a minute.")).toBeTruthy();

    await type("acmex");
    await wait(300);
    expect(screen.getByText("Search is not available now.")).toBeTruthy();
  });

  it("shows an error and stays open when the add fails", async () => {
    const onAdded = jest.fn();
    const api = fakeApi({ add: jest.fn().mockResolvedValue({ ok: false, error: "server" }) });
    await render(<AddInstrumentScreen api={api} onCancel={jest.fn()} onAdded={onAdded} />);

    await type("acme");
    await wait(300);
    await fireEvent.press(screen.getByRole("button", { name: "Acme Corp, ACME · NASDAQ · Stock" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Could not add Acme Corp. Try again.");
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("closes with Cancel", async () => {
    const onCancel = jest.fn();
    await render(<AddInstrumentScreen api={fakeApi()} onCancel={onCancel} onAdded={jest.fn()} />);

    await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalled();
  });
});
