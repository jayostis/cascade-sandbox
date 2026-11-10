import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { demoFetch, isDemoRequest } from "../src/index.js";
import { type LoadedHospital, loadHospitals } from "../src/node/index.js";

const APP = "http://127.0.0.1:8080/connect/";
const AUTHORIZE = `${APP}demo-hospitals/`;
const NORTH_SIGN_IN = "https://cascade-north.demo.invalid/fhir/authorize";
const ELSEWHERE = [`${APP}index.html`, "https://example.org/fhir/metadata"];

let hospitals: LoadedHospital[];

before(async () => {
  hospitals = await loadHospitals();
});

/** A fallback that answers "elsewhere" and keeps the address of each request it is given. */
function fallingBack() {
  const fallen: string[] = [];
  const fallback = (async (input: RequestInfo | URL) => {
    fallen.push(String(input instanceof Request ? input.url : input));
    return new Response("elsewhere");
  }) as typeof fetch;
  return { fallen, fallback };
}

/** What a hospital's sign-in page is asked with by an app that holds a discovery's `authorization_endpoint`. */
function signInRequest(authorize: string, aud: string) {
  return `${authorize}?${new URLSearchParams({
    response_type: "code",
    client_id: "test-app",
    redirect_uri: `${APP}signed-in.html`,
    scope: "launch/patient",
    state: "s",
    aud,
    code_challenge: "c",
    code_challenge_method: "S256",
  })}`;
}

async function discovered(fetch: typeof globalThis.fetch, fhirBase: string) {
  return (await (
    await fetch(`${fhirBase}/.well-known/smart-configuration`)
  ).json()) as { issuer: string; authorization_endpoint: string };
}

/**
 * `demoFetch()` is a `fetch` that answers a request for a demo hospital's address in the same process and passes every
 * other request on. An app's test swaps it in for `fetch` and connects with no network.
 */
describe("Sending an app's requests to the demo hospitals · demoFetch(), isDemoRequest()", () => {
  describe("isDemoRequest(url, options)", () => {
    it("returns true for a URL on a `.demo.invalid` host", () => {
      const urls = [
        ...hospitals.map(
          ({ hospital }) =>
            `${hospital.fhirBase}/.well-known/smart-configuration`,
        ),
        `${NORTH_SIGN_IN}?client_id=x`,
        "https://nowhere.demo.invalid/fhir/metadata",
      ];
      assert.ok(urls.length >= 4);
      for (const url of urls) assert.equal(isDemoRequest(url, {}), true, url);
    });

    it("returns true for a URL under `authorizeBase`", () => {
      for (const url of [
        `${AUTHORIZE}cascade-north/authorize?client_id=x`,
        `${AUTHORIZE}nowhere/authorize`,
        `${AUTHORIZE}cascade-north/elsewhere`,
      ])
        assert.equal(
          isDemoRequest(url, { authorizeBase: AUTHORIZE }),
          true,
          url,
        );
    });

    it("returns false for any other URL", () => {
      for (const url of ELSEWHERE)
        assert.equal(
          isDemoRequest(url, { authorizeBase: AUTHORIZE }),
          false,
          url,
        );
    });
  });

  describe("demoFetch(hospitals, options)", () => {
    it("answers a hospital's discovery with that hospital as the issuer", async () => {
      const own = demoFetch(hospitals);
      assert.ok(hospitals.length >= 2);
      for (const { hospital } of hospitals)
        assert.equal(
          (await discovered(own, hospital.fhirBase)).issuer,
          hospital.fhirBase,
        );
    });

    it("reaches a hospital's sign-in page at `<FHIR base>/authorize`", async () => {
      const own = demoFetch(hospitals);
      const answer = await own(`${NORTH_SIGN_IN}?client_id=x`);
      assert.equal(answer.status, 400);
    });

    it("answers 404 for a demo address no hospital is at", async () => {
      const own = demoFetch(hospitals);
      const answer = await own("https://nowhere.demo.invalid/fhir/metadata");
      assert.equal(answer.status, 404);
    });

    it("passes every other request to `fallback`", async () => {
      const { fallen, fallback } = fallingBack();
      const own = demoFetch(hospitals, { fallback });
      for (const url of ELSEWHERE)
        assert.equal(await (await own(url)).text(), "elsewhere", url);
      assert.deepEqual(fallen, ELSEWHERE);
    });

    it("exposes `Retry-After` to a page on another origin", async () => {
      const routed = demoFetch(hospitals, { authorizeBase: AUTHORIZE });
      const north = hospitals.find(({ hospital }) =>
        hospital.fhirBase.includes("cascade-north"),
      )!.hospital.fhirBase;
      const urls = [
        ["a discovery answer", `${north}/.well-known/smart-configuration`],
        ["a hospital's 400", `${NORTH_SIGN_IN}?client_id=x`],
        ["a 404 for an unknown host", "https://nowhere.demo.invalid/fhir/x"],
        ["a 404 for an unknown id", `${AUTHORIZE}nowhere/authorize`],
        ["a 404 for an unknown page", `${AUTHORIZE}cascade-north/elsewhere`],
      ];
      for (const [why, url] of urls)
        assert.match(
          (await routed(url!)).headers.get("Access-Control-Expose-Headers") ??
            "",
          /Retry-After/,
          why,
        );
    });
  });

  describe("with `authorizeBase`", () => {
    it("names each hospital's sign-in page under it in discovery", async () => {
      const routed = demoFetch(hospitals, { authorizeBase: AUTHORIZE });
      for (const { hospital } of hospitals) {
        const { authorization_endpoint: endpoint } = await discovered(
          routed,
          hospital.fhirBase,
        );
        assert.ok(endpoint.startsWith(AUTHORIZE), endpoint);
      }
    });

    it("serves each hospital's sign-in page at `<authorizeBase><id>/authorize`", async () => {
      const routed = demoFetch(hospitals, { authorizeBase: AUTHORIZE });
      for (const { hospital } of hospitals) {
        const { authorization_endpoint: endpoint } = await discovered(
          routed,
          hospital.fhirBase,
        );
        const page = await routed(signInRequest(endpoint, hospital.fhirBase));
        assert.equal(page.status, 200, endpoint);
        assert.match(await page.text(), new RegExp(hospital.name), endpoint);
      }
    });

    it("answers 404 under it for an id or a page that is not there", async () => {
      const routed = demoFetch(hospitals, { authorizeBase: AUTHORIZE });
      for (const url of [
        `${AUTHORIZE}nowhere/authorize`,
        `${AUTHORIZE}cascade-north/elsewhere`,
      ])
        assert.equal((await routed(url)).status, 404, url);
    });
  });
});
