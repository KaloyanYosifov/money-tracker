// Imports a Spending Tracker backup (its SQLite file) through the upload API.
//
//   node scripts/import-spending-tracker.ts <backup-file> [--api <url>] [--mapping <path>]
//
// The first run writes mapping.json. Edit it, then run the script again to
// see the summary and import. The IDs come from the backup and the user, so a second
// import updates the same rows and creates no duplicates.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { isatty } from "node:tty";

import { SCHEMA_VERSION } from "../app/src/generated/schema.ts";
import {
  buildPlan,
  importId,
  proposeMapping,
  validateMapping,
  type Existing,
  type Mapping,
  type SourceData,
  type UploadOp,
} from "../app/src/import/spendingTracker/index.ts";

const BATCH_SIZE = 200;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isYes(answer: string): boolean {
  return /^y(es)?$/i.test(answer);
}

function parseArgs(argv: string[]) {
  const args = { backup: "", api: "http://localhost:18080", mapping: "mapping.json" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--api") args.api = argv[++i] ?? fail("--api needs a URL");
    else if (arg === "--mapping") args.mapping = argv[++i] ?? fail("--mapping needs a path");
    else if (!args.backup) args.backup = arg;
    else fail(`Unknown argument: ${arg}`);
  }
  if (!args.backup) fail("Usage: node scripts/import-spending-tracker.ts <backup-file> [--api <url>] [--mapping <path>]");
  args.api = args.api.replace(/\/+$/, "");
  if (!URL.canParse(args.api)) fail(`--api is not a URL: ${args.api}`);
  return args;
}

function readBackup(path: string): SourceData {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
    );
    for (const name of ["Profile", "Category", "Transaction", "RecurringTransaction"]) {
      if (!tables.has(name)) fail(`Not a Spending Tracker backup: table ${name} is missing`);
    }
    // The tick values are above Number.MAX_SAFE_INTEGER, so they come out as text.
    const ticks = (row: Record<string, unknown>, key: string) =>
      row[key] === null ? null : BigInt(row[key] as string);
    const all = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
    return {
      profiles: all(`SELECT Id, Name, Colour FROM Profile`) as unknown as SourceData["profiles"],
      categories: all(`SELECT Id, Name, Type, Icon, Colour FROM Category`) as unknown as SourceData["categories"],
      transactions: all(
        `SELECT Id, Type, CAST(Date AS TEXT) AS Date, Amount, Note, ProfileId, CategoryId, RecurringTransactionId
         FROM "Transaction"`,
      ).map((r) => ({ ...r, Date: ticks(r, "Date") })) as unknown as SourceData["transactions"],
      recurring: all(
        `SELECT Id, Type, CAST(Date AS TEXT) AS Date, CAST(EndDate AS TEXT) AS EndDate, Amount, Note,
           RecurringType, RecurringPeriod, ProfileId, CategoryId
         FROM RecurringTransaction`,
      ).map((r) => ({ ...r, Date: ticks(r, "Date"), EndDate: ticks(r, "EndDate") })) as unknown as SourceData["recurring"],
      strategies: (tables.has("Strategy")
        ? all(`SELECT ProfileId, CarryPositiveOnly FROM Strategy`)
        : []) as unknown as SourceData["strategies"],
    };
  } finally {
    db.close();
  }
}

// Piped input is read once: a second readline interface does not get the lines
// that the first one buffered.
let pipedLines: string[] | null = null;
// isatty does not open process.stdin. An open stdin pipe is non-blocking, and
// readFileSync(0) then fails with EAGAIN.
const interactive = isatty(0);

async function ask(question: string): Promise<string> {
  if (!interactive) {
    pipedLines ??= readFileSync(0, "utf8").split(/\r?\n/);
    process.stdout.write(`${question}\n`);
    return (pipedLines.shift() ?? "").trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// Reads a line with no echo. Without a terminal (piped input) it reads the next piped line.
function askSecret(question: string): Promise<string> {
  if (!interactive) return ask(question);
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") process.exit(130);
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function postJson(url: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

async function errorCode(res: Response): Promise<string> {
  const text = await res.text();
  try {
    return (JSON.parse(text) as { error?: string }).error ?? `status ${res.status}`;
  } catch {
    return `status ${res.status}`;
  }
}

async function login(api: string): Promise<{ token: string; userId: string }> {
  const email = process.env.MT_EMAIL || (await ask("Email: "));
  const password = process.env.MT_PASSWORD || (await askSecret("Password: "));
  const device_name = "import-spending-tracker";
  let res = await postJson(`${api}/api/auth/login`, { email, password, device_name });
  if (!res.ok) fail(`Login failed: ${await errorCode(res)}`);
  let body = (await res.json()) as { mfa_token?: string; access_token?: string; user_id?: string };
  if (body.mfa_token) {
    const code = await ask("TOTP code: ");
    res = await postJson(`${api}/api/auth/login/totp`, { mfa_token: body.mfa_token, code, device_name });
    if (!res.ok) fail(`Login failed: ${await errorCode(res)}`);
    body = (await res.json()) as typeof body;
  }
  if (!body.access_token || !body.user_id) fail("Login failed: the response has no access token");
  return { token: body.access_token, userId: body.user_id };
}

async function readExisting(api: string, token: string): Promise<Existing> {
  const res = await fetch(`${api}/api/import/existing`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) fail(`GET /api/import/existing failed: ${await errorCode(res)}`);
  return (await res.json()) as Existing;
}

function localDate(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

type Rejected = { op: UploadOp; code: string; message: string };

async function sendBatch(api: string, token: string, ops: UploadOp[]): Promise<Response | null> {
  try {
    return await postJson(`${api}/api/sync/upload`, { schema_version: SCHEMA_VERSION, ops }, token);
  } catch {
    return null;
  }
}

async function upload(api: string, token: string, ops: UploadOp[]): Promise<Rejected[]> {
  const rejected: Rejected[] = [];
  const total = Math.ceil(ops.length / BATCH_SIZE);
  for (let n = 0; n < total; n++) {
    const batch = ops.slice(n * BATCH_SIZE, (n + 1) * BATCH_SIZE);
    let res = await sendBatch(api, token, batch);
    if (res === null || res.status === 503) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      res = await sendBatch(api, token, batch);
      if (res === null || res.status === 503) {
        fail(`Upload stopped at batch ${n + 1}. Run the script again; it does not create duplicates.`);
      }
    }
    if (res.status === 401) fail("The session expired. Run the script again; it does not create duplicates.");
    if (res.status !== 200) fail(`Upload failed with status ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { rejected: { index: number; code: string; message: string }[] };
    for (const r of body.rejected) rejected.push({ op: batch[r.index], code: r.code, message: r.message });
    console.log(`batch ${n + 1}/${total}`);
  }
  return rejected;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.backup)) fail(`No such file: ${args.backup}`);
  let source: SourceData;
  try {
    source = readBackup(args.backup);
  } catch (err) {
    fail(`Cannot read ${args.backup} as a Spending Tracker backup: ${errorText(err)}`);
  }

  const { protocol, hostname } = new URL(args.api);
  if (protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
    console.log(`Warning: ${args.api} is not a local address, and http:// sends the password as plain text.`);
    if (!isYes(await ask("Continue? (y/N) "))) return;
  }

  let token: string, userId: string, existing: Existing;
  try {
    ({ token, userId } = await login(args.api));
    existing = await readExisting(args.api, token);
  } catch (err) {
    fail(`Cannot reach ${args.api}: ${errorText(err)}`);
  }

  if (!existsSync(args.mapping)) {
    writeFileSync(args.mapping, `${JSON.stringify(proposeMapping(source, existing), null, 2)}\n`);
    console.log(`Wrote ${args.mapping}. Edit it, then run the script again.`);
    return;
  }

  let mapping: Mapping;
  try {
    mapping = JSON.parse(readFileSync(args.mapping, "utf8")) as Mapping;
  } catch (err) {
    fail(`Cannot read ${args.mapping}: ${errorText(err)}`);
  }
  const errors = validateMapping(source, mapping, existing);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }

  const hash = createHash("sha256").update(readFileSync(args.backup)).digest("hex");
  const plan = buildPlan(source, mapping, existing, {
    userId,
    importBatchId: importId("batch", hash, userId),
    today: localDate(),
  });

  if (mapping.currency !== existing.currency_code) {
    console.log(`Warning: the mapping currency ${mapping.currency} is not the account currency ${existing.currency_code || "(none)"}.`);
  }
  for (const [key, count] of Object.entries(plan.counts)) console.log(`${key}: ${count}`);
  const groups = new Map<string, string[]>();
  for (const p of plan.problems) groups.set(p.kind, [...(groups.get(p.kind) ?? []), p.message]);
  for (const [kind, messages] of groups) {
    console.log(`\n${kind}: ${messages.length}`);
    for (const message of messages.slice(0, 10)) console.log(`  ${message}`);
  }

  if (!isYes(await ask("\nImport? (y/N) "))) return;

  const rejected = await upload(args.api, token, plan.ops);
  console.log(`Applied ${plan.ops.length - rejected.length} ops.`);
  for (const r of rejected) {
    const externalId = r.op.data.external_id ? ` ${String(r.op.data.external_id)}` : "";
    console.log(`Rejected ${r.op.table} ${r.op.id}${externalId}: ${r.code} ${r.message}`);
  }
  if (rejected.length > 0) process.exit(1);
}

await main();
