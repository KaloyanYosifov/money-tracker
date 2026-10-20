import { render } from "@testing-library/react-native";

import { RecurringGenerator } from "./recurringGenerator";

const mockStatus = { hasSynced: false };
const writeTransaction = jest.fn(async () => 0);
const mockDb = { writeTransaction };

jest.mock("@powersync/react", () => ({
  usePowerSync: () => mockDb,
  useStatus: () => mockStatus,
}));

beforeEach(() => {
  mockStatus.hasSynced = false;
  writeTransaction.mockClear();
});

it("runs generateDue once, after the first full sync", async () => {
  const { rerender, unmount } = await render(<RecurringGenerator />);
  expect(writeTransaction).not.toHaveBeenCalled();

  mockStatus.hasSynced = true;
  await rerender(<RecurringGenerator />);
  expect(writeTransaction).toHaveBeenCalledTimes(1);

  await rerender(<RecurringGenerator />);
  expect(writeTransaction).toHaveBeenCalledTimes(1);
  await unmount();
});
