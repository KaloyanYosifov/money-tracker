import { useSyncExternalStore } from "react";

// The API returned 426 for an upload. The flag stays set until the app restarts
// with a newer build.
let updateRequired = false;
const listeners = new Set<() => void>();

export function setUpdateRequired(): void {
  if (updateRequired) {
    return;
  }
  updateRequired = true;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => updateRequired;

export function useUpdateRequired(): boolean {
  return useSyncExternalStore(subscribe, read, read);
}
