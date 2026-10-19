import { PowerSyncDatabase } from "@powersync/web";

import type { AppDatabase } from "./db";
import { AppSchema } from "./schema";

// The worker and wasm files come from "powersync-web copy-assets" (the app
// postinstall script), which writes them to public/@powersync.
const WORKER = "/@powersync/worker.js";

export async function createDatabase(): Promise<AppDatabase> {
  return new PowerSyncDatabase({
    schema: AppSchema,
    database: {
      dbFilename: "money.db",
      worker: WORKER,
    },
    sync: {
      worker: WORKER,
    },
  });
}
