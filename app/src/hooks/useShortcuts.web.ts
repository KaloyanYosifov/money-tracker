import { useEffect, useRef } from "react";

import type { QuickAddType, Shortcuts } from "./useShortcuts";

export type { QuickAddType, Shortcuts };

const QUICK_ADD: Record<string, QuickAddType> = { e: "expense", i: "income", t: "transfer" };

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function isControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement) || isTextInput(target)) return false;
  const role = target.getAttribute("role") ?? "";
  return target.tagName === "BUTTON" || ["button", "tab", "radio", "switch", "checkbox", "menuitem"].includes(role);
}

/** Runs the matching handler and returns true if the key was used. */
export function handleShortcut(event: KeyboardEvent, handlers: Shortcuts): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;

  // Enter on a focused button (Delete, Cancel) belongs to that button, not to save.
  if (event.key === "Enter" && !event.shiftKey && handlers.save && !isControl(event.target)) {
    handlers.save();
    return true;
  }
  if (event.key === "Escape" && handlers.cancel) {
    handlers.cancel();
    return true;
  }
  if (isTextInput(event.target)) return false;

  if (/^[1-5]$/.test(event.key) && handlers.page) {
    handlers.page(Number(event.key));
    return true;
  }
  const type = QUICK_ADD[event.key.toLowerCase()];
  if (type && handlers.newTransaction) {
    handlers.newTransaction(type);
    return true;
  }
  if (event.key === "/" && handlers.focusSearch) {
    handlers.focusSearch();
    return true;
  }
  return false;
}

/** Binds the keyboard shortcuts on the window while the component is mounted. */
export function useShortcuts(handlers: Shortcuts): void {
  const current = useRef(handlers);
  useEffect(() => {
    current.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (handleShortcut(event, current.current)) event.preventDefault();
    };
    // Capture phase: react-native-web's TextInput stops the propagation of every keydown,
    // so a bubble listener never sees Enter (save) or Escape (cancel) in a form field.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
