import { PowerSyncDatabase } from "@powersync/react-native";

import type { AppDatabase } from "./db";
import { getEncryptionKey } from "./encryptionKey.native";
import { AppSchema } from "./schema";

// PowerSync React Native v2 opens op-sqlite through its built-in
// OPSqliteOpenFactory. The encryption key needs "op-sqlite": { "sqlcipher": true }
// in package.json.
export async function createDatabase(): Promise<AppDatabase> {
  const encryptionKey = await getEncryptionKey();
  return new PowerSyncDatabase({
    schema: AppSchema,
    database: {
      dbFilename: "money.db",
      sqliteOptions: { encryptionKey },
    },
  });
}
