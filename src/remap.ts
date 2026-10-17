const DEMO_HOSTS = ".demo.invalid";

/**
 * A `fetch` that sends a request for `https://<id>.demo.invalid/<rest>` to a listener at `origin`
 * (`http://127.0.0.1:<port>`), as `<origin>/<id>/<rest>` with the `Forwarded` header that names the address the
 * client asked; every other request goes to `fallback`.
 */
export function remapFetch(
  origin: string,
  fallback: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return async (input, init) => {
    const asked = new Request(input, init);
    const url = new URL(asked.url);
    if (!url.hostname.endsWith(DEMO_HOSTS)) return fallback(input, init);
    const id = url.hostname.slice(0, -DEMO_HOSTS.length);
    const headers = new Headers(asked.headers);
    headers.set(
      "Forwarded",
      `host=${url.hostname};proto=${url.protocol.slice(0, -1)}`,
    );
    const body =
      asked.method === "GET" || asked.method === "HEAD"
        ? undefined
        : await asked.arrayBuffer();
    return fallback(`${origin}/${id}${url.pathname}${url.search}`, {
      method: asked.method,
      headers,
      body,
      redirect: asked.redirect,
      signal: asked.signal,
    });
  };
}
