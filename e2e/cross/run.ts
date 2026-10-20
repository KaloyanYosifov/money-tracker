/**
 * Runs the cross-app scenarios: one user on the iOS simulator and in Playwright Chromium.
 * It needs macOS with Xcode, an iPhone simulator, the Maestro CLI and the Compose stack.
 *
 * The iOS build talks to the stack through the Toxiproxy pair api_ios (18090) and
 * powersync_ios (18091), so the scenarios can take iOS offline and keep the web online.
 * Env: IOS_PHONE_SIMULATOR selects the simulator by name. Without it the first available iPhone is used.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { resetData, waitForStack } from "../support/stack.ts";
import { resetProxies } from "../support/toxiproxy.ts";
import { logIn, newAppContext, newUser, nextCode, waitForSynced } from "../web/fixtures.ts";
import { scenarios, type CrossContext } from "./scenarios.ts";

const APP_DIR = fileURLToPath(new URL("../../app/", import.meta.url));
const FLOWS_DIR = fileURLToPath(new URL("../../app/e2e/maestro/", import.meta.url));
const IOS_API_URL = process.env.E2E_IOS_API_URL ?? "http://localhost:18090";
const IOS_POWERSYNC_URL = process.env.E2E_IOS_POWERSYNC_URL ?? "http://localhost:18091";

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

interface Simulator {
  udid: string;
  name: string;
  state: string;
}

function findPhone(name: string | undefined): Simulator {
  const list = JSON.parse(
    execFileSync("xcrun", ["simctl", "list", "devices", "available", "--json"], { encoding: "utf8" }),
  ) as { devices: Record<string, Simulator[]> };
  // The newest iOS runtime sorts last.
  const runtimes = Object.keys(list.devices)
    .filter((runtime) => runtime.includes("iOS"))
    .sort()
    .reverse();
  for (const runtime of runtimes) {
    const found = list.devices[runtime].find((sim) => (name ? sim.name === name : sim.name.startsWith("iPhone")));
    if (found) return found;
  }
  throw new Error(`no available iPhone simulator${name ? ` named "${name}"` : ""}`);
}

function boot(sim: Simulator): void {
  if (sim.state !== "Booted") run("xcrun", ["simctl", "boot", sim.udid]);
  run("xcrun", ["simctl", "bootstatus", sim.udid, "-b"]);
}

/** Builds the Release app against the iOS proxies and installs it on the simulator. */
function buildApp(sim: Simulator): void {
  run("npx", ["expo", "run:ios", "--configuration", "Release", "--no-bundler", "--device", sim.udid], {
    cwd: APP_DIR,
    env: { ...process.env, EXPO_PUBLIC_API_URL: IOS_API_URL, EXPO_PUBLIC_POWERSYNC_URL: IOS_POWERSYNC_URL },
  });
}

function maestro(sim: Simulator, flow: string, env: Record<string, string>): void {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  console.log(`\n▶ ${flow} on ${sim.name}`);
  run("maestro", ["--device", sim.udid, "test", `${FLOWS_DIR}${flow}`, ...envArgs]);
}

async function main(): Promise<void> {
  await waitForStack();
  await resetProxies();
  resetData();

  const phone = findPhone(process.env.IOS_PHONE_SIMULATOR);
  boot(phone);
  buildApp(phone);

  const user = await newUser();
  // nextCode never gives the same TOTP step twice, so the two logins do not trip the replay check.
  maestro(phone, "login.yaml", { EMAIL: user.email, PASSWORD: user.password, TOTP_CODE: await nextCode(user.totpSecret) });

  const browser = await chromium.launch();
  try {
    const { page } = await newAppContext(browser);
    await logIn(page, user);
    await waitForSynced(page);

    const context: CrossContext = { user, page, maestro: (flow, env) => maestro(phone, flow, env) };
    for (const scenario of scenarios) {
      console.log(`\n■ ${scenario.name}`);
      await scenario(context);
    }
  } finally {
    await browser.close();
    await resetProxies();
  }

  console.log("\nAll cross-app scenarios passed.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
