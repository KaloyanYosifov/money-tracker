import type {
  CommonPowerSyncDatabase,
  CrudEntry,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from "@powersync/common";

import { API_URL, POWERSYNC_URL } from "../config";
import { newId } from "../domain/ids";
import { SCHEMA_VERSION, type UploadOp } from "../generated/schema";

export interface ConnectorDeps {
  /** A valid access token, or null when signed out or offline. */
  getAccessToken(): Promise<string | null>;
  /** Gets a new access token even if the cached one has not expired. Null if the refresh failed. */
  refreshAccessToken(): Promise<string | null>;
  onReauthRequired(): void;
  onUpdateRequired(): void;
  now?: () => Date;
}

interface Rejection {
  index: number;
  code: string;
  message: string;
}

export function createConnector(deps: ConnectorDeps): PowerSyncBackendConnector {
  const now = deps.now ?? (() => new Date());

  function post(token: string, ops: UploadOp[]): Promise<Response> {
    return fetch(`${API_URL}/api/sync/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ schema_version: SCHEMA_VERSION, ops }),
    });
  }

  return {
    async fetchCredentials(): Promise<PowerSyncCredentials | null> {
      const token = await deps.getAccessToken();
      return token ? { endpoint: POWERSYNC_URL, token } : null;
    },

    async uploadData(database: CommonPowerSyncDatabase): Promise<void> {
      const transaction = await database.getNextCrudTransaction();
      if (!transaction) {
        return;
      }
      const ops = transaction.crud.map(toUploadOp);

      const token = await deps.getAccessToken();
      if (!token) {
        throw new Error("upload: no access token");
      }
      let res = await post(token, ops);
      if (res.status === 401) {
        const fresh = await deps.refreshAccessToken();
        if (!fresh) {
          deps.onReauthRequired();
          throw new Error("upload: refresh failed after 401");
        }
        res = await post(fresh, ops);
      }
      if (res.status === 426) {
        deps.onUpdateRequired();
        throw new Error("upload: app update required");
      }
      if (!res.ok) {
        throw new Error(`upload: HTTP ${res.status}`);
      }

      const { rejected = [] } = (await res.json()) as { rejected?: Rejection[] };
      if (rejected.length > 0) {
        const createdAt = now().toISOString();
        await database.writeTransaction(async (tx) => {
          for (const r of rejected) {
            const entry = transaction.crud[r.index];
            await tx.execute(
              "INSERT INTO sync_problems (id, table_name, record_id, op, data_json, code, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              [
                newId(),
                entry.table,
                entry.id,
                entry.op,
                entry.opData ? JSON.stringify(entry.opData) : null,
                r.code,
                r.message,
                createdAt,
              ],
            );
          }
        });
      }
      await transaction.complete();
    },
  };
}

function toUploadOp(entry: CrudEntry): UploadOp {
  const op: UploadOp = { op: entry.op, table: entry.table as UploadOp["table"], id: entry.id };
  if (entry.opData) {
    op.data = entry.opData;
  }
  return op;
}
