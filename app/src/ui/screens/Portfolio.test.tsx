import { fireEvent, render, screen, within } from "@testing-library/react-native";

import type { InstrumentDetail, Portfolio, PortfolioHolding } from "../../data/portfolio";
import { toFixed } from "../../domain/decimal";
import { colors } from "../theme";
import { InstrumentDetailScreen } from "./InstrumentDetail";
import { formatQuote, PortfolioScreen, profitPercent } from "./Portfolio";

let mockPortfolio: Portfolio | null = null;
let mockDetail: InstrumentDetail | null = null;
jest.mock("../../data/portfolio", () => ({
  usePortfolio: () => ({ data: mockPortfolio, isLoading: false }),
  useInstrument: () => ({ data: mockDetail, isLoading: false }),
}));

jest.mock("../../data/queries", () => ({
  useAccountsTotal: () => ({ data: { total: 1824055 }, isLoading: false }),
}));

jest.mock("@powersync/react", () => ({
  useQuery: () => ({ data: [{ id: "s1", currency_code: "EUR", theme: "light", summary_font: "mono" }], isLoading: false }),
}));

// The chart shows its points as text, so a test can read the series.
jest.mock("../charts/LineChart", () => {
  const { Text: MockText } = jest.requireActual("react-native");
  return {
    LineChart: ({ points, accessibilityLabel }: { points: { date: string }[]; accessibilityLabel: string }) => (
      <MockText testID="chart" accessibilityLabel={accessibilityLabel}>
        {points.map((p) => p.date).join(",")}
      </MockText>
    ),
  };
});

const f = (text: string) => {
  const value = toFixed(text.replace("-", ""));
  if (value === null) throw new Error(text);
  return text.startsWith("-") ? -value : value;
};

const NOW = new Date(2026, 9, 30, 18, 0);

function holdingOf(fields: Partial<PortfolioHolding>): PortfolioHolding {
  return {
    instrumentId: "acme",
    symbol: "ACME",
    name: "Acme Corp",
    exchange: "NASDAQ",
    kind: "stock",
    quoteCurrency: "USD",
    quantity: f("12"),
    cost: f("2171.95"),
    fees: f("3"),
    close: f("231.40"),
    closeDate: "2026-10-30",
    value: f("2776.80"),
    openProfit: f("604.85"),
    realized: f("95.75"),
    app: { value: f("2560.12"), cost: f("2002.71"), openProfit: f("557.41"), realized: f("88.40") },
    lastFetchedAt: new Date(2026, 9, 30, 17, 0).toISOString(),
    failed: false,
    prices: [
      { date: "2025-09-01", close: f("180") },
      { date: "2026-06-01", close: f("210") },
      { date: "2026-10-30", close: f("231.40") },
    ],
    ...fields,
  };
}

const acme = holdingOf({});
const globex = holdingOf({
  instrumentId: "globex",
  symbol: "GLBX",
  name: "Globex plc",
  exchange: "London",
  quoteCurrency: "GBP",
  quantity: f("50"),
  cost: f("1389.73"),
  value: f("1342.50"),
  openProfit: f("-47.23"),
  app: { value: f("1598.21"), cost: f("1654.44"), openProfit: f("-56.23"), realized: 0n },
  lastFetchedAt: new Date(2026, 9, 30, 14, 0).toISOString(),
});
const initech = holdingOf({
  instrumentId: "initech",
  symbol: "NTCH",
  name: "Initech",
  exchange: "",
  quantity: f("100"),
  cost: f("500"),
  value: f("42"),
  openProfit: f("-458"),
  closeDate: "2026-09-12",
  app: { value: f("38.72"), cost: f("461.04"), openProfit: f("-422.32"), realized: 0n },
  failed: true,
});

const portfolio: Portfolio = {
  holdings: [acme, globex, initech],
  totals: { value: f("11611.13"), cost: f("10098.73"), openProfit: f("1512.40"), realized: f("214.60") },
  series: [
    { date: "2025-06-01", value: f("8000") },
    { date: "2026-01-15", value: f("9500") },
    { date: "2026-10-10", value: f("11000") },
    { date: "2026-10-30", value: f("11611.13") },
  ],
};

beforeEach(() => jest.useFakeTimers({ now: NOW }));
afterEach(() => {
  jest.useRealTimers();
  mockPortfolio = null;
  mockDetail = null;
});

async function renderPortfolio() {
  const onOpen = jest.fn();
  const onAdd = jest.fn();
  await render(<PortfolioScreen locale="en-GB" onOpen={onOpen} onAdd={onAdd} />);
  return { onOpen, onAdd };
}

describe("signed amounts when Intl ignores signDisplay, as Hermes on iOS does", () => {
  const RealNumberFormat = Intl.NumberFormat;
  beforeEach(() => {
    jest.spyOn(Intl, "NumberFormat").mockImplementation(
      (locale, options) => new RealNumberFormat(locale, { ...options, signDisplay: "auto" }),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it("adds a plus sign to a profit in the quote currency and in %", () => {
    expect(formatQuote(toFixed("604.85")!, "USD", "en-GB", true)).toBe("+$604.85");
    expect(formatQuote(toFixed("0")!, "USD", "en-GB", true)).toBe("$0.00");
    expect(profitPercent(toFixed("150")!, toFixed("1000")!, "en-GB")).toBe("+15.0%");
    expect(profitPercent(-(toFixed("34")!), toFixed("1000")!, "en-GB")).toBe("-3.4%");
  });
});

describe("PortfolioScreen", () => {
  it("shows net worth, the accounts, the portfolio value and the profits on the chalkboard", async () => {
    mockPortfolio = portfolio;
    await renderPortfolio();
    const board = within(screen.getByTestId("portfolio-board"));
    expect(board.getByText("Net worth")).toBeOnTheScreen();
    expect(board.getByText("€29,851.68")).toBeOnTheScreen();
    expect(board.getByText("€18,240.55")).toBeOnTheScreen();
    expect(board.getByText("€11,611.13")).toBeOnTheScreen();
    expect(board.getByText("+€1,512.40 (+15.0%)")).toBeOnTheScreen();
    expect(board.getByText("+€214.60")).toBeOnTheScreen();
  });

  it("shows each holding with its quantity, values and profit, and a loss in red", async () => {
    mockPortfolio = portfolio;
    const { onOpen } = await renderPortfolio();
    const row = within(screen.getByTestId("holding-acme"));
    expect(row.getByText("Acme Corp")).toBeOnTheScreen();
    expect(row.getByText("ACME · NASDAQ · 12 shares · $2,776.80")).toBeOnTheScreen();
    expect(row.getByText("€2,560.12")).toBeOnTheScreen();
    expect(row.getByText("+27.8%")).toHaveStyle({ color: colors.light.listGreen });

    const loss = within(screen.getByTestId("holding-globex"));
    expect(loss.getByText("-3.4%")).toHaveStyle({ color: colors.light.listRed });

    await fireEvent.press(screen.getByTestId("holding-acme"));
    expect(onOpen).toHaveBeenCalledWith("acme");
  });

  it("shows when a price is old or not available", async () => {
    mockPortfolio = portfolio;
    await renderPortfolio();
    expect(within(screen.getByTestId("holding-globex")).getByText("Price from 14:00, 30 Oct")).toBeOnTheScreen();
    expect(within(screen.getByTestId("holding-initech")).getByText("Price unavailable. Last close 12 Sep")).toBeOnTheScreen();
    expect(within(screen.getByTestId("holding-acme")).queryByText(/^Price/)).toBeNull();
  });

  it("keeps the footer at the bottom, outside the scrolled content", async () => {
    mockPortfolio = portfolio;
    await renderPortfolio();
    expect(screen.getByText("Values in EUR. Rates from Yahoo Finance, updated every hour.")).toBeOnTheScreen();
    expect(within(screen.getByTestId("portfolio-scroll")).queryByText(/^Values in EUR/)).toBeNull();
  });

  it("shows the empty state without holdings", async () => {
    mockPortfolio = { holdings: [], totals: { value: 0n, cost: 0n, openProfit: 0n, realized: 0n }, series: [] };
    const { onAdd } = await renderPortfolio();
    expect(screen.getByText("No assets yet")).toBeOnTheScreen();
    expect(screen.queryByTestId("portfolio-board")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Add asset" }));
    expect(onAdd).toHaveBeenCalled();
  });

  it("changes the series of the chart with the range buttons", async () => {
    mockPortfolio = portfolio;
    await renderPortfolio();
    expect(screen.getByTestId("chart")).toHaveTextContent("2026-01-15,2026-10-10,2026-10-30");
    await fireEvent.press(screen.getByRole("tab", { name: "1M" }));
    expect(screen.getByTestId("chart")).toHaveTextContent("2026-10-10,2026-10-30");
    await fireEvent.press(screen.getByRole("tab", { name: "6M" }));
    expect(screen.getByTestId("chart")).toHaveTextContent("2026-10-10,2026-10-30");
    await fireEvent.press(screen.getByRole("tab", { name: "All" }));
    expect(screen.getByTestId("chart")).toHaveTextContent("2025-06-01,2026-01-15,2026-10-10,2026-10-30");
  });
});

describe("InstrumentDetailScreen", () => {
  const trades = [
    { id: "t3", instrument_id: "acme", side: "sell" as const, date: "2026-06-10", quantity: "2", price: "221", fee: "1", note: null },
    { id: "t2", instrument_id: "acme", side: "buy" as const, date: "2025-09-02", quantity: "6", price: "189.2", fee: "1", note: null },
    { id: "t1", instrument_id: "acme", side: "buy" as const, date: "2025-03-14", quantity: "8", price: "172.5", fee: "1", note: null },
  ];

  async function renderDetail() {
    mockDetail = {
      instrument: {
        id: "acme",
        symbol: "ACME",
        name: "Acme Corp",
        exchange: "NASDAQ",
        kind: "stock",
        quote_currency: "USD",
        last_fetched_at: acme.lastFetchedAt,
        failed_at: null,
      },
      holding: acme,
      trades,
    };
    const onOpenTrade = jest.fn();
    const onAddTrade = jest.fn();
    await render(
      <InstrumentDetailScreen id="acme" locale="en-GB" onBack={jest.fn()} onAddTrade={onAddTrade} onOpenTrade={onOpenTrade} />,
    );
    return { onOpenTrade, onAddTrade };
  }

  it("shows the open quantity, value, cost, profits and fees", async () => {
    await renderDetail();
    const stat = (label: string) => within(screen.getByTestId(`stat-${label}`));
    expect(screen.getByText("ACME · NASDAQ · $231.40 · updated 17:00")).toBeOnTheScreen();
    expect(stat("Open quantity").getByText("12")).toBeOnTheScreen();
    expect(stat("Value").getByText("$2,776.80")).toBeOnTheScreen();
    expect(stat("Value").getByText("€2,560.12")).toBeOnTheScreen();
    expect(stat("Cost of open lots (FIFO)").getByText("$2,171.95")).toBeOnTheScreen();
    expect(stat("Open profit").getByText("+$604.85")).toBeOnTheScreen();
    expect(stat("Open profit").getByText("+27.8%")).toBeOnTheScreen();
    expect(stat("Realized profit").getByText("+$95.75")).toBeOnTheScreen();
    expect(stat("Realized profit").getByText("+€88.40")).toBeOnTheScreen();
    expect(stat("Fees paid").getByText("$3.00")).toBeOnTheScreen();
  });

  it("lists the trades newest first and opens a trade on tap", async () => {
    const { onOpenTrade, onAddTrade } = await renderDetail();
    const rows = screen.getAllByTestId(/^trade-/);
    expect(rows.map((r) => r.props.testID)).toEqual(["trade-t3", "trade-t2", "trade-t1"]);
    const first = within(rows[0]);
    expect(first.getByText("10 Jun 2026")).toBeOnTheScreen();
    expect(first.getByText("Sell")).toHaveStyle({ color: colors.light.listRed });
    expect(first.getByText("2")).toBeOnTheScreen();
    expect(first.getByText("$221.00")).toBeOnTheScreen();

    await fireEvent.press(rows[1]);
    expect(onOpenTrade).toHaveBeenCalledWith("t2");
    await fireEvent.press(screen.getByRole("button", { name: "Add trade" }));
    expect(onAddTrade).toHaveBeenCalled();
  });
});
