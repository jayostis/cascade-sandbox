import type { Bundle, DemoHospitalOptions, Hospital } from "../index.js";
import { demoRouter, isDemoRequest } from "../route.js";
import { CLAIM, WORLD_CACHE, WORLD_DATE, WORLD_KEY } from "./claim.js";

interface Extendable extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface Fetching extends Extendable {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}

interface Messaged extends Extendable {
  readonly data: unknown;
  readonly ports: readonly MessagePort[];
}

/** What this worker uses of `ServiceWorkerGlobalScope`. */
interface WorkerScope {
  readonly location: { readonly href: string };
  readonly registration: { readonly scope: string };
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(
    type: "install" | "activate",
    listener: (event: Extendable) => void,
  ): void;
  addEventListener(type: "fetch", listener: (event: Fetching) => void): void;
  addEventListener(type: "message", listener: (event: Messaged) => void): void;
}

const scope = globalThis as unknown as WorkerScope;
const options = {
  authorizeBase: new URL("demo-hospitals/", scope.registration.scope).href,
};

/** The world's date a page set, an instant, or undefined when none is set. */
async function worldDate(): Promise<string | undefined> {
  const kept = await (
    await caches.open(WORLD_CACHE)
  ).match(new URL(WORLD_KEY, scope.registration.scope));
  return kept === undefined ? undefined : await kept.text();
}

/**
 * One hospital's data, from `demo-hospitals/<id>.json` beside this script, its world's date the one a page set, else the
 * file's own `asOf`, else none: every version.
 */
async function load(id: string): Promise<DemoHospitalOptions | undefined> {
  if (!/^[a-z0-9-]+$/.test(id)) return undefined;
  const response = await fetch(
    new URL(`demo-hospitals/${id}.json`, scope.location.href),
  );
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`demo-hospitals/${id}.json answered ${response.status}`);
  const loaded = (await response.json()) as {
    hospital: Hospital;
    patients: Record<string, Bundle>;
    asOf?: string;
  };
  const asOf = (await worldDate()) ?? loaded.asOf;
  return asOf === undefined ? loaded : { ...loaded, asOf };
}

let route = demoRouter(load, options);

scope.addEventListener("install", (event) =>
  event.waitUntil(scope.skipWaiting()),
);
scope.addEventListener("activate", (event) =>
  event.waitUntil(scope.clients.claim()),
);
scope.addEventListener("message", (event) => {
  if (event.data === CLAIM) event.waitUntil(scope.clients.claim());
  if (event.data === WORLD_DATE) {
    route = demoRouter(load, options);
    event.ports[0]?.postMessage("changed");
  }
});
scope.addEventListener("fetch", (event) => {
  if (isDemoRequest(event.request.url, options))
    event.respondWith(route(event.request));
});
