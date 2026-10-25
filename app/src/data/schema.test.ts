import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { ColumnType } from "@powersync/common";

import { AppSchema } from "./schema";

const schemaDir = join(__dirname, "../../../schema");

// Schema files use the singular record name. PowerSync tables use the database table name.
const tableForFile: Record<string, string> = {
  account: "accounts",
  budget: "budgets",
  category: "categories",
  insight: "insights",
  insight_question: "insight_questions",
  recurring_rule: "recurring_rules",
  transaction: "transactions",
  user_settings: "user_settings",
};

type JsonSchema = { properties: Record<string, { type: string | string[] }> };

function columnsOf(tableName: string): Record<string, ColumnType | undefined> {
  const table = AppSchema.tables.find((t) => t.name === tableName);
  if (!table) throw new Error(`no PowerSync table ${tableName}`);
  return Object.fromEntries(table.columns.map((c) => [c.name, c.type]));
}

function expectedType(type: string | string[]): ColumnType {
  const types = Array.isArray(type) ? type : [type];
  return types.includes("integer") || types.includes("boolean")
    ? ColumnType.INTEGER
    : ColumnType.TEXT;
}

const schemaFiles = readdirSync(schemaDir).filter(
  (f) => f.endsWith(".schema.json") && f !== "upload.schema.json",
);

describe("AppSchema", () => {
  it("covers every synced record schema", () => {
    expect(schemaFiles.map((f) => f.replace(".schema.json", "")).sort()).toEqual(
      Object.keys(tableForFile).sort(),
    );
  });

  it.each(schemaFiles)("matches %s", (file) => {
    const json = JSON.parse(readFileSync(join(schemaDir, file), "utf8")) as JsonSchema;
    const expected = Object.fromEntries(
      Object.entries(json.properties)
        .filter(([name]) => name !== "id")
        .map(([name, prop]) => [name, expectedType(prop.type)]),
    );
    expect(columnsOf(tableForFile[file.replace(".schema.json", "")])).toEqual(expected);
  });

  it("has the local-only device_prefs table", () => {
    const table = AppSchema.tables.find((t) => t.name === "device_prefs");
    expect(table?.localOnly).toBe(true);
    expect(columnsOf("device_prefs")).toEqual({
      key: ColumnType.TEXT,
      value: ColumnType.TEXT,
    });
  });

  it("has the local-only sync_problems table", () => {
    const table = AppSchema.tables.find((t) => t.name === "sync_problems");
    expect(table?.localOnly).toBe(true);
    expect(columnsOf("sync_problems")).toEqual({
      table_name: ColumnType.TEXT,
      record_id: ColumnType.TEXT,
      op: ColumnType.TEXT,
      data_json: ColumnType.TEXT,
      code: ColumnType.TEXT,
      message: ColumnType.TEXT,
      created_at: ColumnType.TEXT,
    });
  });

  it("indexes transactions on date, category_id and account_id", () => {
    const table = AppSchema.tables.find((t) => t.name === "transactions");
    const indexed = table?.indexes.flatMap((i) => i.columns.map((c) => c.name)).sort();
    expect(indexed).toEqual(["account_id", "category_id", "date"]);
  });
});
