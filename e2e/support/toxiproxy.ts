import { fetchWithRetry } from "./http.ts";

const TOXIPROXY_URL = process.env.E2E_TOXIPROXY_URL ?? "http://localhost:28474";

/** Proxy names from deploy/compose/toxiproxy.json. */
export type ProxyName = "api" | "powersync" | "api_ios" | "powersync_ios";

async function call(path: string, body?: unknown): Promise<void> {
  const res = await fetchWithRetry(`${TOXIPROXY_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`toxiproxy ${path}: ${res.status} ${await res.text()}`);
  }
}

/** Turns a proxy off (connections fail) or on. */
export async function setProxyEnabled(name: ProxyName, enabled: boolean): Promise<void> {
  await call(`/proxies/${name}`, { enabled });
}

/** Turns off the given proxies. The default is both, so the app is offline. */
export async function goOffline(names: ProxyName[] = ["api", "powersync"]): Promise<void> {
  for (const name of names) await setProxyEnabled(name, false);
}

/** Turns on the given proxies. The default is both. */
export async function goOnline(names: ProxyName[] = ["api", "powersync"]): Promise<void> {
  for (const name of names) await setProxyEnabled(name, true);
}

/** Adds latency to the responses of a proxy. */
export async function addLatency(name: ProxyName, latencyMs: number, jitterMs = 0): Promise<void> {
  await call(`/proxies/${name}/toxics`, {
    name: `latency_${name}`,
    type: "latency",
    stream: "downstream",
    toxicity: 1,
    attributes: { latency: latencyMs, jitter: jitterMs },
  });
}

/** Turns on all proxies and removes all toxics. */
export async function resetProxies(): Promise<void> {
  await call("/reset");
}
