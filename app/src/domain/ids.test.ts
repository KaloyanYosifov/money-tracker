import { newId, occurrenceId } from "./ids";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId", () => {
  it("returns a UUID v4", () => {
    expect(newId()).toMatch(UUID_V4);
  });

  it("returns a different value each time", () => {
    expect(newId()).not.toBe(newId());
  });
});

describe("occurrenceId", () => {
  const ruleId = "3f2c9a7e-1b4d-4e8a-9c61-0d5e7f8a2b13";

  it("returns a UUID v5", () => {
    expect(occurrenceId(ruleId, "2026-10-01")).toMatch(UUID_V5);
  });

  it("returns a fixed value for the same rule and date", () => {
    expect(occurrenceId(ruleId, "2026-10-01")).toBe("5c3047cf-ae07-5f76-8680-cb104cb75298");
    expect(occurrenceId(ruleId, "2026-10-01")).toBe(occurrenceId(ruleId, "2026-10-01"));
  });

  it("returns a different value for a different date", () => {
    expect(occurrenceId(ruleId, "2026-10-02")).not.toBe(occurrenceId(ruleId, "2026-10-01"));
  });
});
