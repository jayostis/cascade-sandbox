import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, describe, it } from "node:test";
import {
  type DemoHospital,
  demoHospital,
  type Resource,
} from "../src/index.js";
import { loadHospital } from "../src/node/index.js";
import {
  answerSignIn,
  pkcePair,
  signInAs,
  signInThrough,
} from "../src/testing.js";

type Loaded = Awaited<ReturnType<typeof loadHospital>>;

let north: Loaded;
let south: Loaded;
let NORTH: string;
let SOUTH: string;
const A_NORTH = "pt-1001";
const B_NORTH = "pt-1002";
const A_SOUTH = "s-48213";

const CLIENT = "test-app";
const REDIRECT = "https://app.example/callback";
const { verifier: VERIFIER, challenge: CHALLENGE } = pkcePair();
const START = new Date("2026-01-01T00:00:00Z");
const clockAfter = (seconds: number) => () =>
  new Date(START.getTime() + seconds * 1000);

before(async () => {
  north = await loadHospital("cascade-north");
  south = await loadHospital("cascade-south");
  NORTH = north.hospital.fhirBase;
  SOUTH = south.hospital.fhirBase;
});

type Overrides = Record<string, string | undefined>;

function authorizeQuery(base: string, overrides: Overrides = {}): string {
  const query = new URLSearchParams();
  const parameters: Overrides = {
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
  overrides: Overrides = {},
): Promise<Response> {
  return hospital(
    new Request(`${base}/authorize?${authorizeQuery(base, overrides)}`),
  );
}

/** Posts the sign-in page's form, as the browser does, with the patient picked and the decision made. */
function answerPage(
  hospital: DemoHospital,
  base: string,
  patient: string,
  decision: string,
  overrides: Overrides = {},
): Promise<Response> {
  return hospital(
    new Request(`${base}/authorize`, {
      method: "POST",
      body: new URLSearchParams(
        `${authorizeQuery(base, overrides)}&patient=${patient}&decision=${decision}`,
      ),
    }),
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

const signIn = (data: Loaded, patient: string, scope?: string) =>
  signInAs(data, patient, {
    now: clockAfter(0),
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

/** What a page of a search answered, for a leaf to judge: nothing is asserted while the walk runs. */
type PageFacts = {
  status: number;
  contentType: string | null;
  type: string;
  matchesOnly: boolean;
  fullUrlsAtBase: boolean;
};

async function searchAll(
  hospital: DemoHospital,
  base: string,
  url: string,
  token: string,
): Promise<{ pages: string[][]; nexts: boolean[]; facts: PageFacts[] }> {
  const pages: string[][] = [];
  const nexts: boolean[] = [];
  const facts: PageFacts[] = [];
  let next: string | undefined = url;
  while (next) {
    const response = await get(hospital, next, token);
    const bundle = await response.json();
    const entries: {
      fullUrl: string;
      search: { mode: string };
      resource: Resource;
    }[] = bundle.entry ?? [];
    facts.push({
      status: response.status,
      contentType: response.headers.get("Content-Type"),
      type: bundle.type,
      matchesOnly: entries.every(({ search }) => search.mode === "match"),
      fullUrlsAtBase: entries.every(
        ({ fullUrl, resource }) =>
          fullUrl === `${base}/${resource.resourceType}/${resource.id}`,
      ),
    });
    pages.push(recordsOf(bundle));
    next = bundle.link?.find(
      (link: { relation: string }) => link.relation === "next",
    )?.url;
    nexts.push(next !== undefined);
  }
  return { pages, nexts, facts };
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
  const facts: PageFacts[] = [];
  for (const search of SEARCHES) {
    const [type, rest] = search.split("&");
    const query = `${base}/${type}?patient=${asked}${rest ? `&${rest}` : ""}`;
    const {
      pages,
      nexts,
      facts: seen,
    } = await searchAll(hospital, base, query, token);
    paging[search] = nexts;
    facts.push(...seen);
    for (const page of pages) {
      returned.push(...page);
      for (const record of page) searched.add(record);
    }
  }
  const read = await get(hospital, `${base}/Patient/${patient}`, token);
  const record = await read.json();
  returned.push(`Patient/${record.id}`);
  return { returned, searched, paging, facts };
}

const all = (data: Loaded) =>
  Object.values(data.patients).flatMap((bundle) => recordsOf(bundle));

/** An OperationOutcome answer as FHIR gives it: its status, challenge, first issue's code and diagnostics. */
async function outcome(response: Response) {
  assert.equal(response.headers.get("Content-Type"), "application/fhir+json");
  const body = await response.json();
  assert.equal(body.resourceType, "OperationOutcome");
  return {
    status: response.status,
    challenge: response.headers.get("WWW-Authenticate"),
    code: body.issue[0].code,
    diagnostics: body.issue[0].diagnostics,
  };
}

/**
 * `demoHospital()` makes a demo hospital: one function from a `Request` to a `Response` that answers as a hospital's
 * SMART on FHIR server does. An app signs a patient in to it as it would to a real one: discovery, the sign-in page,
 * then the token exchange.
 */
describe("Signing a patient in to a demo hospital · demoHospital()", () => {
  describe("demoHospital(options)", () => {
    it("throws for an `autoApprove` patient the hospital does not hold", () => {
      assert.throws(() => demoHospital({ ...north, autoApprove: "toString" }), {
        message: `${north.hospital.name} has no patient toString to auto-approve`,
      });
    });

    it("rejects a request when the hospital's `key` is empty", async () => {
      const { token } = await signIn(north, A_NORTH);
      const keyless = demoHospital({
        ...north,
        hospital: { ...north.hospital, key: "" },
      });
      await assert.rejects(
        get(keyless, `${NORTH}/Condition?patient=${A_NORTH}`, token),
      );
    });
  });

  describe("when a client reads discovery", () => {
    let discovery: Record<string, unknown>;
    before(async () => {
      discovery = await (
        await get(
          demoHospital(north),
          `${NORTH}/.well-known/smart-configuration`,
        )
      ).json();
    });

    it("names the hospital's FHIR base as the issuer", () => {
      assert.equal(discovery.issuer, NORTH);
    });

    it("offers S256 as the only PKCE method", () => {
      assert.deepEqual(discovery.code_challenge_methods_supported, ["S256"]);
    });

    it("places the sign-in page at `<FHIR base>/authorize`", () => {
      assert.equal(discovery.authorization_endpoint, `${NORTH}/authorize`);
    });
  });

  describe("with `autoApprove`", () => {
    let back: URLSearchParams;
    let exchanged: Response;
    let answer: Record<string, unknown>;
    before(async () => {
      const approving = demoHospital({ ...north, autoApprove: A_NORTH });
      back = redirected(await authorize(approving, NORTH));
      exchanged = await exchange(
        demoHospital(north),
        NORTH,
        tokenForm(back.get("code") ?? ""),
      );
      answer = await exchanged.json();
    });

    it("redirects to the redirect URI with a code and the client's `state`, showing no page", () => {
      assert.ok(back.get("code"));
      assert.equal(back.get("state"), "s-123");
    });

    it("issues a Bearer token for the approved patient, good for an hour", () => {
      assert.equal(answer.token_type, "Bearer");
      assert.equal(answer.expires_in, 3600);
      assert.equal(answer.patient, A_NORTH);
    });

    it("exchanges a code that another instance of the hospital issued", () => {
      assert.equal(exchanged.status, 200);
      assert.equal(typeof answer.access_token, "string");
    });
  });

  describe("when the sign-in page is shown", () => {
    let hospital: DemoHospital;
    let scoped: string;
    let plain: string;
    before(async () => {
      hospital = demoHospital(north);
      scoped = await (
        await authorize(hospital, NORTH, {
          scope: "launch/patient patient/*.rs patient/Observation.read openid",
        })
      ).text();
      plain = await (await authorize(hospital, NORTH)).text();
    });

    const preselected = async (hint?: string) => {
      const page = await (
        await authorize(hospital, NORTH, { login_hint: hint })
      ).text();
      return [...page.matchAll(/<input [^>]*checked[^>]*> ([^<]*)</g)].map(
        ([, name]) => name,
      );
    };

    it("lists every patient of the hospital, family name first, in order of family name", () => {
      const listed = [
        ...scoped.matchAll(/<label class="choice">[^>]*> ([^<]*)<\/label>/g),
      ].map(([, name]) => name ?? "");
      assert.equal(listed.length, Object.keys(north.patients).length);
      const byFamily = [...listed].sort((a, b) => {
        const [x, y] = [a, b].map((name) => name.split(", "));
        return (
          (x?.[0] ?? "").localeCompare(y?.[0] ?? "") ||
          (x?.[1] ?? "").localeCompare(y?.[1] ?? "")
        );
      });
      assert.deepEqual(
        listed,
        byFamily,
        "patients are not in family-name order",
      );
      assert.ok(listed.includes("Marsh, Rowan Ellery"));
      assert.ok(listed.includes("Fenn, Tobias"));
    });

    it("names the app by its client id", () => {
      assert.ok(scoped.includes(CLIENT));
    });

    it("says each scope the app asks for in words", () => {
      for (const words of [
        "Know which patient you are",
        "Read your whole health record",
        "Read your Observation records",
      ])
        assert.ok(scoped.includes(words), words);
    });

    it("lists a scope it has no words for once, as written", () => {
      const scopes =
        /<ul class="scopes">([\s\S]*?)<\/ul>/.exec(scoped)?.[1] ?? "";
      assert.equal(scopes.split("openid").length - 1, 1);
    });

    it("omits the list of scopes when the app asks for none", async () => {
      const unscoped = await (
        await authorize(hospital, NORTH, { scope: undefined })
      ).text();
      assert.ok(!unscoped.includes("If you allow it"));
    });

    it("requires a patient to be picked before Allow", () => {
      const radios = plain.match(/<input [^>]*name="patient"[^>]*>/g) ?? [];
      assert.ok(
        radios.length > 0 &&
          radios.every((radio) => radio.includes(" required")),
        radios.join(),
      );
    });

    it("lets Cancel through with no patient picked", () => {
      assert.match(plain, /<button [^>]*value="cancel" formnovalidate>/);
    });

    it("preselects the patient whose person id is the `login_hint`", async () => {
      assert.deepEqual(await preselected("rowan-ellery-marsh"), [
        "Marsh, Rowan Ellery",
      ]);
    });

    it("preselects the patient whose name is the `login_hint`, in either order of words", async () => {
      assert.deepEqual(await preselected("Fenn Tobias"), ["Fenn, Tobias"]);
    });

    it("preselects no one for any other `login_hint`", async () => {
      for (const hint of [undefined, "", "hedda-at-north", "rowan-marsh"])
        assert.deepEqual(await preselected(hint), [], String(hint));
    });
  });

  describe("when the patient answers the page", () => {
    it("redirects with a code for the patient picked", async () => {
      const hospital = demoHospital(north);
      const allowed = redirected(
        await answerPage(hospital, NORTH, B_NORTH, "allow"),
      );
      const answer = await (
        await exchange(hospital, NORTH, tokenForm(allowed.get("code") ?? ""))
      ).json();
      assert.equal(answer.patient, B_NORTH);
    });

    it("redirects with `error=access_denied`, the `state` and no code when the patient cancels", async () => {
      const cancelled = redirected(
        await answerPage(demoHospital(north), NORTH, B_NORTH, "cancel"),
      );
      assert.equal(cancelled.get("error"), "access_denied");
      assert.equal(cancelled.get("state"), "s-123");
      assert.equal(cancelled.get("code"), null);
    });
  });

  describe("when the authorize request is wrong", () => {
    type Row = [string, () => Overrides, number, string];
    const rows: Row[] = [
      [
        "redirects with `invalid_request` for no `code_challenge`",
        () => ({ code_challenge: undefined }),
        302,
        "invalid_request",
      ],
      [
        "redirects with `invalid_request` for the `plain` challenge method",
        () => ({ code_challenge_method: "plain" }),
        302,
        "invalid_request",
      ],
      [
        "redirects with `invalid_request` for a challenge method it does not know",
        () => ({ code_challenge_method: "S512" }),
        302,
        "invalid_request",
      ],
      [
        "redirects with `invalid_request` for an `aud` that is another hospital's FHIR base",
        () => ({ aud: SOUTH }),
        302,
        "invalid_request",
      ],
      [
        "answers 400 with no redirect for no `redirect_uri`",
        () => ({ redirect_uri: undefined }),
        400,
        "",
      ],
      [
        "answers 400 with no redirect for no `client_id`",
        () => ({ client_id: undefined }),
        400,
        "",
      ],
      [
        "redirects with `access_denied` for a patient the hospital does not hold",
        () => ({ decision: "allow", patient: "constructor" }),
        302,
        "access_denied",
      ],
    ];
    for (const [title, overrides, status, error] of rows) {
      it(title, async () => {
        const hospital = demoHospital(north);
        const asked = overrides();
        const response =
          asked.decision === undefined
            ? await authorize(hospital, NORTH, asked)
            : await hospital(
                new Request(`${NORTH}/authorize`, {
                  method: "POST",
                  body: new URLSearchParams(authorizeQuery(NORTH, asked)),
                }),
              );
        assert.equal(response.status, status);
        if (status === 302) {
          const back = redirected(response);
          assert.equal(back.get("error"), error);
          assert.equal(back.get("state"), "s-123");
        }
      });
    }
  });

  describe("when the token request is wrong", () => {
    let code: string;
    before(async () => {
      ({ code } = await signIn(north, A_NORTH));
    });

    type Row = [
      string,
      number,
      (code: string) => Record<string, string>,
      string,
    ];
    const rows: Row[] = [
      [
        "answers 400 `invalid_grant` for a `code_verifier` that is not the challenge's",
        0,
        (code) => tokenForm(code, { code_verifier: "x".repeat(50) }),
        "invalid_grant",
      ],
      [
        "answers 400 `invalid_grant` for a code it did not issue",
        0,
        (code) => tokenForm(`${code}x`),
        "invalid_grant",
      ],
      [
        "answers 400 `invalid_grant` for a code older than five minutes",
        301,
        (code) => tokenForm(code),
        "invalid_grant",
      ],
      [
        "answers 400 `invalid_grant` for another `redirect_uri` than the code's",
        0,
        (code) =>
          tokenForm(code, { redirect_uri: "https://app.example/other" }),
        "invalid_grant",
      ],
      [
        "answers 400 `invalid_grant` for another `client_id` than the code's",
        0,
        (code) => tokenForm(code, { client_id: "other-app" }),
        "invalid_grant",
      ],
      [
        "answers 400 `invalid_request` for no `code_verifier`",
        0,
        (code) => tokenForm(code, { code_verifier: "" }),
        "invalid_request",
      ],
      [
        "answers 400 `invalid_request` for no `grant_type`",
        0,
        (code) => tokenForm(code, { grant_type: "" }),
        "invalid_request",
      ],
      [
        "answers 400 `unsupported_grant_type` for a grant that is not `authorization_code`",
        0,
        (code) => tokenForm(code, { grant_type: "refresh_token" }),
        "unsupported_grant_type",
      ],
    ];
    for (const [title, seconds, form, error] of rows) {
      it(title, async () => {
        const hospital = demoHospital({ ...north, now: clockAfter(seconds) });
        const response = await exchange(hospital, NORTH, form(code));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, error);
      });
    }
  });

  describe("when a request uses the wrong method", () => {
    const rows: [string, string, string, string][] = [
      [
        "answers 405 with `Allow: POST` for a GET of the token endpoint",
        "GET",
        "token",
        "POST",
      ],
      [
        "answers 405 with `Allow: GET` for a POST to discovery",
        "POST",
        ".well-known/smart-configuration",
        "GET",
      ],
    ];
    for (const [title, method, path, allowed] of rows) {
      it(title, async () => {
        const response = await demoHospital(north)(
          new Request(`${NORTH}/${path}`, { method }),
        );
        assert.equal(response.status, 405);
        assert.equal(response.headers.get("Allow"), allowed);
      });
    }
  });
});

/**
 * With a token, a client searches a patient's records one type at a time, a page at a time, or reads one by its id.
 * The hospital serves only the token's patient, and only what the token's scopes cover.
 */
describe("Reading a patient's records from a demo hospital · demoHospital()", () => {
  describe("when a client searches a patient's records", () => {
    let hospital: DemoHospital;
    let token: string;
    let pulled: Awaited<ReturnType<typeof pullEverything>>;
    let hidden: string;
    let hiddenStatus: number;
    before(async () => {
      ({ hospital, token } = await signIn(north, A_NORTH));
      pulled = await pullEverything(hospital, NORTH, A_NORTH, token);
      const [leftOut] = north.hospital.hiddenFromSearch;
      const read = await get(hospital, `${NORTH}/${leftOut}`, token);
      hiddenStatus = read.status;
      const record = await read.json();
      hidden = `${record.resourceType}/${record.id}`;
    });

    it("returns every record of the patient across its searches and the read of the Patient", () => {
      assert.deepEqual(
        [...pulled.returned, hidden].sort(),
        recordsOf(north.patients[A_NORTH] ?? {}).sort(),
      );
    });

    it("returns no record of another patient or of another hospital", () => {
      const elsewhere = [
        ...recordsOf(north.patients[B_NORTH] ?? {}),
        ...all(south),
      ];
      assert.ok(pulled.returned.length > 0);
      assert.ok(pulled.returned.every((record) => !elsewhere.includes(record)));
    });

    it("answers each page as a `searchset` Bundle whose every `fullUrl` is at the FHIR base", () => {
      assert.ok(pulled.facts.length > SEARCHES.length, "a search paged");
      for (const page of pulled.facts) {
        assert.equal(page.status, 200);
        assert.equal(page.contentType, "application/fhir+json");
        assert.equal(page.type, "searchset");
        assert.ok(page.matchesOnly, "every entry is a match");
        assert.ok(page.fullUrlsAtBase, "every fullUrl is at the FHIR base");
      }
    });

    it("pages a search by the hospital's `pageSize`, each page linking the next", () => {
      assert.deepEqual(pulled.paging["Observation&category=laboratory"], [
        true,
        false,
      ]);
    });

    it("omits a record the hospital lists in `hiddenFromSearch`", () => {
      const [leftOut] = north.hospital.hiddenFromSearch;
      assert.ok(leftOut);
      assert.ok(!pulled.searched.has(leftOut));
    });

    it("serves a record hidden from search when it is read by its id", () => {
      assert.equal(hiddenStatus, 200);
      assert.equal(hidden, north.hospital.hiddenFromSearch[0]);
    });

    it("takes `category` as a code, as `system|code`, or as a list joined by commas", async () => {
      const total = async (category: string) => {
        const query = new URLSearchParams({ patient: A_NORTH, category });
        const response = await get(
          hospital,
          `${NORTH}/Observation?${query}`,
          token,
        );
        return (await response.json()).total;
      };
      const labs = await total("laboratory");
      assert.ok(labs > 0);
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

    it("takes `patient` as an id or as `Patient/<id>`", async () => {
      const { hospital: there, token: bearer } = await signIn(south, A_SOUTH);
      const { returned } = await pullEverything(
        there,
        SOUTH,
        A_SOUTH,
        bearer,
        `Patient/${A_SOUTH}`,
      );
      assert.deepEqual(
        [...returned].sort(),
        recordsOf(south.patients[A_SOUTH] ?? {}).sort(),
      );
    });

    it("names `patient` as a search parameter of every type it searches, in `metadata`", async () => {
      const { rest } = await (await get(hospital, `${NORTH}/metadata`)).json();
      const searched = rest[0].resource.filter(
        (one: { interaction: { code: string }[] }) =>
          one.interaction.some(({ code }) => code === "search-type"),
      );
      assert.ok(searched.length > 0);
      for (const each of searched)
        assert.ok(
          each.searchParam.some(
            (param: { name: string }) => param.name === "patient",
          ),
          each.type,
        );
    });
  });

  describe("with two hospitals", () => {
    it("serves a person at each hospital as that hospital's own patient", async () => {
      const there = await signIn(south, A_SOUTH);
      const { returned } = await pullEverything(
        there.hospital,
        SOUTH,
        A_SOUTH,
        there.token,
      );
      assert.deepEqual(
        [...returned].sort(),
        recordsOf(south.patients[A_SOUTH] ?? {}).sort(),
      );
      const here = await signIn(north, A_NORTH);
      const read = await get(
        here.hospital,
        `${NORTH}/Patient/${A_NORTH}`,
        here.token,
      );
      assert.equal((await read.json()).id, A_NORTH);
    });

    it("answers 401 for a token another hospital issued", async () => {
      const { hospital } = await signIn(south, A_SOUTH);
      const fromNorth = await signIn(north, A_NORTH);
      const refused = await get(
        hospital,
        `${SOUTH}/Condition?patient=${A_SOUTH}`,
        fromNorth.token,
      );
      assert.equal(refused.status, 401);
    });
  });

  describe("given a token's scopes", () => {
    const grants: [string, string, string[]][] = [
      [
        "serves a search and a read under `patient/Observation.read`",
        "patient/Observation.read",
        [`Observation?patient=${A_NORTH}`, "Observation/lab-1"],
      ],
      [
        "serves a record's history under `patient/*.*`",
        "patient/*.*",
        ["Observation/lab-1/_history"],
      ],
      [
        "serves a search under `patient/Observation.s`",
        "patient/Observation.s",
        [`Observation?patient=${A_NORTH}`],
      ],
    ];
    for (const [title, scope, paths] of grants) {
      it(title, async () => {
        const { hospital, token } = await signIn(north, A_NORTH, scope);
        for (const path of paths) {
          const response = await get(hospital, `${NORTH}/${path}`, token);
          assert.equal(response.status, 200, `${scope} ${path}`);
        }
      });
    }

    const refusals: [string, string[], string, string][] = [
      [
        "answers 403 for a search of a type the scopes do not cover",
        ["patient/Observation.read"],
        `Condition?patient=${A_NORTH}`,
        "The token's scopes do not cover a search of Condition.",
      ],
      [
        "answers 403 for a read under no scope",
        [""],
        `Patient/${A_NORTH}`,
        "The token's scopes do not cover a read of Patient.",
      ],
      [
        "answers 403 for a read under a scope that grants no read",
        [
          "patient/*.write",
          "patient/Observation.s",
          "patient/Observation.rs?category=laboratory",
          "user/*.read",
        ],
        "Observation/lab-1",
        "The token's scopes do not cover a read of Observation.",
      ],
    ];
    for (const [title, scopes, path, said] of refusals) {
      it(title, async () => {
        for (const scope of scopes) {
          const { hospital, token } = await signIn(north, A_NORTH, scope);
          const refused = await outcome(
            await get(hospital, `${NORTH}/${path}`, token),
          );
          assert.equal(refused.status, 403, scope);
          assert.equal(refused.code, "forbidden", scope);
          assert.equal(refused.diagnostics, said, scope);
        }
      });
    }
  });

  describe("when a request is refused", () => {
    let code: string;
    let token: string;
    before(async () => {
      ({ code, token } = await signIn(north, A_NORTH));
    });

    type Row = [
      string,
      number,
      string,
      (() => string) | undefined,
      number,
      string,
    ];
    const bearers = {
      none: undefined,
      malformed: () => "not-a-token",
      code: () => code,
      token: () => token,
    };
    const rows: Row[] = [
      [
        "answers 401 `login` with a `Bearer` challenge for no token",
        0,
        `Condition?patient=${A_NORTH}`,
        bearers.none,
        401,
        "login",
      ],
      [
        "answers 401 `login` with a `Bearer` challenge for a token it cannot read",
        0,
        `Condition?patient=${A_NORTH}`,
        bearers.malformed,
        401,
        "login",
      ],
      [
        "answers 401 `login` with a `Bearer` challenge for a code sent as a token",
        0,
        `Condition?patient=${A_NORTH}`,
        bearers.code,
        401,
        "login",
      ],
      [
        "answers 401 `login` with a `Bearer` challenge for a token older than an hour",
        3601,
        `Condition?patient=${A_NORTH}`,
        bearers.token,
        401,
        "login",
      ],
      [
        "answers 403 `forbidden` for a search of another patient",
        0,
        `Condition?patient=${B_NORTH}`,
        bearers.token,
        403,
        "forbidden",
      ],
      [
        "answers 400 `required` for a search with no `patient`",
        0,
        "Condition",
        bearers.token,
        400,
        "required",
      ],
      [
        "answers 400 `invalid` for a `_page` it cannot read",
        0,
        `Condition?patient=${A_NORTH}&_page=zz`,
        bearers.token,
        400,
        "invalid",
      ],
      [
        "answers 404 `not-found` for another patient's record",
        0,
        "Condition/cond-3",
        bearers.token,
        404,
        "not-found",
      ],
      [
        "answers 404 `not-found` for an id it does not hold",
        0,
        "Condition/nope",
        bearers.token,
        404,
        "not-found",
      ],
      [
        "answers 404 `not-found` for a version of another patient's record",
        0,
        "Condition/cond-3/_history/1",
        bearers.token,
        404,
        "not-found",
      ],
      [
        "answers 404 `not-found` for the history of another patient's record",
        0,
        "Condition/cond-3/_history",
        bearers.token,
        404,
        "not-found",
      ],
      [
        "answers 404 `not-found` for a type the hospital does not serve",
        0,
        `CarePlan?patient=${A_NORTH}`,
        bearers.token,
        404,
        "not-found",
      ],
      [
        "answers 404 `not-found` for a search of Patient",
        0,
        `Patient?patient=${A_NORTH}`,
        bearers.token,
        404,
        "not-found",
      ],
    ];
    for (const [title, seconds, path, bearer, status, issue] of rows) {
      it(title, async () => {
        const hospital = demoHospital({ ...north, now: clockAfter(seconds) });
        const refused = await outcome(
          await get(hospital, `${NORTH}/${path}`, bearer?.()),
        );
        assert.equal(refused.status, status);
        assert.equal(refused.code, issue);
        if (status === 401) assert.match(refused.challenge ?? "", /^Bearer/);
      });
    }
  });
});

/**
 * An app tests its error handling by adding `simulate_error=<name>` to the authorize request, or by picking a failure
 * on the sign-in page. Each name fails one later step the way the launcher fails it.
 */
describe("Making a sign-in or a request fail on purpose · simulate_error", () => {
  type Through = {
    back: URLSearchParams;
    exchanged?: { status: number; body: Record<string, unknown> };
    record?: { status: number; challenge: string };
  };

  /** Signs in as A at North with `simulate_error` posted on the sign-in page, then exchanges and reads Patient. */
  const through = async (simulate: string): Promise<Through> => {
    const hospital = demoHospital(north);
    const back = redirected(
      await answerPage(hospital, NORTH, A_NORTH, "allow", {
        simulate_error: simulate,
      }),
    );
    if (!back.get("code")) return { back };
    const response = await exchange(
      hospital,
      NORTH,
      tokenForm(back.get("code") ?? ""),
    );
    const status = response.status;
    const body = await response.json();
    if (typeof body.access_token !== "string")
      return { back, exchanged: { status, body } };
    const read = await get(
      hospital,
      `${NORTH}/Patient/${A_NORTH}`,
      body.access_token,
    );
    return {
      back,
      exchanged: { status, body },
      record: {
        status: read.status,
        challenge: read.headers.get("WWW-Authenticate") ?? "",
      },
    };
  };

  /** A code from the sign-in page, with `simulate_error` posted there. */
  const codeFor = async (hospital: DemoHospital, simulate: string) =>
    redirected(
      await answerPage(hospital, NORTH, A_NORTH, "allow", {
        simulate_error: simulate,
      }),
    ).get("code") ?? "";

  describe("given no `simulate_error`", () => {
    let result: Through;
    before(async () => {
      result = await through("");
    });

    it("issues a token that reads the patient's record", () => {
      assert.equal(result.exchanged?.status, 200);
      assert.equal(result.record?.status, 200);
    });
  });

  const tokenRows: [string, string, string][] = [
    [
      "token_invalid_token",
      "answers the token exchange 401 `invalid_client`",
      "invalid_client",
    ],
    [
      "token_invalid_scope",
      "answers the token exchange 401 `invalid_scope`",
      "invalid_scope",
    ],
  ];
  for (const [name, title, error] of tokenRows) {
    describe(`given \`${name}\``, () => {
      let result: Through;
      before(async () => {
        result = await through(name);
      });

      it(title, () => {
        assert.equal(result.exchanged?.status, 401);
        assert.equal(result.exchanged?.body.error, error);
        assert.equal(result.exchanged?.body.access_token, undefined);
        assert.equal(result.record, undefined);
      });
    });
  }

  describe("given `request_invalid_token`", () => {
    let result: Through;
    let accessToken: string;
    before(async () => {
      result = await through("request_invalid_token");
      accessToken = String(result.exchanged?.body.access_token);
    });

    it("issues a token that every record request answers 401 `invalid_token` for", () => {
      assert.equal(result.exchanged?.status, 200);
      assert.equal(result.record?.status, 401);
      assert.equal(result.record?.challenge, 'Bearer error="invalid_token"');
    });

    it("says `sim_error` beside the token it issues", () => {
      assert.equal(result.exchanged?.body.sim_error, "Invalid token");
    });

    it("keeps failing when a record request passes an empty `simulate_error`", async () => {
      const response = await get(
        demoHospital(north),
        `${NORTH}/Patient/${A_NORTH}?simulate_error=`,
        accessToken,
      );
      assert.equal(response.status, 401);
    });
  });

  describe("given `request_expired_token`", () => {
    let result: Through;
    before(async () => {
      result = await through("request_expired_token");
    });

    it('issues a token that every record request answers 401 "The access token expired" for', () => {
      assert.equal(result.exchanged?.status, 200);
      assert.equal(result.record?.status, 401);
      assert.equal(
        result.record?.challenge,
        'Bearer error="invalid_token", error_description="The access token expired"',
      );
    });
  });

  describe("given a name it does not know", () => {
    let result: Through;
    before(async () => {
      result = await through("constructor");
    });

    it("redirects with `invalid_request` and the client's `state`", () => {
      assert.equal(result.back.get("error"), "invalid_request");
      assert.equal(result.back.get("state"), "s-123");
    });
  });

  describe("with `simulate_error` on a later request", () => {
    it("ignores one posted to the token exchange", async () => {
      const hospital = demoHospital(north);
      const posted = await exchange(
        hospital,
        NORTH,
        tokenForm(await codeFor(hospital, ""), {
          simulate_error: "token_invalid_token",
        }),
      );
      assert.equal(posted.status, 200);
    });

    it("ignores one in a record request's query", async () => {
      const hospital = demoHospital(north);
      const { access_token: token } = await (
        await exchange(hospital, NORTH, tokenForm(await codeFor(hospital, "")))
      ).json();
      const response = await get(
        hospital,
        `${NORTH}/Patient/${A_NORTH}?simulate_error=request_invalid_token`,
        token,
      );
      assert.equal(response.status, 200);
    });
  });

  describe("when the sign-in page is shown", () => {
    let page: string;
    before(async () => {
      page = await (
        await authorize(demoHospital(north), NORTH, {
          simulate_error: "request_expired_token",
        })
      ).text();
    });

    it("offers the four failures in a list for app developers", () => {
      assert.match(
        page,
        /<summary>For app developers: simulate a failure<\/summary>/,
      );
      assert.doesNotMatch(page, /<label for="simulate_error"/);
      assert.match(
        page,
        /<select name="simulate_error" aria-label="Failure to simulate">/,
      );
      for (const name of [
        "token_invalid_token",
        "token_invalid_scope",
        "request_invalid_token",
        "request_expired_token",
      ])
        assert.ok(page.includes(`<option value="${name}"`), name);
    });

    it("preselects the failure the authorize request names", () => {
      assert.match(page, /<option value="request_expired_token" selected>/);
    });
  });
});

/**
 * What a test calls to get past the sign-in without writing the protocol out: `answerSignIn()` answers the sign-in
 * page as a patient, and `signInAs()` does the whole sign-in and returns the token.
 */
describe("Signing in from a test · signInAs(), signInThrough(), answerSignIn(), pkcePair()", () => {
  const through = (hospital: DemoHospital) =>
    ((input, init) =>
      hospital(new Request(input, init))) as typeof globalThis.fetch;

  describe("answerSignIn(fetch, authorizeUrl, patient, decision)", () => {
    it("returns the callback URL with a code when the patient allows", async () => {
      const url = `${NORTH}/authorize?${authorizeQuery(NORTH)}`;
      const allowed = await answerSignIn(
        through(demoHospital(north)),
        url,
        B_NORTH,
      );
      assert.ok(allowed.searchParams.get("code"));
    });

    it('returns the callback URL with `error=access_denied` and no code for `"cancel"`', async () => {
      const url = `${NORTH}/authorize?${authorizeQuery(NORTH)}`;
      const cancelled = await answerSignIn(
        through(demoHospital(north)),
        url,
        B_NORTH,
        "cancel",
      );
      assert.equal(cancelled.searchParams.get("error"), "access_denied");
      assert.equal(cancelled.searchParams.get("code"), null);
    });

    it("throws when the address gives no sign-in page", async () => {
      const url = `${NORTH}/authorize?${authorizeQuery(NORTH)}`;
      await assert.rejects(
        answerSignIn(
          async () => new Response("", { status: 404 }),
          url,
          B_NORTH,
        ),
        { message: `${NORTH}/authorize gave no sign-in page (404)` },
      );
    });
  });

  describe("signInAs(hospital, patient, options)", () => {
    it("returns a token for the patient, the spent code and the hospital it built", async () => {
      const signed = await signInAs(north, B_NORTH);
      assert.equal(typeof signed.code, "string");
      assert.ok(signed.code.length > 0);
      const read = await get(
        signed.hospital,
        `${NORTH}/Patient/${B_NORTH}`,
        signed.token,
      );
      assert.equal(read.status, 200);
      assert.equal((await read.json()).id, B_NORTH);
    });
  });

  describe("signInThrough(fetch, base, patient)", () => {
    it("returns a token signed in for through the `fetch`", async () => {
      const hospital = demoHospital(north);
      const signed = await signInThrough(through(hospital), NORTH, B_NORTH);
      assert.ok(signed.code.length > 0);
      const read = await get(
        hospital,
        `${NORTH}/Patient/${B_NORTH}`,
        signed.token,
      );
      assert.equal(read.status, 200);
      assert.equal((await read.json()).id, B_NORTH);
    });
  });

  describe("pkcePair()", () => {
    it("returns a verifier and the S256 challenge of it", () => {
      const first = pkcePair();
      assert.equal(
        first.challenge,
        createHash("sha256").update(first.verifier).digest("base64url"),
      );
      assert.notEqual(first.verifier, pkcePair().verifier);
    });
  });
});
