import Database from "better-sqlite3";
import { ColumnType } from "@powersync/common";

import { AppSchema } from "../src/data/schema";

export type TestDatabase = Database.Database;

// Plain tables with the AppSchema names, columns and indexes. PowerSync exposes
// the same shape to app queries, so the tests run the exact app SQL.
export function createTestDatabase(): TestDatabase {
  const db = new Database(":memory:");
  for (const table of AppSchema.tables) {
    const columns = table.columns.map(
      (c) => `${c.name} ${c.type === ColumnType.INTEGER ? "INTEGER" : "TEXT"}`,
    );
    db.exec(`CREATE TABLE ${table.name} (id TEXT PRIMARY KEY, ${columns.join(", ")})`);
    for (const index of table.indexes) {
      const indexColumns = index.columns.map((c) => c.name).join(", ");
      db.exec(`CREATE INDEX ${table.name}_${index.name} ON ${table.name} (${indexColumns})`);
    }
  }
  return db;
}

export type Fixture = Record<string, Record<string, unknown>[]>;

// Inserts the rows of each table in one transaction. Columns that a row does
// not give are null. Booleans become 0 or 1.
export function loadFixture(db: TestDatabase, fixture: Fixture): void {
  db.transaction(() => {
    for (const [tableName, rows] of Object.entries(fixture)) {
      const table = AppSchema.tables.find((t) => t.name === tableName);
      if (!table) throw new Error(`no table ${tableName}`);
      const names = ["id", ...table.columns.map((c) => c.name)];
      const insert = db.prepare(
        `INSERT INTO ${tableName} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      );
      for (const row of rows) {
        insert.run(
          names.map((name) => {
            const value = row[name];
            if (typeof value === "boolean") return value ? 1 : 0;
            return value ?? null;
          }),
        );
      }
    }
  })();
}

export interface AsyncTestDatabase {
  execute(sql: string, parameters?: unknown[]): Promise<{ rowsAffected: number }>;
  getAll<T>(sql: string, parameters?: unknown[]): Promise<T[]>;
  getOptional<T>(sql: string, parameters?: unknown[]): Promise<T | null>;
  writeTransaction<T>(fn: (tx: AsyncTestDatabase) => Promise<T>): Promise<T>;
}

// The PowerSync read and write methods over better-sqlite3. writeTransaction
// passes the same object as tx, so a spy on execute also sees the writes in a
// transaction.
export function asyncDatabase(db: TestDatabase): AsyncTestDatabase {
  const adapter: AsyncTestDatabase = {
    async execute(sql, parameters = []) {
      const result = db.prepare(sql).run(parameters);
      return { rowsAffected: result.changes };
    },
    async getAll<T>(sql: string, parameters: unknown[] = []) {
      return db.prepare(sql).all(parameters) as T[];
    },
    async getOptional<T>(sql: string, parameters: unknown[] = []) {
      return (db.prepare(sql).get(parameters) as T | undefined) ?? null;
    },
    async writeTransaction(fn) {
      db.exec("BEGIN");
      try {
        const result = await fn(adapter);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return adapter;
}
