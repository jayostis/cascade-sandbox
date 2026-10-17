import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { demoRouter, type DemoHospitalOptions } from "../index.js";
import { HospitalDataError, isInstant } from "../history.js";
import { DEMO_HOSTS } from "../hosts.js";
import { hospitalId } from "../route.js";

export interface DemoListener {
  /** Where it listens, `http://127.0.0.1:<port>`; hand it to `demoRemapFetch`, or call `<origin>/<id>/fhir` directly. */
  readonly origin: string;
  /** Moves the world's date: the next request answers as of `asOf`, an instant, or with every version when undefined. */
  setWorldDate(asOf: string | undefined): void;
  close(): Promise<void>;
}

const WORLD_DATE = "/world-date";
const SIGN_IN_PAGE = /^\/[^/]+\/authorize\/?$/;

function headersOf(headers: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of headers)
    if (name !== "set-cookie") out[name] = value;
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) out["set-cookie"] = cookies;
  return out;
}

/** Writes `response` to `outgoing`, each `Set-Cookie` as a header of its own. */
export async function send(
  outgoing: ServerResponse,
  response: Response,
): Promise<void> {
  const payload = Buffer.from(await response.arrayBuffer());
  outgoing.writeHead(response.status, headersOf(response.headers));
  outgoing.end(payload);
}

function plain(status: number, words: string, headers = {}): Response {
  return new Response(words, {
    status,
    headers: { "Content-Type": "text/plain", ...headers },
  });
}

/** The host and proto of the first element of a `Forwarded` header (RFC 7239), each undefined when it names none. */
function forwardedHostAndProto(header: string): {
  host?: string;
  proto?: string;
} {
  const found: { host?: string; proto?: string } = {};
  for (const pair of (header.split(",")[0] ?? "").split(";")) {
    const [name, value] = pair.trim().split("=");
    const key = name?.toLowerCase();
    if ((key === "host" || key === "proto") && value)
      found[key] = value.replace(/^"|"$/g, "").toLowerCase();
  }
  return found;
}

/** `http://<host>`, undefined when `host` is not a host and an optional port. */
function originOf(host: string): string | undefined {
  const at = new URL(`http://${host}`);
  return at.host === host.toLowerCase() ? at.origin : undefined;
}

/**
 * The URL the client asked, undefined when the target is not an origin-form path or a header does not fit it. With
 * `Forwarded`, `https://<id>.demo.invalid/<rest>` from `/<id>/<rest>`. Without, a sign-in page is the listener's own,
 * `<origin>/<id>/authorize`; any other path is the one asked of the `Host` the client named, as `http://<host>/<path>`.
 */
function asked(
  origin: string,
  target: string,
  forwarded: string | undefined,
  host: string | undefined,
) {
  if (!target.startsWith("/") || /^.[/\\]/.test(target)) return undefined;
  const url = new URL(origin + target);
  if (forwarded === undefined) {
    if (host === undefined || SIGN_IN_PAGE.test(url.pathname)) return url;
    const named = originOf(host);
    return named === undefined ? undefined : new URL(named + target);
  }
  const [, id, ...rest] = url.pathname.split("/");
  const { host: forwardedHost, proto } = forwardedHostAndProto(forwarded);
  if (proto !== undefined && proto !== "https") return undefined;
  if (!id || forwardedHost?.replace(/:443$/, "") !== `${id}${DEMO_HOSTS}`)
    return undefined;
  return new URL(`https://${id}${DEMO_HOSTS}/${rest.join("/")}${url.search}`);
}

function checkedAsOf(asOf: string | undefined): void {
  if (asOf !== undefined && !isInstant(asOf))
    throw new HospitalDataError(
      "asOf",
      "asOf is an instant, as 2024-02-01T00:00:00Z",
    );
}

/**
 * Serves `hospitals` on `127.0.0.1`, at `port` or one the system picks. A client that reaches them through
 * `demoRemapFetch(origin)` gets each hospital at the address it holds, `https://<id>.demo.invalid/...`, so every link in
 * its records names that address; its sign-in pages are the listener's own, `<origin>/<id>/authorize`. A client that
 * calls the listener directly gets each hospital at `http://<host>/<id>/fhir`, where `<host>` is the one it asked,
 * and every link names that. `POST <origin>/world-date` with the form field `asOf` moves the world's date.
 */
export async function serveDemo(
  hospitals: Iterable<DemoHospitalOptions>,
  options: {
    readonly asOf?: string;
    /** The port to listen on; absent or 0, the system picks one. */
    readonly port?: number;
    /** Called with each request as it is handed to the hospitals. */
    readonly onRequest?: (request: Request) => void;
  } = {},
): Promise<DemoListener> {
  checkedAsOf(options.asOf);
  const held = [...hospitals];
  let route: ((request: Request) => Promise<Response>) | undefined;
  let origin = "";
  const routeAt = (asOf: string | undefined) => {
    checkedAsOf(asOf);
    const byId = new Map(
      held.map((each) => [hospitalId(each), { ...each, asOf }]),
    );
    return demoRouter((id) => Promise.resolve(byId.get(id)), {
      authorizeBase: `${origin}/`,
      direct: true,
    });
  };

  async function body(incoming: IncomingMessage): Promise<Buffer<ArrayBuffer>> {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  async function worldDate(incoming: IncomingMessage): Promise<Response> {
    if (incoming.method !== "POST")
      return plain(405, "The world's date is moved by a POST.", {
        Allow: "POST",
      });
    const asOf = new URLSearchParams((await body(incoming)).toString()).get(
      "asOf",
    );
    if (asOf === null || (asOf !== "" && !isInstant(asOf)))
      return plain(
        400,
        "The form field asOf is an instant, as 2024-02-01T00:00:00Z, or empty for every version.",
      );
    route = routeAt(asOf === "" ? undefined : asOf);
    return plain(
      200,
      asOf === ""
        ? "The hospitals now answer with every record's latest version."
        : `The hospitals now answer as their records stood at ${asOf}.`,
    );
  }

  async function answer(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ): Promise<void> {
    const forwarded = incoming.headers.forwarded;
    const target = incoming.url ?? "/";
    if (forwarded === undefined && target.split("?")[0] === WORLD_DATE) {
      await send(outgoing, await worldDate(incoming));
      return;
    }
    let url: URL | undefined;
    try {
      url = asked(origin, target, forwarded, incoming.headers.host);
    } catch {
      url = undefined;
    }
    let response: Response;
    if (url === undefined || route === undefined)
      response = plain(
        400,
        "The target must be a path; with Forwarded, it must name https and the host <id>.demo.invalid of the hospital in the path, and without, Host must name a host.",
      );
    else {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (
          name !== "forwarded" &&
          name !== "host" &&
          typeof value === "string"
        )
          headers.set(name, value);
      const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
      const request = new Request(url, {
        method: incoming.method,
        headers,
        body: hasBody ? await body(incoming) : undefined,
        redirect: "manual",
      });
      options.onRequest?.(request);
      response = await route(request);
    }
    await send(outgoing, response);
  }

  const server = createServer((incoming, outgoing) => {
    answer(incoming, outgoing).catch(() => {
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  route = routeAt(options.asOf);
  return {
    origin,
    setWorldDate(asOf) {
      route = routeAt(asOf);
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
