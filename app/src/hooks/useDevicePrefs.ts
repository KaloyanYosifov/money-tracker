import { usePowerSync, useQuery } from "@powersync/react";
import { useCallback, useMemo } from "react";

import type { MutationDb } from "../data/mutations";

export type DevicePrefs = Record<string, string>;

/** "top" or "bottom" (the default). */
export const TABS_POSITION_PREF = "tabsPosition";
/** "on" when the app lock is on. */
export const APP_LOCK_PREF = "appLock";
/** Seconds in the background before the app locks again: "0" (the default), "60" or "300". */
export const LOCK_AFTER_PREF = "lockAfterSeconds";

/**
 * Writes one device pref. null deletes it. The row ID is the key, so each key
 * has one row. device_prefs is local-only and never uploads.
 */
export async function setDevicePref(db: MutationDb, key: string, value: string | null): Promise<void> {
  await db.writeTransaction(async (tx) => {
    if (value === null) {
      await tx.execute("DELETE FROM device_prefs WHERE id = ?", [key]);
      return;
    }
    const existing = await tx.getOptional<{ id: string }>("SELECT id FROM device_prefs WHERE id = ?", [key]);
    if (existing) {
      await tx.execute("UPDATE device_prefs SET value = ? WHERE id = ?", [value, key]);
    } else {
      await tx.execute("INSERT INTO device_prefs (id, key, value) VALUES (?, ?, ?)", [key, key, value]);
    }
  });
}

/** All device prefs as a key to value map, and a setter. */
export function useDevicePrefs(): { prefs: DevicePrefs; setPref: (key: string, value: string | null) => Promise<void> } {
  const db = usePowerSync();
  const { data } = useQuery<{ key: string; value: string | null }>("SELECT key, value FROM device_prefs");
  const prefs = useMemo(() => {
    const map: DevicePrefs = {};
    for (const row of data) {
      if (row.value !== null) map[row.key] = row.value;
    }
    return map;
  }, [data]);
  const setPref = useCallback((key: string, value: string | null) => setDevicePref(db, key, value), [db]);
  return { prefs, setPref };
}
