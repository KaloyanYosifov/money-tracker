import type { CommonPowerSyncDatabase } from "@powersync/common";

// Metro and Jest pick db.native.ts or db.web.ts. This file gives TypeScript
// the contract that both platform files implement.

export type AppDatabase = CommonPowerSyncDatabase;

export declare function createDatabase(): Promise<AppDatabase>;
