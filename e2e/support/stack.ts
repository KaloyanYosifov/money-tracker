import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
// The e2e stack is its own Compose project with its own database (see docker-compose.e2e.yml),
// so resetData never touches the dev stack.
const COMPOSE_FILES = ["deploy/compose/docker-compose.yml", "deploy/compose/docker-compose.e2e.yml"];

/** The API through the Toxiproxy `api` proxy. */
export const API_URL = process.env.E2E_API_URL ?? "http://localhost:28080";
/** PowerSync through the Toxiproxy `powersync` proxy. */
export const POWERSYNC_URL = process.env.E2E_POWERSYNC_URL ?? "http://localhost:28081";
/** The web app (nginx), which also proxies /api. */
export const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:28088";

/** Runs `docker compose <args>` for the e2e stack and returns stdout. */
export function compose(args: string[], input?: string): string {
  return execFileSync("docker", ["compose", ...COMPOSE_FILES.flatMap((file) => ["-f", file]), ...args], {
    cwd: REPO_ROOT,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export interface PsqlOptions {
  /** psql variables. Use them in the SQL as :'name' (literal) or :"name" (identifier). */
  vars?: Record<string, string>;
  /** Runs the SQL in a read-only transaction. */
  readOnly?: boolean;
}

/** Runs SQL with psql in the postgres container and returns the rows (tab-separated, no header). */
export function psql(sql: string, options: PsqlOptions = {}): string[][] {
  const args = ["exec", "-T"];
  if (options.readOnly) {
    args.push("-e", "PGOPTIONS=-c default_transaction_read_only=on");
  }
  args.push("postgres", "psql", "-U", "money", "-d", "money", "-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1");
  for (const [name, value] of Object.entries(options.vars ?? {})) {
    args.push("-v", `${name}=${value}`);
  }
  // The SQL goes through stdin, because psql does not interpolate variables in -c.
  const out = compose(args, sql);
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t"));
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Waits until PostgreSQL, the API, PowerSync and the web app answer.
 * Throws when the stack is not healthy before the timeout.
 */
export async function waitForStack(timeoutMs = 60_000): Promise<void> {
  const checks: Record<string, () => Promise<boolean>> = {
    postgres: async () => {
      try {
        return psql("SELECT 1", { readOnly: true })[0]?.[0] === "1";
      } catch {
        return false;
      }
    },
    api: () => isUp(`${API_URL}/healthz`),
    powersync: () => isUp(`${POWERSYNC_URL}/probes/liveness`),
    web: () => isUp(WEB_URL),
  };
  const deadline = Date.now() + timeoutMs;
  let failing: string[] = Object.keys(checks);
  while (Date.now() < deadline) {
    const results = await Promise.all(
      Object.entries(checks).map(async ([name, check]) => [name, await check()] as const),
    );
    failing = results.filter(([, ok]) => !ok).map(([name]) => name);
    if (failing.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`stack is not healthy: ${failing.join(", ")} did not answer. Run "make e2e-stack-up".`);
}

const USER_TABLES = [
  "transactions",
  "recurring_rules",
  "budgets",
  "categories",
  "accounts",
  "user_settings",
  "deleted_records",
  "recovery_codes",
  "refresh_tokens",
  "invites",
  "users",
];

/** Deletes all user data. Call it between test files. It restarts no container. */
export function resetData(): void {
  psql(`TRUNCATE ${USER_TABLES.join(", ")} CASCADE;`);
}
