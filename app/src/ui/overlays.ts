import { useEffect, useRef } from "react";

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Closes each open overlay (an RN Modal such as the calendar, the period picker or a menu).
 * iOS shows one presented view controller at a time, so an open overlay blocks a new modal
 * such as the "Log in again" sheet. Returns the number of overlays that it closed.
 */
export function closeOverlays(): number {
  const open = [...listeners];
  for (const listener of open) listener();
  return open.length;
}

/** Calls onClose when closeOverlays runs while the overlay is visible. */
export function useCloseWithOverlays(visible: boolean, onClose: () => void): void {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!visible) return;
    const listener = () => close.current();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [visible]);
}
