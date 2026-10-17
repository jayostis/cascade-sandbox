import {
  demoHospital,
  type DemoHospital,
  type DemoHospitalOptions,
} from "./index.js";
import { DEMO_HOSTS } from "./hosts.js";

/** What a page's `fetch` may read of an answer from another origin, as a real server would expose them. */
const EXPOSED = "Retry-After, WWW-Authenticate, Location";

export interface RouteOptions {
  /**
   * Where the authorize pages are, ending in a slash: hospital `<id>`'s is `<authorizeBase><id>/authorize`. With
   * none, each is the hospital's own, `<fhirBase>/authorize`.
   */
  readonly authorizeBase?: string;
}

/** One hospital by its id, or undefined when there is none of that id. */
export type LoadHospital = (
  id: string,
) => Promise<DemoHospitalOptions | undefined>;

function parsed(url: URL | string): URL {
  return typeof url === "string" ? new URL(url) : url;
}

/** The URL without its query or fragment. */
function address(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/** Whether a request is the demo hospitals', from its URL alone: a `*.demo.invalid` host, or a path under `authorizeBase`. */
export function isDemoRequest(
  url: URL | string,
  options: RouteOptions = {},
): boolean {
  const at = parsed(url);
  return (
    at.hostname.endsWith(DEMO_HOSTS) ||
    (options.authorizeBase !== undefined &&
      address(at).startsWith(options.authorizeBase))
  );
}

export interface RouterOptions extends RouteOptions {
  /**
   * Also answer a request on any other origin whose path starts `/<id>/`, as hospital `<id>` at the base
   * `<origin>/<id><path>`, where `<path>` is its FHIR base's path: a listener's direct callers.
   */
  readonly direct?: boolean;
}

/**
 * The hospital a demo request is for: the host's first label, the folder under `authorizeBase`, or, for a direct
 * request, the path's first segment.
 */
function hospitalOf(
  url: URL,
  options: RouterOptions,
): { id: string; direct: boolean } | undefined {
  if (url.hostname.endsWith(DEMO_HOSTS)) {
    const id = url.hostname.slice(0, -DEMO_HOSTS.length);
    return id ? { id, direct: false } : undefined;
  }
  const { authorizeBase } = options;
  if (authorizeBase !== undefined && address(url).startsWith(authorizeBase)) {
    const [id, page, ...rest] = address(url)
      .slice(authorizeBase.length)
      .split("/");
    if (id && page === "authorize" && rest.length === 0)
      return { id, direct: false };
  }
  if (!options.direct) return undefined;
  const id = url.pathname.split("/")[1];
  return id ? { id, direct: true } : undefined;
}

function notFound(what: string): Response {
  return new Response(
    JSON.stringify({
      resourceType: "OperationOutcome",
      issue: [{ severity: "error", code: "not-found", diagnostics: what }],
    }),
    {
      status: 404,
      headers: {
        "Content-Type": "application/fhir+json",
        "Access-Control-Expose-Headers": EXPOSED,
      },
    },
  );
}

function exposed(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Expose-Headers", EXPOSED);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Answers a request `isDemoRequest` claims, with the hospital it names, each loaded once on its first request. A
 * hospital that `load` does not know is a 404.
 */
export function demoRouter(
  load: LoadHospital,
  options: RouterOptions = {},
): (request: Request) => Promise<Response> {
  interface Held {
    readonly answer: DemoHospital;
    /** The path of the hospital's FHIR base, as `/fhir`. */
    readonly path: string;
  }
  const hospitals = new Map<string, Promise<Held | undefined>>();
  const hospital = (id: string): Promise<Held | undefined> => {
    let found = hospitals.get(id);
    if (found === undefined) {
      found = load(id).then(
        (loaded) =>
          loaded && {
            answer: demoHospital({
              ...loaded,
              ...(options.authorizeBase === undefined
                ? {}
                : { authorizeUrl: `${options.authorizeBase}${id}/authorize` }),
            }),
            path: new URL(loaded.hospital.fhirBase).pathname.replace(/\/$/, ""),
          },
      );
      hospitals.set(id, found);
      found.catch(() => hospitals.delete(id));
    }
    return found;
  };
  return async (request) => {
    const url = new URL(request.url);
    const of = hospitalOf(url, options);
    const held = of === undefined ? undefined : await hospital(of.id);
    if (of === undefined || held === undefined)
      return notFound(`There is no demo hospital at ${address(url)}.`);
    return exposed(
      await held.answer(
        request,
        of.direct ? `${url.origin}/${of.id}${held.path}` : undefined,
      ),
    );
  };
}

/** The id of a hospital, from its FHIR base's host. */
export function hospitalId(options: DemoHospitalOptions): string {
  const host = new URL(options.hospital.fhirBase).hostname;
  if (!host.endsWith(DEMO_HOSTS))
    throw new Error(
      `${options.hospital.name}'s FHIR base is not on a ${DEMO_HOSTS.slice(1)} host`,
    );
  return host.slice(0, -DEMO_HOSTS.length);
}

/** A `fetch` that sends the demo hospitals' requests to them, and every other to `fallback`. */
export function demoFetch(
  hospitals: Iterable<DemoHospitalOptions>,
  options: RouteOptions & { readonly fallback?: typeof fetch } = {},
): typeof fetch {
  const byId = new Map([...hospitals].map((each) => [hospitalId(each), each]));
  const route = demoRouter((id) => Promise.resolve(byId.get(id)), options);
  const fallback = options.fallback ?? globalThis.fetch.bind(globalThis);
  return (input, init) =>
    isDemoRequest(input instanceof Request ? input.url : input, options)
      ? route(new Request(input, init))
      : fallback(input, init);
}
