/**
 * fetch, with one more try when the server closed a kept-alive connection. Node keeps idle
 * connections open, and Docker's port forward closes them during a long iOS build or flow.
 * The next request on such a connection fails with "other side closed" before the server sees it.
 */
export async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code !== "UND_ERR_SOCKET" && code !== "ECONNRESET") throw error;
    return fetch(url, init);
  }
}
