import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";

import type { AuthStatus } from "../../auth/AuthProvider";
import { closeOverlays } from "../overlays";

/** The time that iOS needs to close a form sheet or an overlay before it can present the next modal. */
export const CLOSE_DELAY_MS = 600;

export interface DismissRouter {
  canDismiss(): boolean;
  dismissAll(): void;
}

/** True when the session of a signed-in user ends now (refresh token rejected or session revoked). */
export function sessionEnded(previous: AuthStatus, next: AuthStatus): boolean {
  return previous === "signedIn" && (next === "reauthRequired" || next === "signedOut");
}

/**
 * Closes the overlays and, before "Log in again", the forms and pages above the tabs.
 * iOS presents one modal at a time, so the login sheet cannot show above an open form or calendar.
 * A sign-out needs no dismiss, because Stack.Protected removes the screens itself.
 * Returns true if something closed, so the caller waits for the animation before it presents the login.
 */
export function closeForSessionEnd(next: AuthStatus, router: DismissRouter): boolean {
  const closedOverlays = closeOverlays() > 0;
  if (next !== "reauthRequired" || !router.canDismiss()) return closedOverlays;
  router.dismissAll();
  return true;
}

/**
 * Cleans up the screens when the session ends. Returns false while the closed screens animate out:
 * the "Log in again" modal waits for true.
 */
export function useSessionEndCleanup(status: AuthStatus): boolean {
  const router = useRouter();
  const previous = useRef(status);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const before = previous.current;
    previous.current = status;
    if (!sessionEnded(before, status) || !closeForSessionEnd(status, router)) return;
    setClosing(true);
    const timer = setTimeout(() => setClosing(false), CLOSE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setClosing(false);
    };
  }, [status, router]);

  return !closing;
}
