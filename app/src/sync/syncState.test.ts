import { deriveSyncState, type SyncStateInput } from "./syncState";

const now = new Date("2026-10-19T12:00:00Z");

function input(overrides: Partial<SyncStateInput> = {}, status: Partial<SyncStateInput["status"]> = {}): SyncStateInput {
  return {
    status: {
      connected: true,
      uploading: false,
      downloading: false,
      lastSyncedAt: new Date(now.getTime() - 60_000),
      ...status,
    },
    pendingCount: 0,
    problemCount: 0,
    auth: "signedIn",
    updateRequired: false,
    now,
    ...overrides,
  };
}

describe("deriveSyncState", () => {
  it("is synced when connected and idle", () => {
    expect(deriveSyncState(input())).toEqual({ kind: "synced", label: "Synced 1 min ago · 0 pending" });
  });

  it("shows 'just now' for a sync less than a minute ago", () => {
    const state = deriveSyncState(input({}, { lastSyncedAt: new Date(now.getTime() - 20_000) }));
    expect(state.label).toBe("Synced just now · 0 pending");
  });

  it("shows hours and days for older syncs", () => {
    expect(deriveSyncState(input({}, { lastSyncedAt: new Date(now.getTime() - 3 * 3_600_000) })).label).toBe(
      "Synced 3 h ago · 0 pending",
    );
    expect(deriveSyncState(input({}, { lastSyncedAt: new Date(now.getTime() - 2 * 86_400_000) })).label).toBe(
      "Synced 2 d ago · 0 pending",
    );
  });

  it("says when it never synced", () => {
    expect(deriveSyncState(input({}, { lastSyncedAt: undefined })).label).toBe("Not synced yet · 0 pending");
  });

  it("is syncing when uploading or downloading", () => {
    expect(deriveSyncState(input({ pendingCount: 3 }, { uploading: true }))).toEqual({
      kind: "syncing",
      label: "Syncing · 3 pending",
    });
    expect(deriveSyncState(input({}, { downloading: true })).kind).toBe("syncing");
  });

  it("is offline when not connected", () => {
    expect(deriveSyncState(input({ pendingCount: 2 }, { connected: false, uploading: true }))).toEqual({
      kind: "offline",
      label: "Offline · 2 pending",
    });
  });

  it("needs attention when problems exist, also offline", () => {
    expect(deriveSyncState(input({ problemCount: 1 }, { connected: false }))).toEqual({
      kind: "needsAttention",
      label: "Needs attention · 1 problem",
    });
    expect(deriveSyncState(input({ problemCount: 4 })).label).toBe("Needs attention · 4 problems");
  });

  it("asks to log in again before problems", () => {
    expect(deriveSyncState(input({ auth: "reauthRequired", problemCount: 2 }, { connected: false }))).toEqual({
      kind: "reauthRequired",
      label: "Log in again",
    });
  });

  it("puts updateRequired first", () => {
    expect(
      deriveSyncState(input({ updateRequired: true, auth: "reauthRequired", problemCount: 2 }, { connected: false })),
    ).toEqual({ kind: "updateRequired", label: "Update required" });
  });
});
