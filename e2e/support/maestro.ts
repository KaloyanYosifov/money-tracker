import { spawnSync } from "node:child_process";

// Errors of Maestro's own iOS driver. They come before the first step of a flow, so a second try is safe.
const DRIVER_ERRORS = [/JsonParseException/, /failed to terminate dev\.mobile\.maestro-driver/];

/**
 * Runs `maestro --device <udid> test <flow>` and prints its output. If the Maestro driver
 * crashes before the flow starts, it tries once more. Any other failure throws at once.
 */
export function runMaestroFlow(udid: string, flow: string, env: Record<string, string> = {}): void {
  const args = ["--device", udid, "test", flow, ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`])];
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync("maestro", args, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.status === 0) return;
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (attempt === 1 && DRIVER_ERRORS.some((pattern) => pattern.test(output))) {
      console.log("Maestro driver error before the flow started. Trying once more.");
      continue;
    }
    throw new Error(`maestro ${args.join(" ")} failed with exit code ${result.status}`);
  }
}
