import { DEMO_HOSTS } from "./hosts.js";

const MOST_REDIRECTS = 20;

/**
 * A `fetch` that sends a request for `https://<id>.demo.invalid/<rest>` to a listener at `origin`
 * (`http://127.0.0.1:<port>`), as `<origin>/<id>/<rest>` with the `Forwarded` header that names the address the
 * client asked; every other request goes to `fallback`. A caller that asks to follow redirects (fetch's default)
 * has them followed here, through the remap, up to twenty as `fetch` does; `"manual"` passes a redirect through.
 */
export function demoRemapFetch(
  origin: string,
  fallback: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return async (input, init) => {
    const asked = new Request(input, init);
    const signal = asked.signal;
    let url = new URL(asked.url);
    let method = asked.method;
    let headers = new Headers(asked.headers);
    let body: ArrayBuffer | undefined =
      method === "GET" || method === "HEAD"
        ? undefined
        : await asked.arrayBuffer();
    for (let followed = 0; ; followed += 1) {
      const demo = url.hostname.endsWith(DEMO_HOSTS);
      const sent = new Headers(headers);
      let target = url.href;
      if (demo) {
        sent.set(
          "Forwarded",
          `host=${url.hostname};proto=${url.protocol.slice(0, -1)}`,
        );
        const id = url.hostname.slice(0, -DEMO_HOSTS.length);
        target = `${origin}/${id}${url.pathname}${url.search}`;
      }
      const response = await fallback(target, {
        method,
        headers: sent,
        body,
        redirect: asked.redirect === "follow" ? "manual" : asked.redirect,
        signal,
      });
      const location = response.headers.get("Location");
      if (
        asked.redirect !== "follow" ||
        response.status < 300 ||
        response.status >= 400 ||
        !location
      )
        return response;
      if (followed === MOST_REDIRECTS)
        throw new TypeError("fetch failed: too many redirects");
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        headers = new Headers(headers);
        headers.delete("authorization");
      }
      url = next;
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method === "POST")
      ) {
        method = "GET";
        body = undefined;
        headers = new Headers(headers);
        for (const name of ["content-type", "content-length"])
          headers.delete(name);
      }
    }
  };
}
