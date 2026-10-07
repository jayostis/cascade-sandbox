import assert from "node:assert/strict";
import { test } from "node:test";
import { demoFetch, isDemoRequest } from "../src/index.js";
import { loadHospitals } from "../src/node/index.js";

const APP = "http://127.0.0.1:8080/connect/";
const AUTHORIZE = `${APP}demo-hospitals/`;

test("demo requests are told from their URL alone, and each is answered by the hospital it names, or by the fallback", async () => {
  const hospitals = [...(await loadHospitals()).values()];
  const fallen: string[] = [];
  const fallback = (async (input: RequestInfo | URL) => {
    fallen.push(String(input instanceof Request ? input.url : input));
    return new Response("elsewhere");
  }) as typeof fetch;
  const routed = demoFetch(hospitals, { authorizeBase: AUTHORIZE, fallback });
  const own = demoFetch(hospitals, { fallback });

  const rows: [string, typeof fetch, boolean, number | string][] = [
    ...hospitals.map(
      ({ hospital }) =>
        [
          `${hospital.fhirBase}/.well-known/smart-configuration`,
          routed,
          true,
          hospital.fhirBase,
        ] as [string, typeof fetch, boolean, string],
    ),
    [`${AUTHORIZE}cascade-north/authorize?client_id=x`, routed, true, 400],
    [
      "https://cascade-north.demo.invalid/fhir/authorize?client_id=x",
      own,
      true,
      400,
    ],
    ["https://nowhere.demo.invalid/fhir/metadata", routed, true, 404],
    [`${AUTHORIZE}nowhere/authorize`, routed, true, 404],
    [`${AUTHORIZE}cascade-north/elsewhere`, routed, true, 404],
    [`${APP}index.html`, routed, false, "elsewhere"],
    ["https://example.org/fhir/metadata", routed, false, "elsewhere"],
  ];
  for (const [url, fetch, claimed, answer] of rows) {
    assert.equal(
      isDemoRequest(url, fetch === routed ? { authorizeBase: AUTHORIZE } : {}),
      claimed,
      url,
    );
    const response = await fetch(url);
    if (typeof answer === "number") {
      assert.equal(response.status, answer, url);
      assert.match(
        response.headers.get("Access-Control-Expose-Headers") ?? "",
        /Retry-After/,
        url,
      );
    } else if (claimed) {
      const discovered = (await response.json()) as {
        issuer: string;
        authorization_endpoint: string;
      };
      assert.equal(discovered.issuer, answer, url);
      assert.ok(
        discovered.authorization_endpoint.startsWith(AUTHORIZE),
        discovered.authorization_endpoint,
      );
      assert.match(
        response.headers.get("Access-Control-Expose-Headers") ?? "",
        /Retry-After/,
        url,
      );
      const authorize = discovered.authorization_endpoint;
      const page = await routed(
        `${authorize}?${new URLSearchParams({
          response_type: "code",
          client_id: "test-app",
          redirect_uri: `${APP}signed-in.html`,
          scope: "launch/patient",
          state: "s",
          aud: answer,
          code_challenge: "c",
          code_challenge_method: "S256",
        })}`,
      );
      assert.equal(page.status, 200, authorize);
      const named = hospitals.find(
        ({ hospital }) => hospital.fhirBase === answer,
      );
      assert.ok(named, url);
      assert.match(
        await page.text(),
        new RegExp(named.hospital.name),
        authorize,
      );
    } else assert.equal(await response.text(), answer, url);
  }
  assert.deepEqual(fallen, [
    `${APP}index.html`,
    "https://example.org/fhir/metadata",
  ]);
});
