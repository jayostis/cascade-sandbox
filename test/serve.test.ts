import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { demoFetch, demoRemapFetch, HospitalDataError } from "../src/index.js";
import {
  type DemoListener,
  type LoadedHospital,
  loadHospitals,
  serveDemo,
} from "../src/node/index.js";
import { send } from "../src/node/serve.js";
import { pkcePair, signInThrough } from "../src/testing.js";

const REDIRECT = "https://app.example/callback";
const NORTH_HOST = "cascade-north.demo.invalid";
const METADATA = "/cascade-north/fhir/metadata";
const DISCOVERY = "/cascade-north/fhir/.well-known/smart-configuration";
const WORLD_DATE = "/world-date";
const SERVE_CLI = fileURLToPath(
  new URL("../src/node/serve-cli.js", import.meta.url),
);

let hospitals: LoadedHospital[];
let BASE: string;
let PATIENT: string;
let listener: DemoListener;
/** The requests the listener has handed to the hospitals, in order. */
const handed: Request[] = [];

before(async () => {
  hospitals = await loadHospitals();
  const cascadeNorth = hospitals.find(({ hospital }) =>
    hospital.fhirBase.includes("cascade-north"),
  )!;
  BASE = cascadeNorth.hospital.fhirBase;
  PATIENT = Object.keys(cascadeNorth.patients)[0]!;
  listener = await serveDemo(hospitals, {
    hosts: ["sandbox.test"],
    onRequest: (request) => handed.push(request),
  });
});
after(() => listener.close());

const signInUrl = (origin: string) =>
  `${origin}/cascade-north/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: "test-app",
    redirect_uri: REDIRECT,
    scope: "launch/patient patient/*.rs",
    state: "s",
    aud: BASE,
    code_challenge: pkcePair().challenge,
    code_challenge_method: "S256",
  })}`;

async function tokenFor(
  fetch: typeof globalThis.fetch,
  patient = PATIENT,
  base = BASE,
) {
  return (await signInThrough(fetch, base, patient)).token;
}

async function pullObservations(fetch: typeof globalThis.fetch, base = BASE) {
  const token = await tokenFor(fetch, PATIENT, base);
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

/** Makes a fixture once, when the first leaf that needs it asks, and hands every later leaf the same one. */
function remembered<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => (made ??= make());
}

const throughRemap = remembered(() =>
  pullObservations(demoRemapFetch(listener.origin)),
);
const inProcess = remembered(() =>
  pullObservations(
    demoFetch(hospitals, { authorizeBase: "http://127.0.0.1:1/" }),
  ),
);
const directBase = () => `${listener.origin}/cascade-north/fhir`;
const throughListener = remembered(async () => {
  const found = await (
    await fetch(`${directBase()}/.well-known/smart-configuration`)
  ).json();
  const metadata = await (await fetch(`${directBase()}/metadata`)).json();
  return {
    found,
    metadata,
    pulled: await pullObservations(fetch, directBase()),
  };
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

const forwarded = (host: string, proto = "https") => ({
  Forwarded: `host=${host};proto=${proto}`,
});

/** A request as a page on another origin makes it, and the status each is answered with. */
interface Ask {
  readonly why: string;
  readonly method: string;
  readonly path: string;
  readonly body?: string;
  readonly status: number;
}
const READS: Ask[] = [
  { why: "discovery", method: "GET", path: DISCOVERY, status: 200 },
  { why: "metadata", method: "GET", path: METADATA, status: 200 },
  {
    why: "Patient with no token",
    method: "GET",
    path: "/cascade-north/fhir/Patient",
    status: 401,
  },
];
const TOKEN: Ask = {
  why: "token",
  method: "POST",
  path: "/cascade-north/fhir/token",
  body: "grant_type=nothing",
  status: 400,
};
const PREFLIGHTS: Ask[] = [
  { why: "token", method: "OPTIONS", path: TOKEN.path, status: 204 },
  {
    why: "Patient",
    method: "OPTIONS",
    path: "/cascade-north/fhir/Patient",
    status: 204,
  },
  { why: "metadata", method: "OPTIONS", path: METADATA, status: 204 },
];
const SIGN_IN_PAGE: Ask[] = [
  {
    why: "authorize page",
    method: "GET",
    path: "/cascade-north/authorize",
    status: 400,
  },
  {
    why: "authorize preflight",
    method: "OPTIONS",
    path: "/cascade-north/authorize",
    status: 404,
  },
];
const WORLD_DATE_ASKS: Ask[] = [
  {
    why: "world-date post",
    method: "POST",
    path: WORLD_DATE,
    body: "asOf=",
    status: 200,
  },
  {
    why: "world-date preflight",
    method: "OPTIONS",
    path: WORLD_DATE,
    status: 405,
  },
];

async function ask({ method, path, body }: Ask) {
  return fetch(`${listener.origin}${path}`, {
    method,
    body,
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

async function signInPageDate(origin = listener.origin) {
  return /Records as they stood on <time datetime="([^"]+)"/.exec(
    await (await fetch(signInUrl(origin))).text(),
  )?.[1];
}

function moveDate(asOf?: string, headers: Record<string, string> = {}) {
  return fetch(`${listener.origin}${WORLD_DATE}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(asOf === undefined ? {} : { asOf }),
  });
}

/**
 * `serveDemo()` starts the demo hospitals on a port of this machine, the listener, for a caller that needs a real
 * address: a browser, a tool in another language, an app in a container. `demoRemapFetch()` is a `fetch` that sends a
 * request for a hospital's own address to the listener.
 */
describe("Serving the demo hospitals at a real address · serveDemo(), demoRemapFetch()", () => {
  describe("serveDemo(hospitals, options)", () => {
    it("passes the caller's `Content-Type` and `Accept` on to the hospital", async () => {
      const start = handed.length;
      await demoRemapFetch(listener.origin)(`${BASE}/metadata`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/fhir+json",
        },
        body: "a=b",
      });
      const got = handed.at(start)!.headers;
      assert.equal(
        got.get("Content-Type"),
        "application/x-www-form-urlencoded",
      );
      assert.equal(got.get("Accept"), "application/fhir+json");
    });

    it("answers as of `options.asOf` from its first request", async () => {
      const dated = await serveDemo(hospitals, {
        asOf: "2023-08-01T00:00:00Z",
      });
      try {
        assert.equal(
          await signInPageDate(dated.origin),
          "2023-08-01T00:00:00Z",
        );
      } finally {
        await dated.close();
      }
    });
  });

  describe("demoRemapFetch(origin)", () => {
    it("returns the records the in-process `demoFetch()` returns", async () => {
      const through = await throughRemap();
      assert.ok(through.pages > 1, "the search pages, so next was followed");
      assert.ok(through.records.length > 0);
      assert.deepEqual(through.records, (await inProcess()).records);
    });

    it("names the hospital's own address in every link and `fullUrl`", async () => {
      const { addresses } = await throughRemap();
      assert.ok(addresses.length > 0);
      for (const address of addresses)
        assert.ok(address.startsWith(`${BASE}/`), address);
    });

    it("follows a redirect to a demo address through the listener", async () => {
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
      const followed = await demoRemapFetch(
        listener.origin,
        fallback,
      )(`${BASE}/start`);
      assert.equal(await followed.text(), "ok");
      assert.deepEqual(seen, [
        `${listener.origin}/cascade-north/fhir/start`,
        `${listener.origin}/cascade-north/fhir/metadata`,
      ]);
    });

    it('returns a redirect unfollowed under `redirect: "manual"`', async () => {
      const seen: string[] = [];
      const fallback: typeof fetch = async (input) => {
        seen.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { Location: `${BASE}/metadata` },
        });
      };
      const answer = await demoRemapFetch(listener.origin, fallback)(
        `${BASE}/start`,
        { redirect: "manual" },
      );
      assert.equal(answer.status, 302);
      assert.equal(seen.length, 1);
    });

    it('rejects a redirect that never ends with "too many redirects"', async () => {
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

    for (const [title, location, sent] of [
      [
        "keeps `Authorization` on a redirect within the origin",
        `${BASE}/metadata`,
        "Bearer t",
      ],
      [
        "drops `Authorization` on a redirect to another host",
        "https://other.example/metadata",
        null,
      ],
      [
        "drops `Authorization` on a redirect to another port of the host",
        "https://cascade-north.demo.invalid:8443/metadata",
        null,
      ],
    ] as const)
      it(title, async () => {
        const seen: (string | null)[] = [];
        const fallback: typeof fetch = async (_, init) => {
          seen.push(new Headers(init?.headers).get("Authorization"));
          return seen.length === 1
            ? new Response(null, {
                status: 302,
                headers: { Location: location },
              })
            : new Response("ok");
        };
        await demoRemapFetch(listener.origin, fallback)(`${BASE}/start`, {
          headers: { Authorization: "Bearer t" },
        });
        assert.deepEqual(seen, ["Bearer t", sent]);
      });
  });

  describe("when a caller has only the listener's address", () => {
    it("names `<origin>/<id>/fhir` as the issuer in discovery", async () => {
      const { found } = await throughListener();
      assert.equal(found.issuer, directBase());
    });

    it("names the sign-in and token addresses of discovery in `metadata` too", async () => {
      const { found, metadata } = await throughListener();
      const uris = Object.fromEntries(
        metadata.rest[0].security.extension[0].extension.map(
          (each: { url: string; valueUri: string }) => [
            each.url,
            each.valueUri,
          ],
        ),
      );
      assert.deepEqual(uris, {
        authorize: found.authorization_endpoint,
        token: found.token_endpoint,
      });
      for (const endpoint of Object.values(uris))
        assert.ok(String(endpoint).startsWith(`${directBase()}/`));
    });

    it("returns the records a remapped pull returns", async () => {
      const { pulled } = await throughListener();
      assert.ok(pulled.pages > 1, "the search pages, so next was followed");
      assert.ok(pulled.records.length > 0);
      assert.deepEqual(pulled.records, (await throughRemap()).records);
    });

    it("names the listener's address in every link and `fullUrl`", async () => {
      const { pulled } = await throughListener();
      assert.ok(pulled.addresses.length > 0);
      for (const address of pulled.addresses)
        assert.ok(address.startsWith(`${directBase()}/`), address);
    });

    const signInWith = async (aud: string) => {
      const asked = new URL(`${directBase()}/authorize`);
      asked.search = new URL(signInUrl(listener.origin)).search;
      asked.searchParams.set("aud", aud);
      const answer = await fetch(asked, { redirect: "manual" });
      const location = answer.headers.get("Location");
      return {
        status: answer.status,
        location,
        error: location && new URL(location).searchParams.get("error"),
      };
    };

    it("shows the sign-in page for an `aud` that is the base the caller came to", async () => {
      const { status, location } = await signInWith(directBase());
      assert.equal(status, 200);
      assert.equal(location, null);
    });

    it("redirects with `invalid_request` for an `aud` that is the hospital's own base", async () => {
      const { status, error } = await signInWith(BASE);
      assert.equal(status, 302);
      assert.equal(error, "invalid_request");
    });
  });

  describe("when the listener is asked by another name", () => {
    it("answers at `localhost`, naming it as the issuer", async () => {
      const { port } = new URL(listener.origin);
      const { status, body } = await raw(DISCOVERY, {
        Host: `localhost:${port}`,
      });
      assert.equal(status, 200);
      assert.equal(
        JSON.parse(body).issuer,
        `http://localhost:${port}/cascade-north/fhir`,
      );
    });

    it("answers at `host.docker.internal`", async () => {
      const { port } = new URL(listener.origin);
      assert.equal(
        await rawStatus(METADATA, { Host: `host.docker.internal:${port}` }),
        200,
      );
    });

    it("answers at a name given in `hosts`", async () => {
      const { port } = new URL(listener.origin);
      assert.equal(
        await rawStatus(METADATA, { Host: `sandbox.test:${port}` }),
        200,
      );
    });

    it("answers at an IPv6 address", async () => {
      const { port } = new URL(listener.origin);
      assert.equal(await rawStatus(METADATA, { Host: `[::1]:${port}` }), 200);
    });

    it("answers 403 for any other name", async () => {
      const { port } = new URL(listener.origin);
      const rows: [string, Record<string, string>][] = [
        ["a rebinding name, direct", { Host: `rebind.example:${port}` }],
        [
          "a rebinding name, with Forwarded",
          { Host: `rebind.example:${port}`, ...forwarded(NORTH_HOST) },
        ],
      ];
      for (const [why, headers] of rows)
        assert.equal(await rawStatus(METADATA, headers), 403, why);
    });

    it("answers 400 for a `Host` that is no host name", async () => {
      assert.equal(await rawStatus(METADATA, { Host: "a/b" }), 400);
    });
  });

  describe("when a request cannot be placed", () => {
    it("answers 400 for a `Forwarded` host that is another hospital's than the path's", async () => {
      assert.equal(
        await rawStatus(METADATA, forwarded("cascade-south.demo.invalid")),
        400,
      );
    });

    it("answers 400 for a `Forwarded` host that is no demo hospital's", async () => {
      assert.equal(await rawStatus(METADATA, forwarded("example.org")), 400);
    });

    it("answers 400 for a `Forwarded` request with no hospital id in its path", async () => {
      assert.equal(await rawStatus("/", forwarded(NORTH_HOST)), 400);
    });

    it("answers 400 for a `Forwarded` protocol that is not https", async () => {
      assert.equal(
        await rawStatus(METADATA, forwarded(NORTH_HOST, "http")),
        400,
      );
    });

    it("answers 400 for a target that is a whole URL", async () => {
      const rows: [string, string, Record<string, string>][] = [
        [
          "no Forwarded",
          `https://${NORTH_HOST}/fhir/.well-known/smart-configuration`,
          {},
        ],
        [
          "Forwarded",
          `https://${NORTH_HOST}/fhir/metadata`,
          forwarded(NORTH_HOST),
        ],
      ];
      for (const [why, target, headers] of rows)
        assert.equal(await rawStatus(target, headers), 400, why);
    });

    it("answers 400 for a target that begins with two slashes", async () => {
      const rows: [string, string][] = [
        ["protocol-relative", `//${NORTH_HOST}/fhir/metadata`],
        ["with a backslash", `/\\${NORTH_HOST}/fhir/metadata`],
      ];
      for (const [why, target] of rows)
        assert.equal(await rawStatus(target, {}), 400, why);
    });

    it("answers 404 for a hospital it does not serve", async () => {
      assert.equal(
        await rawStatus(
          "/nowhere/fhir/metadata",
          forwarded("nowhere.demo.invalid"),
        ),
        404,
      );
    });

    it("answers 404 for a path with no hospital id", async () => {
      assert.equal(await rawStatus("/", {}), 404);
    });

    it("serves a `Forwarded` host that names the https port as the same host", async () => {
      assert.equal(
        await rawStatus(DISCOVERY, forwarded(`${NORTH_HOST}:443`)),
        200,
      );
    });
  });

  describe("when a page on another origin asks", () => {
    it("allows any origin to read discovery, `metadata` and the records", async () => {
      for (const row of READS) {
        const response = await ask(row);
        assert.equal(response.status, row.status, row.why);
        assert.equal(
          response.headers.get("Access-Control-Allow-Origin"),
          "*",
          row.why,
        );
      }
    });

    it("allows any origin to post to the token endpoint, marking the answer `no-store`", async () => {
      const response = await ask(TOKEN);
      assert.equal(response.status, TOKEN.status);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("Pragma"), "no-cache");
    });

    it("answers a preflight of those with the methods and headers a client sends", async () => {
      for (const row of PREFLIGHTS) {
        const response = await ask(row);
        const header = (name: string) => response.headers.get(name);
        assert.equal(response.status, row.status, row.why);
        assert.equal(header("Access-Control-Allow-Origin"), "*", row.why);
        assert.equal(
          header("Access-Control-Allow-Methods"),
          "GET, POST",
          row.why,
        );
        assert.equal(
          header("Access-Control-Allow-Headers"),
          "Authorization, Content-Type, Accept",
          row.why,
        );
      }
    });

    it("allows no other origin to read the sign-in page", async () => {
      for (const row of SIGN_IN_PAGE) {
        const response = await ask(row);
        assert.equal(response.status, row.status, row.why);
        assert.equal(
          response.headers.get("Access-Control-Allow-Origin"),
          null,
          row.why,
        );
      }
    });

    it("allows no other origin to move the world's date", async () => {
      for (const row of WORLD_DATE_ASKS) {
        const response = await ask(row);
        assert.equal(response.status, row.status, row.why);
        assert.equal(
          response.headers.get("Access-Control-Allow-Origin"),
          null,
          row.why,
        );
      }
    });

    it("never allows credentials", async () => {
      const every = [
        ...READS,
        TOKEN,
        ...PREFLIGHTS,
        ...SIGN_IN_PAGE,
        ...WORLD_DATE_ASKS,
      ];
      assert.equal(every.length, 11);
      for (const row of every) {
        const response = await ask(row);
        assert.equal(response.status, row.status, row.why);
        assert.equal(
          response.headers.get("Access-Control-Allow-Credentials"),
          null,
          row.why,
        );
      }
    });
  });

  describe("when the world's date is moved", () => {
    afterEach(() => listener.setWorldDate(undefined));

    /** How many Observations a token for `story-stopped` finds at the hospital, through the remap. */
    async function counter() {
      const remap = demoRemapFetch(listener.origin);
      const token = await tokenFor(remap, "story-stopped");
      return async () =>
        (
          await (
            await remap(
              `${BASE}/Observation?patient=story-stopped&_count=100`,
              {
                headers: { Authorization: `Bearer ${token}` },
              },
            )
          ).json()
        ).entry?.length ?? 0;
    }

    it("shows no date on the sign-in page until one is set", async () => {
      assert.equal(await signInPageDate(), undefined);
    });

    it("answers the next request as of the date posted to `/world-date`", async () => {
      assert.equal((await moveDate("2000-01-01T00:00:00Z")).status, 200);
      assert.equal(await signInPageDate(), "2000-01-01T00:00:00Z");
    });

    it("answers a token issued before the move as of the new date", async () => {
      const count = await counter();
      const all = await count();
      listener.setWorldDate("2023-08-01T00:00:00Z");
      assert.ok((await count()) < all);
    });

    it("answers 400 for an `asOf` that is not an instant, leaving the date", async () => {
      assert.equal((await moveDate("2000-01-01T00:00:00Z")).status, 200);
      const rows: [string, string | undefined][] = [
        ["not an instant", "yesterday"],
        ["no asOf", undefined],
      ];
      for (const [why, asOf] of rows)
        assert.equal((await moveDate(asOf)).status, 400, why);
      assert.equal(await signInPageDate(), "2000-01-01T00:00:00Z");
    });

    it("answers 403 for a post from a page on another site, leaving the date", async () => {
      assert.equal((await moveDate("2000-01-01T00:00:00Z")).status, 200);
      const later = "2020-01-01T00:00:00Z";
      const rows: [string, Record<string, string>][] = [
        ["another Origin", { Origin: "https://elsewhere.example" }],
        ["a cross-site fetch", { "Sec-Fetch-Site": "cross-site" }],
      ];
      for (const [why, headers] of rows)
        assert.equal((await moveDate(later, headers)).status, 403, why);
      assert.equal(await signInPageDate(), "2000-01-01T00:00:00Z");
    });

    it("returns to every version when `asOf` is posted empty", async () => {
      assert.equal((await moveDate("2000-01-01T00:00:00Z")).status, 200);
      assert.equal(await signInPageDate(), "2000-01-01T00:00:00Z");
      assert.equal((await moveDate("")).status, 200);
      assert.equal(await signInPageDate(), undefined);
    });

    it("returns to every version on `setWorldDate(undefined)`", async () => {
      const count = await counter();
      const all = await count();
      listener.setWorldDate("2023-08-01T00:00:00Z");
      assert.ok((await count()) < all);
      listener.setWorldDate(undefined);
      assert.equal(await count(), all);
    });

    it("throws `HospitalDataError` from `setWorldDate()` for a value that is not an instant", async () => {
      listener.setWorldDate("2000-01-01T00:00:00Z");
      assert.throws(
        () => listener.setWorldDate("yesterday"),
        (error) =>
          error instanceof HospitalDataError &&
          error.where === "asOf" &&
          error.reason === "asOf is an instant, as 2024-02-01T00:00:00Z",
      );
      assert.equal(await signInPageDate(), "2000-01-01T00:00:00Z");
    });
  });
});

/**
 * `npm run serve` starts the same listener in a process of its own and prints where each hospital is, for a tool outside
 * Node such as curl or Inferno.
 */
describe("Starting the demo hospitals from a terminal · npm run serve", () => {
  describe("when it starts", () => {
    let cli: ChildProcess;
    let printed = "";

    before(async () => {
      cli = spawn(process.execPath, [SERVE_CLI], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      for await (const chunk of cli.stdout!) {
        printed += String(chunk);
        if (printed.includes("world-date")) break;
      }
    });
    after(() => cli.kill());

    const origin = () => /^Listening at (\S+)$/m.exec(printed)?.[1];
    const basesOf = () =>
      [...printed.matchAll(/^hospital cascade-north (\S+) /gm)].map(
        ([, base]) => base,
      );

    it("prints `Listening at <origin>`", () => {
      assert.ok(origin(), printed);
    });

    it("prints each hospital's base at the listener and at `host.docker.internal`", () => {
      const at = origin()!;
      const { port } = new URL(at);
      assert.deepEqual(basesOf(), [
        `${at}/cascade-north/fhir`,
        `http://host.docker.internal:${port}/cascade-north/fhir`,
      ]);
    });

    it("serves a hospital at the base it printed", async () => {
      const [first] = basesOf();
      const found = await (
        await fetch(`${first}/.well-known/smart-configuration`)
      ).json();
      assert.equal(found.issuer, first);
    });
  });

  describe("when an argument is wrong", () => {
    for (const [title, args, sentence] of [
      [
        'prints the usage and "--port is a number up to 65535.", and exits 2',
        ["--port", "x"],
        "--port is a number up to 65535.",
      ],
      [
        'prints the usage and "--as-of is an instant, as 2024-02-01T00:00:00Z.", and exits 2',
        ["--as-of", "yesterday"],
        "--as-of is an instant, as 2024-02-01T00:00:00Z.",
      ],
    ] as const)
      it(title, async () => {
        const cli = spawn(process.execPath, [SERVE_CLI, ...args], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        const closed = once(cli, "close");
        let said = "";
        for await (const chunk of cli.stderr) said += String(chunk);
        assert.equal((await closed)[0], 2);
        assert.match(said, /^usage: npm run serve/);
        assert.ok(said.includes(sentence), said);
      });
  });
});

/** The listener writes each answer of a hospital to a Node response with `send()`; nothing else of the package calls it. */
describe("Writing a hospital's answer to a Node response · send()", () => {
  describe("send(outgoing, response)", () => {
    it("writes each `Set-Cookie` of the response as a header of its own", async () => {
      const server = createServer((_, outgoing) => {
        const headers = new Headers({ "Content-Type": "text/plain" });
        headers.append("Set-Cookie", "a=1; Path=/");
        headers.append("Set-Cookie", "b=2; Path=/");
        void send(outgoing, new Response("ok", { headers }));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
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
  });
});
