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
  await act(async () => undoApi.undo());

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
