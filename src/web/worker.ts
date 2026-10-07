import type { Bundle, DemoHospitalOptions, Hospital } from "../index.js";
import { demoRouter, isDemoRequest } from "../route.js";
import { CLAIM } from "./claim.js";

interface Extendable extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface Fetching extends Extendable {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}

interface Messaged extends Extendable {
  readonly data: unknown;
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

/** One hospital's data, from `demo-hospitals/<id>.json` beside this script. */
async function load(id: string): Promise<DemoHospitalOptions | undefined> {
  if (!/^[a-z0-9-]+$/.test(id)) return undefined;
  const response = await fetch(
    new URL(`demo-hospitals/${id}.json`, scope.location.href),
  );
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`demo-hospitals/${id}.json answered ${response.status}`);
  return (await response.json()) as {
    hospital: Hospital;
    patients: Record<string, Bundle>;
  };
}

const route = demoRouter(load, options);

scope.addEventListener("install", (event) =>
  event.waitUntil(scope.skipWaiting()),
);
scope.addEventListener("activate", (event) =>
  event.waitUntil(scope.clients.claim()),
);
scope.addEventListener("message", (event) => {
  if (event.data === CLAIM) event.waitUntil(scope.clients.claim());
});
scope.addEventListener("fetch", (event) => {
  if (isDemoRequest(event.request.url, options))
    event.respondWith(route(event.request));
});
