import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type DemoHospital,
  demoHospital,
  type Resource,
} from "../src/index.js";
import { loadHospital } from "../src/node/index.js";
import { answerSignIn, pkcePair, signInAs } from "../src/testing.js";

const north = await loadHospital("cascade-north");
const south = await loadHospital("cascade-south");
const NORTH = north.hospital.fhirBase;
const SOUTH = south.hospital.fhirBase;
const A_NORTH = "pt-1001";
const B_NORTH = "pt-1002";
const A_SOUTH = "s-48213";

const CLIENT = "test-app";
const REDIRECT = "https://app.example/callback";
const { verifier: VERIFIER, challenge: CHALLENGE } = pkcePair();
const START = new Date("2026-01-01T00:00:00Z");
const after = (seconds: number) => () =>
  new Date(START.getTime() + seconds * 1000);

function authorizeQuery(
  base: string,
  overrides: Record<string, string | undefined> = {},
): string {
  const query = new URLSearchParams();
  const parameters: Record<string, string | undefined> = {
    response_type: "code",
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    scope: "launch/patient patient/*.rs",
    state: "s-123",
    aud: base,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    ...overrides,
  };
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) query.set(name, value);
  }
  return query.toString();
}

function redirected(response: Response): URLSearchParams {
  assert.equal(response.status, 302);
  return new URL(response.headers.get("Location") ?? "").searchParams;
}

async function authorize(
  hospital: DemoHospital,
  base: string,
  overrides: Record<string, string | undefined> = {},
): Promise<Response> {
  return hospital(
    new Request(`${base}/authorize?${authorizeQuery(base, overrides)}`),
  );
}

async function exchange(
  hospital: DemoHospital,
  base: string,
  form: Record<string, string>,
): Promise<Response> {
  return hospital(
    new Request(`${base}/token`, {
      method: "POST",
      body: new URLSearchParams(form),
    }),
  );
}

function tokenForm(code: string, overrides: Record<string, string> = {}) {
  return {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: CLIENT,
    code_verifier: VERIFIER,
    ...overrides,
  };
}

const signIn = (data: typeof north, patient: string, scope?: string) =>
  signInAs(data, patient, {
    now: after(0),
    ...(scope === undefined ? {} : { scope }),
  });

function get(hospital: DemoHospital, url: string, token?: string) {
  return hospital(
    new Request(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );
}

function recordsOf(bundle: { entry?: { resource?: Resource }[] }): string[] {
  return (bundle.entry ?? []).flatMap(({ resource }) =>
    resource ? [`${resource.resourceType}/${resource.id}`] : [],
  );
}

async function searchAll(
  hospital: DemoHospital,
  url: string,
  token: string,
): Promise<{ pages: string[][]; nexts: boolean[] }> {
  const pages: string[][] = [];
  const nexts: boolean[] = [];
  let next: string | undefined = url;
  while (next) {
    const response = await get(hospital, next, token);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/fhir+json");
    const bundle = await response.json();
    assert.equal(bundle.type, "searchset");
    for (const entry of bundle.entry) {
      assert.equal(entry.search.mode, "match");
      assert.equal(
        entry.fullUrl,
        `${new URL(url).origin}${new URL(url).pathname.replace(/\/[^/]+$/, "")}/${entry.resource.resourceType}/${entry.resource.id}`,
      );
    }
    pages.push(recordsOf(bundle));
    next = bundle.link.find(
      (link: { relation: string }) => link.relation === "next",
    )?.url;
    nexts.push(next !== undefined);
  }
  return { pages, nexts };
}

const SEARCHES = [
  "AllergyIntolerance",
  "Condition",
  "Encounter",
  "Immunization",
  "MedicationRequest",
  "MedicationStatement",
  "Observation&category=laboratory",
  "Observation&category=vital-signs",
];

async function pullEverything(
  hospital: DemoHospital,
  base: string,
  patient: string,
  token: string,
  asked = patient,
) {
  const returned: string[] = [];
  const searched = new Set<string>();
  const paging: Record<string, boolean[]> = {};
  for (const search of SEARCHES) {
    const [type, rest] = search.split("&");
    const query = `${base}/${type}?patient=${asked}${rest ? `&${rest}` : ""}`;
    const { pages, nexts } = await searchAll(hospital, query, token);
    paging[search] = nexts;
    for (const page of pages) {
      returned.push(...page);
      for (const record of page) searched.add(record);
    }
  }
  const read = await get(hospital, `${base}/Patient/${patient}`, token);
  const record = await read.json();
  returned.push(`Patient/${record.id}`);
  return { returned, searched, paging };
}

const all = (data: typeof north) =>
  Object.values(data.patients).flatMap((bundle) => recordsOf(bundle));

test("a client walks the whole protocol for patient A at North", async () => {
  const base = NORTH;
  const discovery = await (
    await get(demoHospital(north), `${base}/.well-known/smart-configuration`)
  ).json();
  assert.equal(discovery.issuer, base);
  assert.deepEqual(discovery.code_challenge_methods_supported, ["S256"]);
  assert.equal(discovery.authorization_endpoint, `${base}/authorize`);

  const approving = demoHospital({ ...north, autoApprove: A_NORTH });
  const back = redirected(await authorize(approving, base));
  assert.equal(back.get("state"), "s-123");
  const another = demoHospital(north);
  const answer = await (
    await exchange(another, base, tokenForm(back.get("code") ?? ""))
  ).json();
  assert.equal(answer.token_type, "Bearer");
  assert.equal(answer.expires_in, 3600);
  assert.equal(answer.patient, A_NORTH);

  const token: string = answer.access_token;
  const { returned, searched, paging } = await pullEverything(
    another,
    base,
    A_NORTH,
    token,
  );
  const [leftOut] = north.hospital.hiddenFromSearch;
  const hiddenRead = await get(another, `${base}/${leftOut}`, token);
  assert.equal(hiddenRead.status, 200);
  const hidden = await hiddenRead.json();
  returned.push(`${hidden.resourceType}/${hidden.id}`);

  const expected = recordsOf(north.patients[A_NORTH] ?? {});
  assert.deepEqual([...returned].sort(), [...expected].sort());
  const elsewhere = [
    ...recordsOf(north.patients[B_NORTH] ?? {}),
    ...all(south),
  ];
  assert.ok(returned.every((record) => !elsewhere.includes(record)));
  assert.ok(!searched.has(leftOut ?? ""));
  assert.deepEqual(paging["Observation&category=laboratory"], [true, false]);

  const total = async (category: string) => {
    const query = new URLSearchParams({ patient: A_NORTH, category });
    const response = await get(another, `${base}/Observation?${query}`, token);
    return (await response.json()).total;
  };
  const labs = await total("laboratory");
  assert.equal(
    await total(
      "http://terminology.hl7.org/CodeSystem/observation-category|laboratory",
    ),
    labs,
  );
  assert.equal(
    await total("laboratory,vital-signs"),
    labs + (await total("vital-signs")),
  );
});

test("two hospitals: A at South is South's patient, and North's token is refused there", async () => {
  const { hospital, token } = await signIn(south, A_SOUTH);
  const { returned } = await pullEverything(
    hospital,
    SOUTH,
    A_SOUTH,
    token,
    `Patient/${A_SOUTH}`,
  );
  assert.deepEqual(
    [...returned].sort(),
    recordsOf(south.patients[A_SOUTH] ?? {}).sort(),
  );

  const fromNorth = await signIn(north, A_NORTH);
  const refused = await get(
    hospital,
    `${SOUTH}/Condition?patient=${A_SOUTH}`,
    fromNorth.token,
  );
  assert.equal(refused.status, 401);
});

test("a patient signs in through the page, which says what the app asks in words, or cancels", async () => {
  const hospital = demoHospital(north);
  const shown = await authorize(hospital, NORTH, {
    scope: "launch/patient patient/*.rs patient/Observation.read openid",
  });
  assert.equal(shown.status, 200);
  const page = await shown.text();
  const listed = [
    ...page.matchAll(/<label class="choice">[^>]*> ([^<]*)<\/label>/g),
  ].map(([, name]) => name ?? "");
  assert.equal(listed.length, Object.keys(north.patients).length);
  const byFamily = [...listed].sort((a, b) => {
    const [x, y] = [a, b].map((name) => name.split(", "));
    return (
      (x?.[0] ?? "").localeCompare(y?.[0] ?? "") ||
      (x?.[1] ?? "").localeCompare(y?.[1] ?? "")
    );
  });
  assert.deepEqual(listed, byFamily, "patients are not in family-name order");
  for (const name of [
    "Marsh, Rowan Ellery",
    "Fenn, Tobias",
    CLIENT,
    "Know which patient you are",
    "Read your whole health record",
    "Read your Observation records",
  ]) {
    assert.ok(page.includes(name), name);
  }
  const scopes = /<ul class="scopes">([\s\S]*?)<\/ul>/.exec(page)?.[1] ?? "";
  assert.equal(scopes.split("openid").length - 1, 1);
  const unscoped = await (
    await authorize(hospital, NORTH, { scope: undefined })
  ).text();
  assert.ok(!unscoped.includes("If you allow it"));

  const post = (decision: string) =>
    hospital(
      new Request(`${NORTH}/authorize`, {
        method: "POST",
        body: new URLSearchParams(
          `${authorizeQuery(NORTH)}&patient=${B_NORTH}&decision=${decision}`,
        ),
      }),
    );
  const allowed = redirected(await post("allow"));
  const answer = await (
    await exchange(hospital, NORTH, tokenForm(allowed.get("code") ?? ""))
  ).json();
  assert.equal(answer.patient, B_NORTH);

  const cancelled = redirected(await post("cancel"));
  assert.equal(cancelled.get("error"), "access_denied");
  assert.equal(cancelled.get("state"), "s-123");
  assert.equal(cancelled.get("code"), null);
});

test("answerSignIn gives the callback URL, with a code when allowed and an error when cancelled", async () => {
  const hospital = demoHospital(north);
  const through = (input: RequestInfo | URL, init?: RequestInit) =>
    hospital(new Request(input, init));
  const url = `${NORTH}/authorize?${authorizeQuery(NORTH)}`;
  const allowed = await answerSignIn(through, url, B_NORTH);
  assert.ok(allowed.searchParams.get("code"));
  const cancelled = await answerSignIn(through, url, B_NORTH, "cancel");
  assert.equal(cancelled.searchParams.get("error"), "access_denied");
  assert.equal(cancelled.searchParams.get("code"), null);
});

test("the sign-in page preselects the patient its login_hint names, in either order of words, and no one otherwise", async () => {
  const hospital = demoHospital(north);
  const preselected = async (hint?: string) => {
    const page = await (
      await authorize(hospital, NORTH, { login_hint: hint })
    ).text();
    return [...page.matchAll(/<input [^>]*checked[^>]*> ([^<]*)</g)].map(
      ([, name]) => name,
    );
  };
  const page = await (await authorize(hospital, NORTH, {})).text();
  const radios = page.match(/<input [^>]*name="patient"[^>]*>/g) ?? [];
  assert.ok(
    radios.length > 0 && radios.every((radio) => radio.includes(" required")),
    radios.join(),
  );
  assert.match(page, /<button [^>]*value="cancel" formnovalidate>/);
  assert.deepEqual(await preselected("rowan-ellery-marsh"), [
    "Marsh, Rowan Ellery",
  ]);
  assert.deepEqual(await preselected("Fenn Tobias"), ["Fenn, Tobias"]);
  for (const hint of [undefined, "", "tamsin-at-north", "rowan-marsh"])
    assert.deepEqual(await preselected(hint), [], String(hint));
});

test("each bad request is refused as the protocol says", async () => {
  const { hospital, code, token } = await signIn(north, A_NORTH);
  const later = (seconds: number) =>
    demoHospital({ ...north, now: after(seconds) });
  const observations = (
    await signIn(north, A_NORTH, "patient/Observation.read")
  ).token;
  const unscoped = (await signIn(north, A_NORTH, "")).token;
  const notReading = await Promise.all(
    [
      "patient/*.write",
      "patient/Observation.s",
      "patient/Observation.rs?category=laboratory",
      "user/*.read",
    ].map(
      async (scope) =>
        [scope, (await signIn(north, A_NORTH, scope)).token] as const,
    ),
  );

  const authorizeRows: [
    string,
    Record<string, string | undefined>,
    number,
    string,
  ][] = [
    ["no challenge", { code_challenge: undefined }, 302, "invalid_request"],
    [
      "a plain method",
      { code_challenge_method: "plain" },
      302,
      "invalid_request",
    ],
    [
      "another method",
      { code_challenge_method: "S512" },
      302,
      "invalid_request",
    ],
    ["a wrong aud", { aud: SOUTH }, 302, "invalid_request"],
    ["no redirect_uri", { redirect_uri: undefined }, 400, ""],
    ["no client_id", { client_id: undefined }, 400, ""],
    [
      "a patient not at this hospital",
      { decision: "allow", patient: "constructor" },
      302,
      "access_denied",
    ],
  ];
  for (const [name, overrides, status, error] of authorizeRows) {
    const response =
      overrides.decision === undefined
        ? await authorize(hospital, NORTH, overrides)
        : await hospital(
            new Request(`${NORTH}/authorize`, {
              method: "POST",
              body: new URLSearchParams(authorizeQuery(NORTH, overrides)),
            }),
          );
    assert.equal(response.status, status, name);
    if (status === 302) {
      const back = redirected(response);
      assert.equal(back.get("error"), error, name);
      assert.equal(back.get("state"), "s-123", name);
    }
  }

  const tokenRows: [string, DemoHospital, Record<string, string>, string][] = [
    [
      "a wrong verifier",
      hospital,
      tokenForm(code, { code_verifier: "x".repeat(50) }),
      "invalid_grant",
    ],
    ["an unknown code", hospital, tokenForm(`${code}x`), "invalid_grant"],
    ["an expired code", later(301), tokenForm(code), "invalid_grant"],
    [
      "another redirect_uri",
      hospital,
      tokenForm(code, { redirect_uri: "https://app.example/other" }),
      "invalid_grant",
    ],
    [
      "another client_id",
      hospital,
      tokenForm(code, { client_id: "other-app" }),
      "invalid_grant",
    ],
    [
      "a missing parameter",
      hospital,
      tokenForm(code, { code_verifier: "" }),
      "invalid_request",
    ],
    [
      "no grant_type",
      hospital,
      tokenForm(code, { grant_type: "" }),
      "invalid_request",
    ],
    [
      "another grant_type",
      hospital,
      tokenForm(code, { grant_type: "refresh_token" }),
      "unsupported_grant_type",
    ],
  ];
  for (const [name, at, form, error] of tokenRows) {
    const response = await exchange(at, NORTH, form);
    assert.equal(response.status, 400, name);
    assert.equal((await response.json()).error, error, name);
  }

  type FhirRow = [
    string,
    DemoHospital,
    string,
    string | undefined,
    number,
    string,
    string?,
  ];
  const fhirRows: FhirRow[] = [
    [
      "no token",
      hospital,
      `Condition?patient=${A_NORTH}`,
      undefined,
      401,
      "login",
    ],
    [
      "a malformed token",
      hospital,
      `Condition?patient=${A_NORTH}`,
      "not-a-token",
      401,
      "login",
    ],
    [
      "a code as a token",
      hospital,
      `Condition?patient=${A_NORTH}`,
      code,
      401,
      "login",
    ],
    [
      "an expired token",
      later(3601),
      `Condition?patient=${A_NORTH}`,
      token,
      401,
      "login",
    ],
    [
      "another patient's search",
      hospital,
      `Condition?patient=${B_NORTH}`,
      token,
      403,
      "forbidden",
    ],
    ["a search with no patient", hospital, "Condition", token, 400, "required"],
    [
      "a malformed page",
      hospital,
      `Condition?patient=${A_NORTH}&_page=zz`,
      token,
      400,
      "invalid",
    ],
    [
      "another patient's record",
      hospital,
      "Condition/cond-3",
      token,
      404,
      "not-found",
    ],
    ["an unknown id", hospital, "Condition/nope", token, 404, "not-found"],
    [
      "another patient's version",
      hospital,
      "Condition/cond-3/_history/1",
      token,
      404,
      "not-found",
    ],
    [
      "another patient's history",
      hospital,
      "Condition/cond-3/_history",
      token,
      404,
      "not-found",
    ],
    [
      "a type's history",
      hospital,
      "Condition/_history",
      token,
      404,
      "not-supported",
      "A history is read for one record, as <type>/<id>/_history.",
    ],
    [
      "a search the scopes do not cover",
      hospital,
      `Condition?patient=${A_NORTH}`,
      observations,
      403,
      "forbidden",
      "The token's scopes do not cover a search of Condition.",
    ],
    [
      "a read with no scope",
      hospital,
      `Patient/${A_NORTH}`,
      unscoped,
      403,
      "forbidden",
      "The token's scopes do not cover a read of Patient.",
    ],
    ...notReading.map(([scope, bearer]): FhirRow => [
      `a read under ${scope}`,
      hospital,
      "Observation/lab-1",
      bearer,
      403,
      "forbidden",
      "The token's scopes do not cover a read of Observation.",
    ]),
    [
      "a type not served",
      hospital,
      `DocumentReference?patient=${A_NORTH}`,
      token,
      404,
      "not-found",
    ],
    [
      "a Patient search",
      hospital,
      `Patient?patient=${A_NORTH}`,
      token,
      404,
      "not-found",
    ],
  ];
  for (const [name, at, path, bearer, status, issue, said] of fhirRows) {
    const response = await get(at, `${NORTH}/${path}`, bearer);
    assert.equal(response.status, status, name);
    assert.equal(
      response.headers.get("Content-Type"),
      "application/fhir+json",
      name,
    );
    const body = await response.json();
    assert.equal(body.resourceType, "OperationOutcome", name);
    assert.equal(body.issue[0].code, issue, name);
    if (said !== undefined) assert.equal(body.issue[0].diagnostics, said, name);
    if (status === 401) {
      assert.match(
        response.headers.get("WWW-Authenticate") ?? "",
        /^Bearer/,
        name,
      );
    }
  }

  for (const [method, path, allowed] of [
    ["GET", "token", "POST"],
    ["POST", ".well-known/smart-configuration", "GET"],
  ] as const) {
    const response = await hospital(
      new Request(`${NORTH}/${path}`, { method }),
    );
    assert.equal(response.status, 405, path);
    assert.equal(response.headers.get("Allow"), allowed, path);
  }

  assert.throws(() => demoHospital({ ...north, autoApprove: "toString" }));
  const keyless = demoHospital({
    ...north,
    hospital: { ...north.hospital, key: "" },
  });
  await assert.rejects(
    get(keyless, `${NORTH}/Condition?patient=${A_NORTH}`, token),
  );
});

test("a patient file must hold the patient it is named for", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "demo-hospital-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await mkdir(join(folder, "patients"));
  await writeFile(
    join(folder, "hospital.json"),
    JSON.stringify(north.hospital),
  );
  await writeFile(
    join(folder, "patients", "rowan.json"),
    JSON.stringify(north.patients[A_NORTH]),
  );
  await assert.rejects(loadHospital(folder), /rowan/);
});

test("each error switch fails at its own step, as smart-launcher-v2 does, and an unknown one is refused", async () => {
  const hospital = demoHospital(north);
  const through = async (simulate: string) => {
    const response = await hospital(
      new Request(`${NORTH}/authorize`, {
        method: "POST",
        body: new URLSearchParams(
          `${authorizeQuery(NORTH)}&patient=${A_NORTH}&decision=allow&simulate_error=${simulate}`,
        ),
      }),
    );
    const back = redirected(response);
    if (!back.get("code")) return { back };
    const token = await exchange(
      hospital,
      NORTH,
      tokenForm(back.get("code") ?? ""),
    );
    const accessToken = (await token.clone().json()).access_token;
    return {
      back,
      token,
      record: accessToken
        ? await get(hospital, `${NORTH}/Patient/${A_NORTH}`, accessToken)
        : undefined,
    };
  };

  const none = await through("");
  assert.equal(none.token?.status, 200);
  assert.equal(none.record?.status, 200);

  const tokenRows: [string, number, string][] = [
    ["token_invalid_token", 401, "invalid_client"],
    ["token_invalid_scope", 401, "invalid_scope"],
  ];
  for (const [name, status, error] of tokenRows) {
    const { token, record } = await through(name);
    assert.equal(token?.status, status, name);
    assert.equal((await token!.json()).error, error, name);
    assert.equal(record, undefined, name);
  }

  const requestRows: [string, RegExp][] = [
    ["request_invalid_token", /^Bearer error="invalid_token"$/],
    [
      "request_expired_token",
      /^Bearer error="invalid_token", error_description="The access token expired"$/,
    ],
  ];
  for (const [name, challenge] of requestRows) {
    const { token, record } = await through(name);
    assert.equal(token?.status, 200, name);
    assert.equal(record?.status, 401, name);
    assert.match(
      record?.headers.get("WWW-Authenticate") ?? "",
      challenge,
      name,
    );
  }

  const unknown = await through("constructor");
  assert.equal(unknown.back.get("error"), "invalid_request");
  assert.equal(unknown.back.get("state"), "s-123");

  const signed = async (simulate: string) => {
    const code = redirected(
      await hospital(
        new Request(`${NORTH}/authorize`, {
          method: "POST",
          body: new URLSearchParams(
            `${authorizeQuery(NORTH)}&patient=${A_NORTH}&decision=allow&simulate_error=${simulate}`,
          ),
        }),
      ),
    ).get("code");
    return code ?? "";
  };
  const plainCode = await signed("");
  const posted = await exchange(
    hospital,
    NORTH,
    tokenForm(plainCode, { simulate_error: "token_invalid_token" }),
  );
  assert.equal(posted.status, 200, "a switch posted to the token request");
  const { access_token: plainToken } = await posted.json();
  assert.equal(
    (
      await get(
        hospital,
        `${NORTH}/Patient/${A_NORTH}?simulate_error=request_invalid_token`,
        plainToken,
      )
    ).status,
    200,
    "a switch queried on a record request",
  );
  const failing = await (
    await exchange(
      hospital,
      NORTH,
      tokenForm(await signed("request_invalid_token")),
    )
  ).json();
  assert.equal(failing.sim_error, "Invalid token");
  assert.equal(
    (
      await get(
        hospital,
        `${NORTH}/Patient/${A_NORTH}?simulate_error=`,
        failing.access_token,
      )
    ).status,
    401,
    "a query cannot clear a switch",
  );

  const page = await (
    await authorize(hospital, NORTH, {
      simulate_error: "request_expired_token",
    })
  ).text();
  assert.match(page, /<select id="simulate_error" name="simulate_error"/);
  for (const name of [
    "token_invalid_token",
    "token_invalid_scope",
    "request_invalid_token",
    "request_expired_token",
  ]) {
    assert.ok(page.includes(`<option value="${name}"`), name);
  }
  assert.match(page, /<option value="request_expired_token" selected>/);
});
