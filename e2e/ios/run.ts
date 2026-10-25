/**
 * Runs the Maestro flows in app/e2e/maestro against the local Compose stack.
 * It needs macOS with Xcode, the iOS simulators and the Maestro CLI.
 *
 * Env: IOS_PHONE_SIMULATOR and IOS_TABLET_SIMULATOR select the simulators by
 * name. Without them the first available iPhone and iPad are used.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { query } from "../support/db.ts";
import { runMaestroFlow } from "../support/maestro.ts";
import { API_URL, POWERSYNC_URL, psql, resetData, waitForStack } from "../support/stack.ts";
import { codeAt, msLeftInStep } from "../support/totp.ts";
import { goOffline, goOnline, resetProxies } from "../support/toxiproxy.ts";
import { createUser, type TestUser } from "../support/users.ts";

const APP_DIR = fileURLToPath(new URL("../../app/", import.meta.url));
const FLOWS_DIR = fileURLToPath(new URL("../../app/e2e/maestro/", import.meta.url));
const BUNDLE_ID = "com.kyosifov.moneytracker";
const STEP_MS = 30_000;
// login.yaml launches the app, logs in and waits for the TOTP screen before it types the code.
const MIN_LEFT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function output(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// --- Simulators -------------------------------------------------------------

interface Simulator {
  udid: string;
  name: string;
  state: string;
}

function findSimulator(prefix: "iPhone" | "iPad", name: string | undefined): Simulator {
  const list = JSON.parse(output("xcrun", ["simctl", "list", "devices", "available", "--json"])) as {
    devices: Record<string, Simulator[]>;
  };
  // The newest iOS runtime sorts last.
  const runtimes = Object.keys(list.devices)
    .filter((runtime) => runtime.includes("iOS"))
    .sort()
    .reverse();
  for (const runtime of runtimes) {
    const found = list.devices[runtime].find((sim) => (name ? sim.name === name : sim.name.startsWith(prefix)));
    if (found) return found;
  }
  throw new Error(`no available ${prefix} simulator${name ? ` named "${name}"` : ""}`);
}

function boot(sim: Simulator): void {
  if (sim.state !== "Booted") {
    run("xcrun", ["simctl", "boot", sim.udid]);
  }
  run("xcrun", ["simctl", "bootstatus", sim.udid, "-b"]);
}

/** Builds the Release app once and installs it on the phone simulator. */
function buildApp(phone: Simulator): void {
  run("npx", ["expo", "run:ios", "--configuration", "Release", "--no-bundler", "--device", phone.udid], {
    cwd: APP_DIR,
    env: { ...process.env, EXPO_PUBLIC_API_URL: API_URL, EXPO_PUBLIC_POWERSYNC_URL: POWERSYNC_URL },
  });
}

/** Installs the app that the build put on the phone simulator onto another simulator. */
function copyApp(from: Simulator, to: Simulator): void {
  const appPath = output("xcrun", ["simctl", "get_app_container", from.udid, BUNDLE_ID, "app"]).trim();
  run("xcrun", ["simctl", "install", to.udid, appPath]);
}

function notify(sim: Simulator, args: string[]): void {
  run("xcrun", ["simctl", "spawn", sim.udid, "notifyutil", ...args]);
}

function enrollFaceId(sim: Simulator): void {
  notify(sim, ["-s", "com.apple.BiometricKit.enrollmentChanged", "1"]);
  notify(sim, ["-p", "com.apple.BiometricKit.enrollmentChanged"]);
}

function faceIdResult(sim: Simulator, match: boolean): void {
  notify(sim, ["-p", `com.apple.BiometricKit_Sim.pearl.${match ? "match" : "nomatch"}`]);
}

// --- Maestro ----------------------------------------------------------------

function maestro(sim: Simulator, flow: string, env: Record<string, string> = {}): void {
  console.log(`\n▶ ${flow}${env.PHASE ? ` (${env.PHASE})` : ""} on ${sim.name}`);
  runMaestroFlow(sim.udid, `${FLOWS_DIR}${flow}`, env);
}

// The API accepts each TOTP step only once per user. createUser uses the
// current step, so the login waits for a later one.
const lastStep = new Map<string, number>();

async function nextCode(secret: string): Promise<string> {
  for (;;) {
    const now = Date.now();
    const step = Math.floor(now / STEP_MS);
    if (step > (lastStep.get(secret) ?? -1) && msLeftInStep(now) >= MIN_LEFT_MS) {
      lastStep.set(secret, step);
      return codeAt(secret, now);
    }
    await sleep(msLeftInStep(now) + 50);
  }
}

async function newUser(): Promise<TestUser> {
  const user = await createUser();
  lastStep.set(user.totpSecret, Math.floor(Date.now() / STEP_MS));
  return user;
}

/** Runs login.yaml for a new user, with a TOTP code made right before the flow starts. */
async function logIn(sim: Simulator): Promise<TestUser> {
  const user = await newUser();
  maestro(sim, "login.yaml", { EMAIL: user.email, PASSWORD: user.password, TOTP_CODE: await nextCode(user.totpSecret) });
  return user;
}

// --- Checks -----------------------------------------------------------------

async function waitUntil(what: string, check: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(1000);
  }
  throw new Error(`timed out: ${what}`);
}

function transactionsNamed(userId: string, name: string): number {
  const rows = query("SELECT count(*) FROM transactions WHERE user_id = :'user_id' AND name = :'name';", {
    user_id: userId,
    name,
  });
  return Number(rows[0][0]);
}

function transactionCount(userId: string): number {
  return Number(query("SELECT count(*) FROM transactions WHERE user_id = :'user_id';", { user_id: userId })[0][0]);
}

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface HierarchyNode {
  attributes?: Record<string, string>;
  children?: HierarchyNode[];
}

function hierarchyOf(sim: Simulator): HierarchyNode {
  const text = output("maestro", ["--device", sim.udid, "hierarchy"]);
  // Maestro can print its own log lines to stdout right after the JSON, for example
  // "2026-10-22T17:52:53.381582Z Thread-2 ERROR ..." when it stops its iOS driver.
  const log = text.search(/\d{4}-\d{2}-\d{2}T[\d:.]+Z Thread-\d+ /);
  return JSON.parse(log === -1 ? text : text.slice(0, log)) as HierarchyNode;
}

function parseBounds(text: string | undefined): Bounds | null {
  const n = text?.match(/-?\d+(\.\d+)?/g)?.map(Number);
  return n && n.length === 4 ? { left: n[0], top: n[1], right: n[2], bottom: n[3] } : null;
}

/** The first element with this testID (resource-id), from `maestro hierarchy`. */
function findNode(node: HierarchyNode, id: string): HierarchyNode | null {
  const attrs = node.attributes ?? {};
  if (attrs["resource-id"] === id && attrs.bounds) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** The screen bounds of the first element with this testID. */
function findBounds(node: HierarchyNode, id: string): Bounds | null {
  return parseBounds(findNode(node, id)?.attributes?.bounds);
}

/**
 * Turns off password AutoFill. With it on, iOS shows a "Save Password?" sheet after the
 * login. The sheet covers the app, and Maestro cannot see or close it, because a system
 * process draws it. A tap on the settings row does not move the switch, so this taps the
 * switch itself, at the right end of the row.
 */
function turnOffPasswordAutoFill(sim: Simulator): void {
  maestro(sim, "setup-simulator.yaml");
  const isOn = () => findNode(hierarchyOf(sim), "AutoFillToggle")?.attributes?.checked === "true";
  if (isOn()) {
    const row = findBounds(hierarchyOf(sim), "AutoFillToggle");
    if (!row) throw new Error("the AutoFill switch is not on screen");
    // Maestro takes a point in the same units as the bounds in its hierarchy.
    const x = Math.round(row.right - 35);
    const y = Math.round((row.top + row.bottom) / 2);
    const flow = join(mkdtempSync(join(tmpdir(), "mt-e2e-")), "tap-autofill.yaml");
    writeFileSync(flow, `appId: com.apple.Preferences\n---\n- tapOn:\n    point: "${x},${y}"\n`);
    run("maestro", ["--device", sim.udid, "test", flow]);
    if (isOn()) throw new Error(`password AutoFill is still on in ${sim.name}`);
  }
  run("xcrun", ["simctl", "terminate", sim.udid, "com.apple.Preferences"]);
}

function expectSideBySide(sim: Simulator, leftId: string, rightId: string): void {
  const hierarchy = hierarchyOf(sim);
  const left = findBounds(hierarchy, leftId);
  const right = findBounds(hierarchy, rightId);
  if (!left || !right) throw new Error(`not on screen: ${!left ? leftId : rightId}`);
  const besideEachOther = left.right <= right.left;
  const overlapVertically = left.top < right.bottom && right.top < left.bottom;
  if (!besideEachOther || !overlapVertically) {
    throw new Error(`${leftId} ${JSON.stringify(left)} and ${rightId} ${JSON.stringify(right)} are not side by side`);
  }
}

// --- Suite ------------------------------------------------------------------

async function main(): Promise<void> {
  const phone = findSimulator("iPhone", process.env.IOS_PHONE_SIMULATOR);
  const tablet = findSimulator("iPad", process.env.IOS_TABLET_SIMULATOR);
  boot(phone);
  turnOffPasswordAutoFill(phone);
  // Build before the first request to the stack. The build takes minutes, and Docker closes an
  // idle keep-alive connection in that time, so a request after it fails with "other side closed".
  buildApp(phone);

  // A run that stopped while offline leaves the proxies off, so reset them before the health check.
  await resetProxies();
  await waitForStack();
  resetData();

  // login.yaml is also the login test.
  await logIn(phone);

  {
    const user = await logIn(phone);
    maestro(phone, "add-edit-delete.yaml", { PHASE: "add-edit" });
    await waitUntil("the edit synced", () => transactionsNamed(user.userId, "E2E Latte") === 1);
    if (transactionsNamed(user.userId, "E2E Coffee") !== 0) throw new Error("the old name is still on the server");
    maestro(phone, "add-edit-delete.yaml", { PHASE: "delete" });
    await waitUntil("the delete synced", () => transactionsNamed(user.userId, "E2E Latte") === 0, 30_000);
    const tombstones = query(
      "SELECT count(*) FROM deleted_records WHERE user_id = :'user_id' AND table_name = 'transactions';",
      { user_id: user.userId },
    );
    if (tombstones[0][0] !== "1") throw new Error(`expected 1 deleted transaction, got ${tombstones[0][0]}`);
  }

  {
    const user = await logIn(phone);
    maestro(phone, "screens.yaml");
    await waitUntil("the decimal expense synced", () => transactionsNamed(user.userId, "E2E Decimal") === 1);
    const amount = query(
      "SELECT amount_minor FROM transactions WHERE user_id = :'user_id' AND name = 'E2E Decimal';",
      { user_id: user.userId },
    );
    if (amount[0][0] !== "4250") throw new Error(`expected 4250 minor units, got ${amount[0][0]}`);
  }

  {
    const user = await logIn(phone);
    await goOffline();
    try {
      maestro(phone, "offline-add.yaml");
    } finally {
      await goOnline();
    }
    await waitUntil("three rows on the server", () => transactionCount(user.userId) === 3);
  }

  {
    const user = await logIn(phone);
    await goOffline();
    try {
      maestro(phone, "rejection.yaml", { PHASE: "add" });
      psql("DELETE FROM categories WHERE user_id = :'user_id' AND name = 'Gifts';", { vars: { user_id: user.userId } });
    } finally {
      await goOnline();
    }
    maestro(phone, "rejection.yaml", { PHASE: "check" });
    await waitUntil("the later change synced", () => transactionsNamed(user.userId, "Bread") === 1);
    if (transactionsNamed(user.userId, "Gift for Ana") !== 0) throw new Error("the rejected row is on the server");
    maestro(phone, "rejection.yaml", { PHASE: "discard" });
  }

  {
    const user = await logIn(phone);
    maestro(phone, "insights.yaml");
    const status = query("SELECT status FROM insight_questions WHERE user_id = :'user_id';", { user_id: user.userId });
    if (status.length !== 1 || status[0][0] !== "answered") {
      throw new Error(`expected 1 answered question, got ${JSON.stringify(status)}`);
    }
  }

  {
    enrollFaceId(phone);
    await logIn(phone);
    maestro(phone, "app-lock.yaml", { PHASE: "enable" });
    faceIdResult(phone, false);
    maestro(phone, "app-lock.yaml", { PHASE: "failed" });
    faceIdResult(phone, true);
    maestro(phone, "app-lock.yaml", { PHASE: "unlocked" });
  }

  {
    boot(tablet);
    turnOffPasswordAutoFill(tablet);
    copyApp(phone, tablet);
    await logIn(tablet);
    maestro(tablet, "ipad-landscape.yaml");
    expectSideBySide(tablet, "chalkboard-summary", "transaction-list");
  }

  console.log("\nAll iOS flows passed.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
