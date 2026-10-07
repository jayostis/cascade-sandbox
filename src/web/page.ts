import { CLAIM } from "./claim.js";

/** How long a page waits to be controlled before it says why it is not. */
const WAIT_MS = 10_000;

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
