import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { demoRouter, type DemoHospitalOptions } from "../index.js";

const DEMO_HOSTS = ".demo.invalid";

export interface Listener {
  /** Where it listens, `http://127.0.0.1:<port>`; hand it to `remapFetch`. */
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

/** The host of the first element of a `Forwarded` header (RFC 7239), or undefined when it names none. */
function forwardedHost(header: string): string | undefined {
  for (const pair of (header.split(",")[0] ?? "").split(";")) {
    const [name, value] = pair.trim().split("=");
    if (name?.toLowerCase() === "host" && value)
      return value.replace(/^"|"$/g, "").toLowerCase();
  }
  return undefined;
}

/**
 * The URL the client asked: with `Forwarded`, `https://<id>.demo.invalid/<rest>` from `/<id>/<rest>`; without, the
 * listener's own `<origin>/<id>/<rest>`, which only a hospital's sign-in page answers.
 */
function asked(origin: string, target: string, forwarded: string | undefined) {
  const url = new URL(target, origin);
  if (forwarded === undefined) return url;
  const [, id, ...rest] = url.pathname.split("/");
  const host = forwardedHost(forwarded);
  if (!id || host !== `${id}${DEMO_HOSTS}`) return undefined;
  return new URL(`https://${host}/${rest.join("/")}${url.search}`);
}

/**
 * Serves `hospitals` on `127.0.0.1`, at a port the system picks, to a client that reaches them through
 * `remapFetch(origin)`. Each hospital answers at the address it holds, `https://<id>.demo.invalid/...`, so every
 * link in its records names that address. The sign-in pages are the listener's own, `<origin>/<id>/authorize`.
 */
export async function serve(
  hospitals: Iterable<DemoHospitalOptions>,
  options: { readonly asOf?: string } = {},
): Promise<Listener> {
  const held = [...hospitals];
  let route: ((request: Request) => Promise<Response>) | undefined;
  let origin = "";
  const routeAt = (asOf: string | undefined) => {
    const byId = new Map(
      held.map((each) => [
        new URL(each.hospital.fhirBase).hostname.slice(0, -DEMO_HOSTS.length),
        { ...each, asOf },
      ]),
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
        "Forwarded must name the host <id>.demo.invalid of the hospital in the path.",
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
      response = await route(
        new Request(url, {
          method: incoming.method,
          headers,
          body: hasBody ? Buffer.concat(chunks) : undefined,
          redirect: "manual",
        }),
      );
    }
    outgoing.writeHead(
      response.status,
      Object.fromEntries(response.headers.entries()),
    );
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  }

  const server = createServer((incoming, outgoing) => {
    answer(incoming, outgoing).catch(() => {
      outgoing.writeHead(500).end();
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
