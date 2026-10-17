import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { demoFetch, demoRemapFetch } from "../src/index.js";
import {
  type DemoListener,
  loadHospitals,
  serveDemo,
} from "../src/node/index.js";
import { send } from "../src/node/serve.js";
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
    hosts: ["sandbox.test"],
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

async function signIn(
  fetch: typeof globalThis.fetch,
  patient = PATIENT,
  base = BASE,
) {
  return (await signInAs({ fetch, base }, patient)).token;
}

async function pullObservations(fetch: typeof globalThis.fetch, base = BASE) {
  const token = await signIn(fetch, PATIENT, base);
  const addresses: string[] = [];
  const records: string[] = [];
  let pages = 0;
  let next: string | undefined =
    `${base}/Observation?patient=${PATIENT}&_count=2`;
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

test("a caller with only the listener's address discovers, signs in, searches and pages, every link at the listener", async () => {
  const direct = `${listener.origin}/cascade-north/fhir`;
  const found = await (
    await fetch(`${direct}/.well-known/smart-configuration`)
  ).json();
  assert.equal(found.issuer, direct);
  const { security, resource } = (
    await (await fetch(`${direct}/metadata`)).json()
  ).rest[0];
  for (const each of resource.filter(
    (one: { interaction: { code: string }[] }) =>
      one.interaction.some(({ code }) => code === "search-type"),
  ))
    assert.ok(
      each.searchParam.some(
        (param: { name: string }) => param.name === "patient",
      ),
      each.type,
    );
  const uris = Object.fromEntries(
    security.extension[0].extension.map(
      (each: { url: string; valueUri: string }) => [each.url, each.valueUri],
    ),
  );
  assert.deepEqual(uris, {
    authorize: found.authorization_endpoint,
    token: found.token_endpoint,
  });
  for (const endpoint of Object.values(uris))
    assert.ok(String(endpoint).startsWith(`${direct}/`), String(endpoint));

  const pulled = await pullObservations(fetch, direct);
  const remapped = await pullObservations(demoRemapFetch(listener.origin));
  assert.ok(pulled.pages > 1, "the search pages, so next was followed");
  assert.deepEqual(pulled.records, remapped.records);
  for (const address of pulled.addresses)
    assert.ok(address.startsWith(`${direct}/`), address);
});

test("a direct sign-in takes the base it came to as aud, and refuses the hospital's own", async () => {
  const direct = `${listener.origin}/cascade-north/fhir`;
  const rows: [string, string, number, string | null][] = [
    ["the listener's base", direct, 200, null],
    ["the hospital's own base", BASE, 302, "invalid_request"],
  ];
  for (const [why, aud, status, error] of rows) {
    const asked = new URL(`${direct}/authorize`);
    asked.search = new URL(signInAt()).search;
    asked.searchParams.set("aud", aud);
    const answer = await fetch(asked, { redirect: "manual" });
    assert.equal(answer.status, status, why);
    const location = answer.headers.get("Location");
    assert.equal(
      location && new URL(location).searchParams.get("error"),
      error,
      why,
    );
  }
});

/** A request with the target exactly as given, which `fetch` would not send as it is. */
function raw(target: string, headers: Record<string, string>) {
  const { port } = new URL(listener.origin);
  return new Promise<{ status: number; body: string }>((resolve, reject) =>
    httpRequest(
      { host: "127.0.0.1", port, path: target, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    )
      .on("error", reject)
      .end(),
  );
}

async function rawStatus(target: string, headers: Record<string, string>) {
  return (await raw(target, headers)).status;
}

test("a direct caller gets the hospital at the host it asked", async () => {
  const { port } = new URL(listener.origin);
  const { body } = await raw(
    "/cascade-north/fhir/.well-known/smart-configuration",
    { Host: `localhost:${port}` },
  );
  assert.equal(
    JSON.parse(body).issuer,
    `http://localhost:${port}/cascade-north/fhir`,
  );
});

test("a browser app may read discovery, the token endpoint and the API from any origin, and the sign-in page and world-date from none", async () => {
  const base = `${listener.origin}/cascade-north`;
  const rows: [string, string, string, number, boolean][] = [
    ["GET", `${base}/fhir/.well-known/smart-configuration`, "", 200, true],
    ["GET", `${base}/fhir/metadata`, "", 200, true],
    ["POST", `${base}/fhir/token`, "grant_type=nothing", 400, true],
    ["GET", `${base}/fhir/Patient`, "", 401, true],
    ["OPTIONS", `${base}/fhir/token`, "", 204, true],
    ["OPTIONS", `${base}/fhir/Patient`, "", 204, true],
    ["OPTIONS", `${base}/fhir/metadata`, "", 204, true],
    ["GET", `${base}/authorize`, "", 400, false],
    ["OPTIONS", `${base}/authorize`, "", 404, false],
    ["POST", `${listener.origin}/world-date`, "asOf=", 200, false],
    ["OPTIONS", `${listener.origin}/world-date`, "", 405, false],
  ];
  for (const [method, url, body, status, cors] of rows) {
    const response = await fetch(url, {
      method,
      body: body === "" ? undefined : body,
      headers:
        body === ""
          ? {}
          : { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const why = `${method} ${url}`;
    assert.equal(response.status, status, why);
    const header = (name: string) => response.headers.get(name);
    assert.equal(header("Access-Control-Allow-Origin"), cors ? "*" : null, why);
    assert.equal(header("Access-Control-Allow-Credentials"), null, why);
    if (cors && method === "OPTIONS") {
      assert.equal(header("Access-Control-Allow-Methods"), "GET, POST", why);
      assert.equal(
        header("Access-Control-Allow-Headers"),
        "Authorization, Content-Type, Accept",
        why,
      );
    }
    if (url.endsWith("/token") && method === "POST") {
      assert.equal(header("Cache-Control"), "no-store", why);
      assert.equal(header("Pragma"), "no-cache", why);
    }
  }
});

test("a request the listener cannot place, or whose Host it does not answer, is refused, each for its reason", async () => {
  const forwarded = (host: string, proto = "https") => ({
    Forwarded: `host=${host};proto=${proto}`,
  });
  const north = "cascade-north.demo.invalid";
  const { port } = new URL(listener.origin);
  const metadata = "/cascade-north/fhir/metadata";
  const rows: [string, string, Record<string, string>, number][] = [
    [
      "a rebinding name, direct",
      metadata,
      { Host: `rebind.example:${port}` },
      403,
    ],
    [
      "a rebinding name, with Forwarded",
      metadata,
      { Host: `rebind.example:${port}`, ...forwarded(north) },
      403,
    ],
    ["localhost", metadata, { Host: `localhost:${port}` }, 200],
    [
      "host.docker.internal",
      metadata,
      { Host: `host.docker.internal:${port}` },
      200,
    ],
    ["a name given as a host", metadata, { Host: `sandbox.test:${port}` }, 200],
    ["an IPv6 literal", metadata, { Host: `[::1]:${port}` }, 200],
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
      "no Forwarded, and a Host that is not a host",
      "/cascade-north/fhir/metadata",
      { Host: "a/b" },
      400,
    ],
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

test("a POST to the listener's world-date moves the world's date for the next answer, and refuses what is not an instant or comes from another site", async () => {
  const signIn = signInAt();
  const move = (asOf?: string, headers: Record<string, string> = {}) =>
    fetch(`${listener.origin}/world-date`, {
      method: "POST",
      headers,
      body: new URLSearchParams(asOf === undefined ? {} : { asOf }),
    });
  const asOfLine = async () =>
    /Records as they stood on <time datetime="([^"]+)"/.exec(
      await (await fetch(signIn)).text(),
    )?.[1];
  assert.equal(await asOfLine(), undefined);
  try {
    assert.equal((await move("2000-01-01T00:00:00Z")).status, 200);
    assert.equal(await asOfLine(), "2000-01-01T00:00:00Z");
    const later = "2020-01-01T00:00:00Z";
    for (const [why, asOf, headers, status] of [
      ["not an instant", "yesterday", {}, 400],
      ["no asOf", undefined, {}, 400],
      ["another Origin", later, { Origin: "https://elsewhere.example" }, 403],
      ["a cross-site fetch", later, { "Sec-Fetch-Site": "cross-site" }, 403],
    ] as const)
      assert.equal((await move(asOf, headers)).status, status, why);
    assert.equal(
      await asOfLine(),
      "2000-01-01T00:00:00Z",
      "a refused move leaves the date",
    );
    assert.equal((await move("")).status, 200);
    assert.equal(await asOfLine(), undefined);
  } finally {
    listener.setWorldDate(undefined);
  }
});

const SERVE_CLI = fileURLToPath(
  new URL("../src/node/serve-cli.js", import.meta.url),
);

test("npm run serve prints each hospital's base by id, at the listener and at host.docker.internal", async () => {
  const cli = spawn(process.execPath, [SERVE_CLI], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    let printed = "";
    for await (const chunk of cli.stdout) {
      printed += String(chunk);
      if (printed.includes("world-date")) break;
    }
    const origin = /^Listening at (\S+)$/m.exec(printed)?.[1];
    assert.ok(origin, printed);
    const bases = [...printed.matchAll(/^hospital cascade-north (\S+) /gm)].map(
      ([, base]) => base,
    );
    const { port } = new URL(origin);
    assert.deepEqual(bases, [
      `${origin}/cascade-north/fhir`,
      `http://host.docker.internal:${port}/cascade-north/fhir`,
    ]);
    const found = await (
      await fetch(`${bases[0]}/.well-known/smart-configuration`)
    ).json();
    assert.equal(found.issuer, bases[0]);
  } finally {
    cli.kill();
  }
});

test("npm run serve given a bad argument prints the usage and exits 2", async () => {
  for (const args of [
    ["--port", "x"],
    ["--as-of", "yesterday"],
  ]) {
    const cli = spawn(process.execPath, [SERVE_CLI, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const closed = once(cli, "close");
    let said = "";
    for await (const chunk of cli.stderr) said += String(chunk);
    assert.equal((await closed)[0], 2, args.join(" "));
    assert.match(said, /^usage: npm run serve/, args.join(" "));
  }
});

test("two cookies set by one response reach the client as two headers", async () => {
  const server = createServer((_, outgoing) => {
    const headers = new Headers({ "Content-Type": "text/plain" });
    headers.append("Set-Cookie", "a=1; Path=/");
    headers.append("Set-Cookie", "b=2; Path=/");
    void send(outgoing, new Response("ok", { headers }));
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
