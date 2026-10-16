import { CLAIM, WORLD_CACHE, WORLD_DATE, WORLD_KEY } from "./claim.js";

/** How long a page waits to be controlled before it says why it is not. */
const WAIT_MS = 10_000;

/** The worker's scope: its folder. */
function scopeOf(scriptUrl: string | URL): URL {
  return new URL("./", new URL(scriptUrl, location.href));
}

/** The world's date the page last set for the worker at `scriptUrl`, an instant, or undefined when none is set. */
export async function worldDate(
  scriptUrl: string | URL,
): Promise<string | undefined> {
  const cache = await caches.open(WORLD_CACHE);
  const kept = await cache.match(new URL(WORLD_KEY, scopeOf(scriptUrl)));
  return kept === undefined ? undefined : await kept.text();
}

/**
 * Sets the world's date, an instant, for the worker at `scriptUrl`, or with undefined removes it so every hospital
 * answers with every version it holds. The date is kept in Cache Storage, where the worker finds it again after it
 * was stopped; resolves once the worker has dropped the hospitals it answered with, so the next request is as of the
 * new date. Rejects, saying why, when the worker is not running.
 */
export async function setWorldDate(
  scriptUrl: string | URL,
  asOf: string | undefined,
): Promise<void> {
  const scope = scopeOf(scriptUrl);
  const cache = await caches.open(WORLD_CACHE);
  const key = new URL(WORLD_KEY, scope);
  if (asOf === undefined) await cache.delete(key);
  else await cache.put(key, new Response(asOf));
  const worker = (await navigator.serviceWorker.getRegistration(scope.href))
    ?.active;
  if (worker === undefined || worker === null)
    throw new Error("The demo hospitals' worker is not running on this page.");
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(
      () => reject(new Error("The demo hospitals' worker did not answer.")),
      WAIT_MS,
    );
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve();
    };
    worker.postMessage(WORLD_DATE, [channel.port2]);
  });
}

/**
 * Registers the demo hospitals' worker at `scriptUrl`, with its folder as its scope, and resolves once it controls
 * the page, so the page's `fetch` reaches the demo hospitals. Rejects, saying why, when it cannot.
 */
export async function useDemoHospitals(scriptUrl: string | URL): Promise<void> {
  const container = navigator.serviceWorker as
    ServiceWorkerContainer | undefined;
  if (container === undefined)
    throw new Error(
      "This browser runs no service worker for this page: it must be served over https:, or from localhost.",
    );
  const script = new URL(scriptUrl, location.href);
  const registration = await container.register(script, {
    scope: new URL("./", script).href,
  });
  if (container.controller !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "The demo hospitals' worker does not control this page, as after a hard reload: reload it normally.",
          ),
        ),
      WAIT_MS,
    );
    container.addEventListener(
      "controllerchange",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    registration.active?.postMessage(CLAIM);
  });
}
