import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { demoFetch, remapFetch } from "../src/index.js";
import { type Listener, loadHospitals, serve } from "../src/node/index.js";

const VERIFIER = "a-verifier-long-enough-to-be-a-real-pkce-code-verifier-0123";
const REDIRECT = "https://app.example/callback";

const hospitals = await loadHospitals();
const north = hospitals.find(({ hospital }) =>
  hospital.fhirBase.includes("cascade-north"),
)!;
const PATIENT = Object.keys(north.patients)[0]!;
const BASE = north.hospital.fhirBase;

let listener: Listener;
before(async () => {
  listener = await serve(hospitals);
});
after(() => listener.close());

const authorizeQuery = () =>
  new URLSearchParams({
    response_type: "code",
    client_id: "test-app",
    redirect_uri: REDIRECT,
    scope: "launch/patient patient/*.rs",
    state: "s",
    aud: BASE,
    code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    code_challenge_method: "S256",
  });
const signInAt = () =>
  `${listener.origin}/cascade-north/authorize?${authorizeQuery()}`;

/** Signs in as `PATIENT` by the hospital's own discovery and sign-in page, then searches page by page as given. */
async function pullObservations(fetch: typeof globalThis.fetch) {
  const discovery = await (
    await fetch(`${BASE}/.well-known/smart-configuration`)
  ).json();
  const query = authorizeQuery();
  const page = await fetch(`${discovery.authorization_endpoint}?${query}`);
  assert.match(await page.text(), /Sign in/);
  const approved = await fetch(discovery.authorization_endpoint, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({
      ...Object.fromEntries(query),
      decision: "allow",
      patient: PATIENT,
    }),
  });
  const code = new URL(approved.headers.get("Location")!).searchParams.get(
    "code",
  )!;
  const token = await (
    await fetch(discovery.token_endpoint, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: "test-app",
        code_verifier: VERIFIER,
      }),
    })
  ).json();
  const addresses: string[] = [];
  const records: string[] = [];
  let pages = 0;
  let next: string | undefined =
    `${BASE}/Observation?patient=${PATIENT}&_count=2`;
  while (next !== undefined) {
    const bundle = await (
      await fetch(next, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      })
    ).json();
    pages += 1;
    for (const link of bundle.link) addresses.push(link.url);
    for (const entry of bundle.entry ?? []) {
      addresses.push(entry.fullUrl);
      records.push(`${entry.resource.resourceType}/${entry.resource.id}`);
    }
    next = bundle.link.find(
      (link: { relation: string }) => link.relation === "next",
    )?.url;
  }
  return { addresses, records, pages };
}

test("a pull through the remap names the address the client asked and returns what the in-process route returns", async () => {
  const through = await pullObservations(remapFetch(listener.origin));
  const inProcess = await pullObservations(
    demoFetch(hospitals, { authorizeBase: "http://127.0.0.1:1/" }),
  );
  assert.ok(through.pages > 1, "the search pages, so next was followed");
  assert.ok(through.records.length > 0);
  assert.deepEqual(through.records, inProcess.records);
  for (const address of through.addresses)
    assert.ok(address.startsWith(`${BASE}/`), address);
});

test("a request with no Forwarded header gets the sign-in page and nothing else", async () => {
  const signIn = signInAt();
  assert.equal((await fetch(signIn)).status, 200);
  assert.equal(
    (await fetch(`${listener.origin}/cascade-north/fhir/metadata`)).status,
    404,
  );
});

test("a request the listener cannot place is refused, each for its reason", async () => {
  const forwarded = (host: string) => ({
    Forwarded: `host=${host};proto=https`,
  });
  const rows: [string, Record<string, string>, number][] = [
    [
      "/cascade-north/fhir/metadata",
      forwarded("cascade-south.demo.invalid"),
      400,
    ],
    ["/cascade-north/fhir/metadata", forwarded("example.org"), 400],
    ["/", forwarded("cascade-north.demo.invalid"), 400],
    ["/nowhere/fhir/metadata", forwarded("nowhere.demo.invalid"), 404],
    ["/", {}, 404],
  ];
  for (const [path, headers, status] of rows)
    assert.equal(
      (await fetch(`${listener.origin}${path}`, { headers })).status,
      status,
      `${path} ${JSON.stringify(headers)}`,
    );
});

test("moving the world's date changes the next answer", async () => {
  const signIn = signInAt();
  const now = await (await fetch(signIn)).text();
  assert.doesNotMatch(now, /Records as they stood on/);
  listener.setWorldDate("2000-01-01T00:00:00Z");
  try {
    assert.match(
      await (await fetch(signIn)).text(),
      /Records as they stood on/,
    );
  } finally {
    listener.setWorldDate(undefined);
  }
});
