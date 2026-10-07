import {
  demoHospital,
  type DemoHospital,
  type DemoHospitalOptions,
} from "./index.js";

/** Every demo hospital's FHIR base is on a host under this, `<id>.demo.invalid`. */
const DEMO_HOSTS = ".demo.invalid";
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

/** The hospital a demo request is for: the host's first label, or the folder under `authorizeBase`. */
function hospitalOf(url: URL, options: RouteOptions): string | undefined {
  if (url.hostname.endsWith(DEMO_HOSTS))
    return url.hostname.slice(0, -DEMO_HOSTS.length) || undefined;
  const { authorizeBase } = options;
  if (authorizeBase === undefined) return undefined;
  const [id, page, ...rest] = address(url)
    .slice(authorizeBase.length)
    .split("/");
  return id && page === "authorize" && rest.length === 0 ? id : undefined;
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
  options: RouteOptions = {},
): (request: Request) => Promise<Response> {
  const hospitals = new Map<string, Promise<DemoHospital | undefined>>();
  const hospital = (id: string): Promise<DemoHospital | undefined> => {
    let found = hospitals.get(id);
    if (found === undefined) {
      found = load(id).then(
        (loaded) =>
          loaded &&
          demoHospital({
            ...loaded,
            ...(options.authorizeBase === undefined
              ? {}
              : { authorizeUrl: `${options.authorizeBase}${id}/authorize` }),
          }),
      );
      hospitals.set(id, found);
      found.catch(() => hospitals.delete(id));
    }
    return found;
  };
  return async (request) => {
    const id = hospitalOf(new URL(request.url), options);
    const answer = id === undefined ? undefined : await hospital(id);
    if (answer === undefined)
      return notFound(
        `There is no demo hospital at ${address(new URL(request.url))}.`,
      );
    return exposed(await answer(request));
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
  hospitals: readonly DemoHospitalOptions[],
  options: RouteOptions & { readonly fallback?: typeof fetch } = {},
): typeof fetch {
  const byId = new Map(hospitals.map((each) => [hospitalId(each), each]));
  const route = demoRouter((id) => Promise.resolve(byId.get(id)), options);
  const fallback = options.fallback ?? globalThis.fetch.bind(globalThis);
  return (input, init) =>
    isDemoRequest(input instanceof Request ? input.url : input, options)
      ? route(new Request(input, init))
      : fallback(input, init);
}
