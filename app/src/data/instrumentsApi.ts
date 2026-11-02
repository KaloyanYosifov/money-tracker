import * as Device from "expo-device";
import { Platform } from "react-native";

import { API_URL } from "../config";

export type InstrumentKind = "stock" | "etf" | "crypto" | "fx";

/** A Yahoo search hit. Search results have no currency. */
export interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  kind: InstrumentKind;
}

export interface Instrument extends SearchResult {
  id: string;
  quote_currency: string;
}

export type InstrumentsError = "unauthorized" | "rate_limited" | "not_found" | "network" | "server";

export type InstrumentsResult<T> = { ok: true; value: T } | { ok: false; error: InstrumentsError };

export interface InstrumentsApi {
  search(query: string): Promise<InstrumentsResult<SearchResult[]>>;
  /** Adds the instrument for the user. Adding a known symbol again returns the same instrument. */
  add(symbol: string): Promise<InstrumentsResult<Instrument>>;
}

const STATUS_ERRORS: Record<number, InstrumentsError> = {
  401: "unauthorized",
  404: "not_found",
  429: "rate_limited",
};

export function createInstrumentsApi(options: {
  apiUrl?: string;
  platform?: "native" | "web";
  getAccessToken: () => Promise<string | null>;
}): InstrumentsApi {
  const apiUrl = options.apiUrl ?? API_URL;
  const native = (options.platform ?? (Platform.OS === "web" ? "web" : "native")) === "native";

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<InstrumentsResult<unknown>> {
    const token = await options.getAccessToken();
    if (!token) return { ok: false, error: "unauthorized" };
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (native) {
      headers["X-Client"] = "native";
      headers["X-Device-Name"] = Device.modelName ?? "iOS device";
    } else {
      headers["X-Requested-With"] = "money-tracker";
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(apiUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: native ? undefined : "include",
      });
    } catch {
      return { ok: false, error: "network" };
    }
    if (!res.ok) return { ok: false, error: STATUS_ERRORS[res.status] ?? "server" };
    try {
      return { ok: true, value: await res.json() };
    } catch {
      return { ok: false, error: "server" };
    }
  }

  return {
    async search(query) {
      const result = await call("GET", `/api/instruments/search?q=${encodeURIComponent(query)}`);
      if (!result.ok) return result;
      return { ok: true, value: (result.value as { results: SearchResult[] }).results };
    },
    async add(symbol) {
      const result = await call("POST", "/api/instruments", { symbol });
      if (!result.ok) return result;
      return { ok: true, value: result.value as Instrument };
    },
  };
}
