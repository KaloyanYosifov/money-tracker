import { validateSwap, type SwapInput } from "./validation";

const valid: SwapInput = {
  from_instrument_id: "i1",
  to_instrument_id: "i2",
  date: "2026-05-04",
  from_quantity: "1",
  to_quantity: "2498",
  fee: "2",
  value: "2500",
  to_value: "2500",
  note: "Test swap",
};

describe("validateSwap", () => {
  it("accepts a valid swap", () => {
    expect(validateSwap(valid)).toEqual([]);
  });

  it.each([
    ["missing from_instrument_id", { from_instrument_id: "" }, "from_instrument_id", "required"],
    ["missing to_instrument_id", { to_instrument_id: "" }, "to_instrument_id", "required"],
    ["the same instrument on both sides", { to_instrument_id: "i1" }, "to_instrument_id", "same_instrument"],
    ["a bad date", { date: "2026-02-30" }, "date", "invalid"],
    ["a zero from_quantity", { from_quantity: "0" }, "from_quantity", "invalid"],
    ["a to_quantity that is not a number", { to_quantity: "abc" }, "to_quantity", "invalid"],
    ["a zero value", { value: "0" }, "value", "invalid"],
    ["an empty to_value", { to_value: "" }, "to_value", "invalid"],
    ["a negative fee", { fee: "-1" }, "fee", "invalid"],
    ["a note of 201 characters", { note: "a".repeat(201) }, "note", "too_long"],
  ] as const)("rejects %s", (_name, change, field, code) => {
    expect(validateSwap({ ...valid, ...change })).toEqual([{ field, code }]);
  });
});
