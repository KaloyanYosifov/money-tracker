import { Secret, TOTP } from "otpauth";

const PERIOD_SECONDS = 30;
const MIN_REMAINING_MS = 5_000;

function totp(secret: string): TOTP {
  return new TOTP({
    secret: Secret.fromBase32(secret),
    algorithm: "SHA1",
    digits: 6,
    period: PERIOD_SECONDS,
  });
}

/** The time in milliseconds until the current 30-second step ends. */
export function msLeftInStep(now = Date.now()): number {
  const periodMs = PERIOD_SECONDS * 1000;
  return periodMs - (now % periodMs);
}

/** The TOTP code for the given time, with no wait. */
export function codeAt(secret: string, timestamp: number): string {
  return totp(secret).generate({ timestamp });
}

/**
 * Returns a TOTP code that stays valid for at least 5 seconds.
 * If the current step has less than 5 seconds left, it waits for the next step.
 */
export async function freshCode(secret: string): Promise<string> {
  const left = msLeftInStep();
  if (left < MIN_REMAINING_MS) {
    await new Promise((resolve) => setTimeout(resolve, left + 50));
  }
  return codeAt(secret, Date.now());
}

/** The 30-second TOTP step at a time. */
export function stepAt(timestamp = Date.now()): number {
  return Math.floor(timestamp / (PERIOD_SECONDS * 1000));
}

/**
 * The env of the Maestro login.yaml for a user whose steps up to lastUsed the API already saw.
 * The flow types the code of the step after the current one (app/e2e/maestro/scripts/totp.js),
 * so this waits while that step is already used. After the flow, mark stepAt() + 1 as used.
 */
export async function maestroLoginEnv(secret: string, lastUsed: number): Promise<Record<string, string>> {
  while (stepAt() + 1 <= lastUsed) {
    await new Promise((resolve) => setTimeout(resolve, msLeftInStep() + 50));
  }
  return { TOTP_SECRET: secret, MIN_STEP: String(lastUsed + 1) };
}
