export type QuickAddType = "expense" | "income" | "transfer";

/** Each screen passes only the handlers it supports. */
export interface Shortcuts {
  /** Keys 1 to 5. */
  page?: (page: number) => void;
  /** Keys E, I and T. */
  newTransaction?: (type: QuickAddType) => void;
  /** Key /. */
  focusSearch?: () => void;
  /** Enter, also while an input has focus. In a multi-line field only Cmd/Ctrl+Enter. */
  save?: () => void;
  /** Escape, also while an input has focus. */
  cancel?: () => void;
}

/** Native has no keyboard shortcuts. The web version is useShortcuts.web.ts. */
export function useShortcuts(_handlers: Shortcuts): void {}
