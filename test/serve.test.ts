import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { demoFetch, demoRemapFetch } from "../src/index.js";
import {
  type DemoListener,
  loadHospitals,
  serveDemo,
} from "../src/node/index.js";
import { headersOf } from "../src/node/serve.js";
import { pkcePair, signInAs } from "../src/testing.js";

const REDIRECT = "https://app.example/callback";

const hospitals = await loadHospitals();
const north = hospitals.find(({ hospital }) =>
  hospital.fhirBase.includes("cascade-north"),
)!;
const PATIENT = Object.keys(north.patients)[0]!;
const BASE = north.hospital.fhirBase;

let listener: DemoListener;
const handed: Request[] = [];
before(async () => {
  listener = await serveDemo(hospitals, {
    onRequest: (request) => handed.push(request),
  });
});
after(() => listener.close());

const signInAt = () =>
  `${listener.origin}/cascade-north/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: "test-app",
    redirect_uri: REDIRECT,
    scope: "launch/patient patient/*.rs",
    state: "s",
    aud: BASE,
    code_challenge: pkcePair().challenge,
    code_challenge_method: "S256",
  })}`;

async function signIn(fetch: typeof globalThis.fetch, patient = PATIENT) {
  return (await signInAs({ fetch, base: BASE }, patient)).token;
}

async function pullObservations(fetch: typeof globalThis.fetch) {
  const token = await signIn(fetch);
  const addresses: string[] = [];
  const records: string[] = [];
  let pages = 0;
  let next: string | undefined =
    `${BASE}/Observation?patient=${PATIENT}&_count=2`;
  while (next !== undefined) {
    const bundle = await (
      await fetch(next, {
        headers: { Authorization: `Bearer ${token}` },
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
  const through = await pullObservations(demoRemapFetch(listener.origin));
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

/** A request with the target exactly as given, which `fetch` would not send as it is. */
function rawStatus(target: string, headers: Record<string, string>) {
  const { port } = new URL(listener.origin);
  return new Promise<number>((resolve, reject) =>
    httpRequest(
      { host: "127.0.0.1", port, path: target, headers },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    )
      .on("error", reject)
      .end(),
  );
}

test("a request the listener cannot place is refused, each for its reason", async () => {
  const forwarded = (host: string, proto = "https") => ({
    Forwarded: `host=${host};proto=${proto}`,
  });
  const north = "cascade-north.demo.invalid";
  const rows: [string, string, Record<string, string>, number][] = [
    [
      "host not the path's hospital",
      "/cascade-north/fhir/metadata",
      forwarded("cascade-south.demo.invalid"),
      400,
    ],
    [
      "host not a demo host",
      "/cascade-north/fhir/metadata",
      forwarded("example.org"),
      400,
    ],
    ["no id in the path", "/", forwarded(north), 400],
    [
      "proto not https",
      "/cascade-north/fhir/metadata",
      forwarded(north, "http"),
      400,
    ],
    [
      "absolute-form target, no Forwarded",
      `https://${north}/fhir/.well-known/smart-configuration`,
      {},
      400,
    ],
    [
      "absolute-form target, Forwarded",
      `https://${north}/fhir/metadata`,
      forwarded(north),
      400,
    ],
    ["protocol-relative target", `//${north}/fhir/metadata`, {}, 400],
    [
      "protocol-relative target with a backslash",
      `/\\${north}/fhir/metadata`,
      {},
      400,
    ],
    [
      "unknown hospital",
      "/nowhere/fhir/metadata",
      forwarded("nowhere.demo.invalid"),
      404,
    ],
    ["no id and no header", "/", {}, 404],
    [
      "host with the https port is the same host",
      "/cascade-north/fhir/.well-known/smart-configuration",
      forwarded(`${north}:443`),
      200,
    ],
  ];
  for (const [why, target, headers, status] of rows)
    assert.equal(await rawStatus(target, headers), status, why);
});

test("the listener hands the hospital the caller's Content-Type and Accept", async () => {
  handed.length = 0;
  await demoRemapFetch(listener.origin)(`${BASE}/metadata`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/fhir+json",
    },
    body: "a=b",
  });
  const got = handed.at(-1)!.headers;
  assert.equal(got.get("Content-Type"), "application/x-www-form-urlencoded");
  assert.equal(got.get("Accept"), "application/fhir+json");
});

test("a redirect to a demo address is followed through the remap, and left alone under manual", async () => {
  const seen: string[] = [];
  const fallback: typeof fetch = async (input) => {
    seen.push(String(input));
    return seen.length === 1
      ? new Response(null, {
          status: 302,
          headers: { Location: `${BASE}/metadata` },
        })
      : new Response("ok");
  };
  const remap = demoRemapFetch(listener.origin, fallback);
  const followed = await remap(`${BASE}/start`);
  assert.equal(await followed.text(), "ok");
  assert.deepEqual(seen, [
    `${listener.origin}/cascade-north/fhir/start`,
    `${listener.origin}/cascade-north/fhir/metadata`,
  ]);
  seen.length = 0;
  assert.equal(
    (await remap(`${BASE}/start`, { redirect: "manual" })).status,
    302,
  );
  assert.equal(seen.length, 1);
  const endless = demoRemapFetch(
    listener.origin,
    async () =>
      new Response(null, {
        status: 302,
        headers: { Location: `${BASE}/again` },
      }),
  );
  await assert.rejects(endless(`${BASE}/again`), /too many redirects/);
});

test("a token stays valid across a change of the world's date, and answers as of the new date", async () => {
  const remap = demoRemapFetch(listener.origin);
  const token = await signIn(remap, "story-stopped");
  const count = async () =>
    (
      await (
        await remap(`${BASE}/Observation?patient=story-stopped&_count=100`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json()
    ).entry?.length ?? 0;
  const all = await count();
  listener.setWorldDate("2023-08-01T00:00:00Z");
  try {
    assert.ok(
      (await count()) < all,
      "the same token answers as of the new date",
    );
  } finally {
    listener.setWorldDate(undefined);
  }
  assert.equal(await count(), all);
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

test("two cookies set by one response reach the client as two headers", async () => {
  const server = createServer((_, outgoing) => {
    const headers = new Headers({ "Content-Type": "text/plain" });
    headers.append("Set-Cookie", "a=1; Path=/");
    headers.append("Set-Cookie", "b=2; Path=/");
    outgoing.writeHead(200, headersOf(headers)).end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const answer = await fetch(`http://127.0.0.1:${port}/`);
    assert.deepEqual(answer.headers.getSetCookie(), [
      "a=1; Path=/",
      "b=2; Path=/",
    ]);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("a redirect that leaves the origin loses Authorization, and one that stays keeps it", async () => {
  const rows: [string, string, string | null][] = [
    ["the same origin", `${BASE}/metadata`, "Bearer t"],
    ["another host", "https://other.example/metadata", null],
    [
      "the same host on another port",
      "https://cascade-north.demo.invalid:8443/metadata",
      null,
    ],
  ];
  for (const [why, location, sent] of rows) {
    const seen: (string | null)[] = [];
    const fallback: typeof fetch = async (_, init) => {
      seen.push(new Headers(init?.headers).get("Authorization"));
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { Location: location } })
        : new Response("ok");
    };
    await demoRemapFetch(listener.origin, fallback)(`${BASE}/start`, {
      headers: { Authorization: "Bearer t" },
    });
    assert.deepEqual(seen, ["Bearer t", sent], why);
  }
});
