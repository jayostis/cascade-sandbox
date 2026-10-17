import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { demoRouter, type DemoHospitalOptions } from "../index.js";
import { DEMO_HOSTS } from "../hosts.js";
import { hospitalId } from "../route.js";

export interface DemoListener {
  /** Where it listens, `http://127.0.0.1:<port>`; hand it to `demoRemapFetch`. */
  readonly origin: string;
  /** Moves the world's date: the next request answers as of `asOf`, an instant, or with every version when undefined. */
  setWorldDate(asOf: string | undefined): void;
  close(): Promise<void>;
}

function refusal(status: number, why: string): Response {
  return new Response(why, {
    status,
    headers: { "Content-Type": "text/plain" },
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

/**
 * The URL the client asked, undefined when the target is not an origin-form path or `Forwarded` does not fit it: with `Forwarded`, `https://<id>.demo.invalid/<rest>` from `/<id>/<rest>`; without, the
 * listener's own `<origin>/<id>/<rest>`, which only a hospital's sign-in page answers.
 */
function asked(origin: string, target: string, forwarded: string | undefined) {
  if (!target.startsWith("/") || /^.[/\\]/.test(target)) return undefined;
  const url = new URL(origin + target);
  if (forwarded === undefined) return url;
  const [, id, ...rest] = url.pathname.split("/");
  const { host, proto } = forwardedHostAndProto(forwarded);
  if (proto !== undefined && proto !== "https") return undefined;
  if (!id || host?.replace(/:443$/, "") !== `${id}${DEMO_HOSTS}`)
    return undefined;
  return new URL(`https://${id}${DEMO_HOSTS}/${rest.join("/")}${url.search}`);
}

/**
 * Serves `hospitals` on `127.0.0.1`, at a port the system picks, to a client that reaches them through
 * `demoRemapFetch(origin)`. Each hospital answers at the address it holds, `https://<id>.demo.invalid/...`, so every
 * link in its records names that address. The sign-in pages are the listener's own, `<origin>/<id>/authorize`.
 */
export async function serveDemo(
  hospitals: Iterable<DemoHospitalOptions>,
  options: {
    readonly asOf?: string;
    /** Called with each request as it is handed to the hospitals. */
    readonly onRequest?: (request: Request) => void;
  } = {},
): Promise<DemoListener> {
  const held = [...hospitals];
  let route: ((request: Request) => Promise<Response>) | undefined;
  let origin = "";
  const routeAt = (asOf: string | undefined) => {
    const byId = new Map(
      held.map((each) => [hospitalId(each), { ...each, asOf }]),
    );
    return demoRouter((id) => Promise.resolve(byId.get(id)), {
      authorizeBase: `${origin}/`,
    });
  };

  async function answer(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ): Promise<void> {
    const forwarded = incoming.headers.forwarded;
    let url: URL | undefined;
    try {
      url = asked(origin, incoming.url ?? "/", forwarded);
    } catch {
      url = undefined;
    }
    let response: Response;
    if (url === undefined || route === undefined)
      response = refusal(
        400,
        "The target must be a path, and Forwarded must name https and the host <id>.demo.invalid of the hospital in the path.",
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
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
      const request = new Request(url, {
        method: incoming.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
        redirect: "manual",
      });
      options.onRequest?.(request);
      response = await route(request);
    }
    const payload = Buffer.from(await response.arrayBuffer());
    outgoing.writeHead(
      response.status,
      Object.fromEntries(response.headers.entries()),
    );
    outgoing.end(payload);
  }

  const server = createServer((incoming, outgoing) => {
    answer(incoming, outgoing).catch(() => {
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
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
