import type {
  CommonPowerSyncDatabase,
  CrudEntry,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from "@powersync/common";

import { API_URL, getPowerSyncUrl } from "../config";
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

// The maxItems of ops in schema/upload.schema.json.
const MAX_OPS = 200;

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
      return token ? { endpoint: await getPowerSyncUrl(), token } : null;
    },

    async uploadData(database: CommonPowerSyncDatabase): Promise<void> {
      const transaction = await database.getNextCrudTransaction();
      if (!transaction) {
        return;
      }
      const ops = transaction.crud.map(toUploadOp);

      const firstToken = await deps.getAccessToken();
      if (!firstToken) {
        throw new Error("upload: no access token");
      }
      let token = firstToken;
      const rejected: Rejection[] = [];

      // Sends one part. A permanent 400 or 413 rolls back the whole request on
      // the server, so a part of more than one op is split in halves and sent
      // again, in order. Only an op that fails alone becomes a sync problem.
      async function send(part: UploadOp[], offset: number): Promise<void> {
        let res = await post(token, part);
        if (res.status === 401) {
          const fresh = await deps.refreshAccessToken();
          if (!fresh) {
            deps.onReauthRequired();
            throw new Error("upload: refresh failed after 401");
          }
          token = fresh;
          res = await post(token, part);
        }
        if (res.status === 426) {
          deps.onUpdateRequired();
          throw new Error("upload: app update required");
        }
        const failure = await permanentFailure(res);
        if (failure) {
          if (part.length > 1) {
            const half = Math.ceil(part.length / 2);
            await send(part.slice(0, half), offset);
            await send(part.slice(half), offset + half);
            return;
          }
          // The same request will never pass. Keep the op as a sync problem,
          // so that it does not block the upload queue.
          rejected.push({ index: offset, code: failure.code, message: `The server did not accept the upload (HTTP ${res.status}).` });
          return;
        }
        if (!res.ok) {
          throw new Error(`upload: HTTP ${res.status}`);
        }
        const body = (await res.json()) as { rejected?: Rejection[] };
        for (const r of body.rejected ?? []) rejected.push({ ...r, index: r.index + offset });
      }

      // The API takes at most MAX_OPS ops per request, and one local
      // transaction can hold more (the recurring generator, for example).
      // Upserts by UUID are safe to send again if a later part fails.
      for (let offset = 0; offset < ops.length; offset += MAX_OPS) {
        await send(ops.slice(offset, offset + MAX_OPS), offset);
      }

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

// The upload handler refuses a body that it will refuse again with 400 and
// its JSON error ({"error": "<code>"}), or with 413 (body too large, plain
// text from the body limit). A 400 without that body can come from a proxy,
// so it is retried, as are all other statuses. Null when not permanent.
async function permanentFailure(res: Response): Promise<{ code: string } | null> {
  if (res.status === 413) return { code: (await errorCode(res)) ?? "http_413" };
  if (res.status !== 400) return null;
  const code = await errorCode(res);
  return code ? { code } : null;
}

/** The "error" field of a JSON error body. */
async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    return typeof body?.error === "string" && body.error !== "" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

// SQLite stores these as 0/1, but the server schema wants JSON booleans.
const booleanColumns: Partial<Record<string, readonly string[]>> = {
  user_settings: ["budget_mode", "carry_over", "hide_future", "show_note", "insights_enabled"],
};

function toUploadOp(entry: CrudEntry): UploadOp {
  const op: UploadOp = { op: entry.op, table: entry.table as UploadOp["table"], id: entry.id };
  if (entry.opData) {
    const data: Record<string, unknown> = { ...entry.opData };
    for (const column of booleanColumns[entry.table] ?? []) {
      if (typeof data[column] === "number") {
        data[column] = data[column] !== 0;
      }
    }
    op.data = data;
  }
  return op;
}
