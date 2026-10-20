import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import { createTestDatabase, loadFixture, type TestDatabase } from "../../../test/sqlite";
import { SessionsScreen, Settings, SyncProblemsScreen, type SessionsApi } from "./Settings";

let mockDb: TestDatabase;

// The hooks run their SQL against the in-memory fixture database, and the
// mutations write to it.
jest.mock("@powersync/react", () => ({
  useQuery: (sql: string, parameters: unknown[] = []) => ({
    data: mockDb.prepare(sql).all(parameters),
    isLoading: false,
  }),
  usePowerSync: () => jest.requireActual("../../../test/sqlite").asyncDatabase(mockDb),
  useStatus: () => ({ connected: true, uploading: false, downloading: false, lastSyncedAt: undefined }),
}));

const mockEnrolledLevel = jest.fn();
jest.mock("expo-local-authentication", () => ({
  SecurityLevel: { NONE: 0, SECRET: 1 },
  getEnrolledLevelAsync: () => mockEnrolledLevel(),
}));

jest.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ status: "signedIn" }),
}));

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
};

beforeEach(() => {
  mockEnrolledLevel.mockResolvedValue(1);
  mockDb = createTestDatabase();
  // PowerSync's upload queue. The sync state counts its rows.
  mockDb.exec("CREATE TABLE ps_crud (id INTEGER PRIMARY KEY, data TEXT, tx_id INTEGER)");
  loadFixture(mockDb, { user_settings: [userSettings] });
});

function settingsRow() {
  return mockDb.prepare("SELECT * FROM user_settings").get() as Record<string, unknown>;
}

function devicePref(key: string) {
  return (mockDb.prepare("SELECT value FROM device_prefs WHERE id = ?").get(key) as { value: string } | undefined)?.value;
}

const noop = () => {};

function renderSettings(platform: "ios" | "web", handlers: Partial<Record<string, jest.Mock>> = {}) {
  return render(
    <Settings
      platform={platform}
      onClose={handlers.onClose ?? noop}
      onOpenSyncProblems={handlers.onOpenSyncProblems ?? noop}
      onOpenSessions={handlers.onOpenSessions ?? noop}
      onLogout={handlers.onLogout ?? noop}
      onResetLocalData={handlers.onResetLocalData ?? noop}
    />,
  );
}

function headers() {
  return screen.getAllByRole("header").map((h) => h.props.children);
}

describe("Settings", () => {
  it("shows the grouped sections and rows on iOS", async () => {
    await renderSettings("ios");

    expect(headers()).toEqual(["Settings", "Spending", "Sync", "User Interface", "Security", "General"]);
    expect(screen.getByRole("button", { name: "Time Period, Monthly" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Budget Mode" }).props.value).toBe(false);
    expect(screen.queryByLabelText("Budget Amount")).toBeNull();
    expect(screen.getByRole("switch", { name: "Carry Over" }).props.value).toBe(true);
    expect(screen.getByRole("switch", { name: "Hide Future Transactions" }).props.value).toBe(false);

    expect(screen.getByText("Home Server Sync")).toBeTruthy();
    expect(screen.getByText("Not synced yet · 0 pending")).toBeTruthy();
    expect(screen.queryByText(/Sync problems/)).toBeNull();
    expect(screen.getByRole("button", { name: "Devices" })).toBeTruthy();

    expect(screen.getByRole("button", { name: "Dark Theme, Off" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Show Transaction Note" }).props.value).toBe(true);
    expect(screen.getByLabelText("Currency Symbol, €")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Currency Symbol/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Summary Font, DroidSansMono" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Category Icon Style, Filled" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tabs Position, Bottom" })).toBeTruthy();

    expect(screen.getByRole("switch", { name: "App Lock" }).props.value).toBe(false);
    expect(screen.getByRole("button", { name: "Lock After, Immediately" })).toBeTruthy();

    expect(screen.getByRole("button", { name: "Reset local data" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
  });

  it("has no Tabs Position and no Security section on the web", async () => {
    await renderSettings("web");

    expect(headers()).toEqual(["Settings", "Spending", "Sync", "User Interface", "General"]);
    expect(screen.queryByRole("button", { name: /Tabs Position/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: "App Lock" })).toBeNull();
  });

  it("shows the number of sync problems and opens the list", async () => {
    loadFixture(mockDb, {
      sync_problems: [
        { id: "p1", table_name: "transactions", record_id: "t1", op: "PUT", code: "invalid_record", message: "m", created_at: "x" },
        { id: "p2", table_name: "accounts", record_id: "a1", op: "PATCH", code: "invalid_record", message: "m", created_at: "x" },
      ],
    });
    const onOpenSyncProblems = jest.fn();
    await renderSettings("ios", { onOpenSyncProblems });

    expect(screen.getByText("Needs attention · 2 problems")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Sync problems (2)" }));
    expect(onOpenSyncProblems).toHaveBeenCalled();
  });

  it("writes the synced settings to user_settings", async () => {
    await renderSettings("ios");

    await fireEvent(screen.getByRole("switch", { name: "Carry Over" }), "valueChange", false);
    await fireEvent(screen.getByRole("switch", { name: "Hide Future Transactions" }), "valueChange", true);
    await fireEvent.press(screen.getByRole("button", { name: "Time Period, Monthly" }));
    await fireEvent.press(screen.getByRole("radio", { name: "Weekly" }));
    await fireEvent.press(screen.getByRole("button", { name: "Dark Theme, Off" }));
    await fireEvent.press(screen.getByRole("radio", { name: "On" }));
    await fireEvent.press(screen.getByRole("button", { name: "Category Icon Style, Filled" }));
    await fireEvent.press(screen.getByRole("radio", { name: "Outline" }));

    await waitFor(() =>
      expect(settingsRow()).toMatchObject({
        carry_over: 0,
        hide_future: 1,
        time_period: "weekly",
        theme: "dark",
        icon_style: "outline",
      }),
    );
  });

  it("turns Budget Mode on", async () => {
    await renderSettings("ios");

    await fireEvent(screen.getByRole("switch", { name: "Budget Mode" }), "valueChange", true);
    await waitFor(() => expect(settingsRow().budget_mode).toBe(1));
  });

  it("shows Budget Amount when Budget Mode is on and saves the overall budget", async () => {
    mockDb.prepare("UPDATE user_settings SET budget_mode = 1").run();
    await renderSettings("ios");

    const amount = screen.getByLabelText("Budget Amount");
    await fireEvent.changeText(amount, "250");
    await fireEvent(amount, "blur");

    await waitFor(() =>
      expect(mockDb.prepare("SELECT user_id, category_id, period, amount_minor FROM budgets").all()).toEqual([
        { user_id: "u1", category_id: null, period: "monthly", amount_minor: 25000 },
      ]),
    );
  });

  it("writes the device settings to device_prefs", async () => {
    await renderSettings("ios");

    await fireEvent.press(screen.getByRole("button", { name: "Tabs Position, Bottom" }));
    await fireEvent.press(screen.getByRole("radio", { name: "Top" }));
    await fireEvent(screen.getByRole("switch", { name: "App Lock" }), "valueChange", true);
    await fireEvent.press(screen.getByRole("button", { name: "Lock After, Immediately" }));
    await fireEvent.press(screen.getByRole("radio", { name: "After 5 minutes" }));

    await waitFor(() => {
      expect(devicePref("tabsPosition")).toBe("top");
      expect(devicePref("appLock")).toBe("on");
      expect(devicePref("lockAfterSeconds")).toBe("300");
    });
  });

  it("does not let App Lock turn on when the device has no passcode", async () => {
    mockEnrolledLevel.mockResolvedValue(0);
    await renderSettings("ios");

    expect(await screen.findByText("Set up a passcode on this device first")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "App Lock" }).props.disabled).toBe(true);
  });

  it("calls the handlers for Devices, Reset local data and Log out", async () => {
    const onOpenSessions = jest.fn();
    const onResetLocalData = jest.fn();
    const onLogout = jest.fn();
    await renderSettings("web", { onOpenSessions, onResetLocalData, onLogout });

    await fireEvent.press(screen.getByRole("button", { name: "Devices" }));
    await fireEvent.press(screen.getByRole("button", { name: "Reset local data" }));
    await fireEvent.press(screen.getByRole("button", { name: "Log out" }));

    expect(onOpenSessions).toHaveBeenCalled();
    expect(onResetLocalData).toHaveBeenCalled();
    expect(onLogout).toHaveBeenCalled();
  });
});

describe("SyncProblemsScreen", () => {
  beforeEach(() => {
    loadFixture(mockDb, {
      transactions: [{ id: "t-local", user_id: "u1", type: "expense", amount_minor: 100, date: "2026-10-01", name: "Here" }],
      sync_problems: [
        {
          id: "p1",
          table_name: "transactions",
          record_id: "t-new",
          op: "PUT",
          data_json: '{"name":"Lunch"}',
          code: "invalid_reference",
          message: "account does not exist",
          created_at: "2026-10-19T10:00:00Z",
        },
        {
          id: "p2",
          table_name: "categories",
          record_id: "c-gone",
          op: "DELETE",
          data_json: null,
          code: "in_use",
          message: "category is in use",
          created_at: "2026-10-19T10:01:00Z",
        },
        {
          id: "p3",
          table_name: "transactions",
          record_id: "t-local",
          op: "PATCH",
          data_json: '{"amount_minor":0}',
          code: "invalid_record",
          message: "at '/amount_minor': must be >= 1",
          created_at: "2026-10-19T10:02:00Z",
        },
        {
          id: "p4",
          table_name: "transactions",
          record_id: "t-missing",
          op: "PATCH",
          data_json: '{"name":"x"}',
          code: "not_found",
          message: "record does not exist",
          created_at: "2026-10-19T10:03:00Z",
        },
      ],
    });
  });

  it("lists each problem with its message", async () => {
    await render(<SyncProblemsScreen onEdit={noop} onClose={noop} />);

    expect(screen.getByText("account does not exist")).toBeTruthy();
    expect(screen.getByText("category is in use")).toBeTruthy();
    expect(screen.getByText("at '/amount_minor': must be >= 1")).toBeTruthy();
    expect(screen.getByText("record does not exist")).toBeTruthy();
  });

  it("offers Edit and retry only when the form can show the saved data", async () => {
    const onEdit = jest.fn();
    await render(<SyncProblemsScreen onEdit={onEdit} onClose={noop} />);

    const edits = screen.getAllByRole("button", { name: /^Edit and retry/ });
    expect(edits.map((b) => b.props.accessibilityLabel)).toEqual([
      "Edit and retry, account does not exist",
      "Edit and retry, at '/amount_minor': must be >= 1",
    ]);

    await fireEvent.press(edits[0]);
    expect(onEdit).toHaveBeenCalledWith({ problemId: "p1", table: "transactions", recordId: "t-new" });
  });

  it("deletes a problem on Discard", async () => {
    await render(<SyncProblemsScreen onEdit={noop} onClose={noop} />);

    await fireEvent.press(screen.getByRole("button", { name: "Discard, category is in use" }));

    expect(mockDb.prepare("SELECT id FROM sync_problems ORDER BY id").all()).toEqual([{ id: "p1" }, { id: "p3" }, { id: "p4" }]);
  });
});

describe("SessionsScreen", () => {
  function fakeApi(): jest.Mocked<SessionsApi> {
    return {
      list: jest.fn(async () => ({
        ok: true as const,
        value: [
          { id: "s1", device_name: "iPhone 16", created_at: "2026-10-01T10:00:00Z", last_used_at: "2026-10-19T09:00:00Z", current: false },
          { id: "s2", device_name: "Firefox", created_at: "2026-10-02T10:00:00Z", last_used_at: "2026-10-18T09:00:00Z", current: false },
        ],
      })),
      revoke: jest.fn(async (_id: string) => ({ ok: true as const, value: undefined })),
    };
  }

  it("lists the devices and marks the current one", async () => {
    const api = fakeApi();
    await render(<SessionsScreen api={api} currentSessionId="s1" onClose={noop} />);

    expect(await screen.findByText("iPhone 16")).toBeTruthy();
    expect(screen.getByText("Firefox")).toBeTruthy();
    expect(screen.getByText("This device")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke iPhone 16" })).toBeNull();
  });

  it("revokes another device and removes it from the list", async () => {
    const api = fakeApi();
    await render(<SessionsScreen api={api} currentSessionId="s1" onClose={noop} />);

    await fireEvent.press(await screen.findByRole("button", { name: "Revoke Firefox" }));

    expect(api.revoke).toHaveBeenCalledWith("s2");
    await waitFor(() => expect(screen.queryByText("Firefox")).toBeNull());
  });
});
