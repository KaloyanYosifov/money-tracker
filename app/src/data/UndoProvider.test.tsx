import { useEffect } from "react";
import { AppState, Text } from "react-native";
import { act, render, screen } from "@testing-library/react-native";

import { UNDO_DELAY_MS, UndoProvider, useUndo, type UndoApi } from "./UndoProvider";

const rows = ["t1", "t2", "t3"];

let undoApi: UndoApi;

function List() {
  const api = useUndo();
  useEffect(() => {
    undoApi = api;
  });
  return (
    <>
      {rows
        .filter((id) => !api.hiddenIds.has(id))
        .map((id) => (
          <Text key={id}>{id}</Text>
        ))}
    </>
  );
}

let execute: jest.Mock;
let appStateListener: ((state: string) => void) | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  execute = jest.fn().mockResolvedValue({ rowsAffected: 1 });
  appStateListener = undefined;
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    appStateListener = listener as (state: string) => void;
    return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function renderList() {
  await render(
    <UndoProvider db={{ execute }}>
      <List />
    </UndoProvider>,
  );
}

it("hides the row from lists at once", async () => {
  await renderList();

  await act(async () => undoApi.requestDelete("t1"));

  expect(screen.queryByText("t1")).toBeNull();
  expect(screen.getByText("t2")).toBeTruthy();
  expect(execute).not.toHaveBeenCalled();
});

it("runs the real DELETE after 5 seconds", async () => {
  await renderList();
  await act(async () => undoApi.requestDelete("t1"));

  await act(async () => jest.advanceTimersByTime(UNDO_DELAY_MS - 1));
  expect(execute).not.toHaveBeenCalled();

  await act(async () => jest.advanceTimersByTime(1));
  expect(UNDO_DELAY_MS).toBe(5000);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledWith("DELETE FROM transactions WHERE id = ?", ["t1"]);
});

it("restores the row on undo, and no delete runs", async () => {
  await renderList();
  await act(async () => undoApi.requestDelete("t1"));

  await act(async () => jest.advanceTimersByTime(4000));
  let undone = false;
  await act(async () => {
    undone = undoApi.undo();
  });

  expect(undone).toBe(true);
  expect(screen.getByText("t1")).toBeTruthy();
  await act(async () => jest.advanceTimersByTime(10_000));
  expect(execute).not.toHaveBeenCalled();
});

it("runs all pending deletes at once when the app goes to the background", async () => {
  await renderList();
  await act(async () => undoApi.requestDelete("t1"));
  await act(async () => undoApi.requestDelete("t2"));

  await act(async () => appStateListener?.("background"));

  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenCalledWith("DELETE FROM transactions WHERE id = ?", ["t1"]);
  expect(execute).toHaveBeenCalledWith("DELETE FROM transactions WHERE id = ?", ["t2"]);
  await act(async () => jest.advanceTimersByTime(10_000));
  expect(execute).toHaveBeenCalledTimes(2);
});

it("has nothing to undo after the app went to the background", async () => {
  await renderList();
  await act(async () => undoApi.requestDelete("t1"));
  expect([...undoApi.pendingIds]).toEqual(["t1"]);

  await act(async () => appStateListener?.("inactive"));

  expect(undoApi.pendingIds.size).toBe(0);
  let undone = true;
  await act(async () => {
    undone = undoApi.undo();
  });
  expect(undone).toBe(false);
  expect(screen.queryByText("t1")).toBeNull();
});

// The jest-expo environment has no DOM, so these tests give it a small window
// and document that dispatch events.
describe("on the web", () => {
  let visibility: DocumentVisibilityState;
  let page: EventTarget;
  let doc: EventTarget;
  const globals = globalThis as Record<string, unknown>;
  const saved = { window: globals.window, document: globals.document };

  beforeEach(() => {
    visibility = "visible";
    page = new EventTarget();
    doc = new EventTarget();
    Object.defineProperty(doc, "visibilityState", { get: () => visibility });
    globals.window = page;
    globals.document = doc;
  });

  afterEach(() => {
    globals.window = saved.window;
    globals.document = saved.document;
  });

  it("runs the pending deletes when the page is hidden", async () => {
    await renderList();
    await act(async () => undoApi.requestDelete("t1"));

    await act(async () => doc.dispatchEvent(new Event("visibilitychange")));
    expect(execute).not.toHaveBeenCalled();

    visibility = "hidden";
    await act(async () => doc.dispatchEvent(new Event("visibilitychange")));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("DELETE FROM transactions WHERE id = ?", ["t1"]);
    expect(undoApi.pendingIds.size).toBe(0);
    let undone = true;
    await act(async () => {
      undone = undoApi.undo();
    });
    expect(undone).toBe(false);
    expect(screen.queryByText("t1")).toBeNull();
  });

  it("runs the pending deletes on pagehide, once", async () => {
    await renderList();
    await act(async () => undoApi.requestDelete("t1"));

    await act(async () => page.dispatchEvent(new Event("pagehide")));
    await act(async () => page.dispatchEvent(new Event("pagehide")));
    await act(async () => jest.advanceTimersByTime(10_000));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("DELETE FROM transactions WHERE id = ?", ["t1"]);
  });
});
