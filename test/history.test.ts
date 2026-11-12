import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  type DemoHospitalOptions,
  demoHospital,
  type Hospital,
  HospitalDataError,
  recordsAt,
  type Resource,
  versionsOf,
} from "../src/index.js";
import { loadHospital } from "../src/node/index.js";
import { pkcePair, signInAs } from "../src/testing.js";
import { PATIENTS, T } from "./fixtures.js";

const BEFORE = "2021-01-01T00:00:00Z";
const AFTER = "2024-06-01T00:00:00Z";
const CHANGE = "2024-04-15T16:00:00Z";
const M1 = "MedicationStatement/m1";
const M1_HISTORY = `${M1}/_history`;
const REDIRECT = "https://app.example/callback";

type Entry = {
  resource?: Resource & { meta?: { versionId?: string } };
  request?: { method: string; url: string };
};

/** An answer in short: `200 <type>/<id>@<version>`, a Bundle's entries in its order, or `<status> <issue code>`. */
async function answered(response: Response): Promise<string> {
  const body = await response.json();
  const of = ({ resource, request }: Entry) =>
    resource
      ? `${resource.resourceType}/${resource.id}@${resource.meta?.versionId ?? "-"}`
      : `${request?.method} ${request?.url}`;
  if (body.resourceType === "OperationOutcome") {
    return `${response.status} ${body.issue[0].code}`;
  }
  if (body.resourceType === "Bundle") {
    const entries = (body.entry as Entry[]).map(of).join(", ");
    return `${response.status} ${body.type} ${body.total} [${entries}]`;
  }
  return `${response.status} ${of({ resource: body })}`;
}

/** What a row asks: the date the hospital answers for, the path, and what it answers in short. */
type Example = [asOf: string | undefined, path: string, answer: string];
type Row = [title: string, ...examples: Example[]];

const NOT_AN_INSTANT = [
  "2024-02-01",
  "2024-02-01T00:00:00",
  "soon",
  "2024-02-30T00:00:00Z",
  "0099-02-01T00:00:00Z",
  "2021-12-31T23:59:60Z",
];

const NOT_AN_INSTANT_REFUSAL = {
  where: "asOf",
  reason: "asOf is an instant, as 2024-02-01T00:00:00Z",
};

const READ: Row[] = [
  [
    "answers 404 before the record's first version",
    [BEFORE, M1, "404 not-found"],
  ],
  [
    "serves the version current on the date",
    [T, M1, "200 MedicationStatement/m1@1"],
  ],
  [
    "serves a version from the instant it was recorded",
    [CHANGE, M1, "200 MedicationStatement/m1@2"],
  ],
  [
    "serves the latest version after the record's last change",
    [AFTER, M1, "200 MedicationStatement/m1@2"],
  ],
  [
    "serves the latest version when no date is given",
    [undefined, M1, "200 MedicationStatement/m1@2"],
  ],
  [
    "answers 410 for a record deleted by the date",
    [AFTER, "Observation/o1", "410 deleted"],
  ],
];

const SEARCH: Row[] = [
  [
    "returns each record's version current on the date",
    [
      T,
      "MedicationStatement?patient=p1",
      "200 searchset 1 [MedicationStatement/m1@1]",
    ],
  ],
  [
    "omits a record deleted by the date",
    [AFTER, "Observation?patient=p1", "200 searchset 1 [Observation/o2@1]"],
  ],
  [
    "omits a record made after the date",
    [T, "Condition?patient=p1", "200 searchset 0 []"],
  ],
];

const VREAD: Row[] = [
  [
    "serves a version recorded by the date",
    [T, `${M1_HISTORY}/1`, "200 MedicationStatement/m1@1"],
  ],
  [
    "answers 404 for a version recorded after the date",
    [T, `${M1_HISTORY}/2`, "404 not-found"],
  ],
  [
    "answers 404 for a version the record never had",
    [undefined, `${M1_HISTORY}/9`, "404 not-found"],
  ],
  [
    "answers 410 for the version that is a deletion",
    [AFTER, "Observation/o1/_history/2", "410 deleted"],
  ],
];

const BOTH_VERSIONS =
  "200 history 2 [MedicationStatement/m1@2, MedicationStatement/m1@1]";
const NEW_VERSION = "200 history 1 [MedicationStatement/m1@2]";
const OLD_VERSION = "200 history 1 [MedicationStatement/m1@1]";

const HISTORY_OF_A_RECORD: Row[] = [
  [
    "lists the record's versions newest first",
    [undefined, M1_HISTORY, BOTH_VERSIONS],
  ],
  [
    "lists only the versions recorded by the date",
    [T, M1_HISTORY, OLD_VERSION],
  ],
  [
    "lists a deletion as an entry with no resource",
    [
      undefined,
      "Observation/o1/_history",
      "200 history 2 [DELETE Observation/o1, Observation/o1@1]",
    ],
  ],
];

const HISTORY_ABSENT: Row[] = [
  [
    "answers 404 for a record that is not there on the date",
    [T, "Condition/c1/_history", "404 not-found"],
  ],
];

const HISTORY_OF_THE_HOSPITAL: Row[] = [
  [
    "answers 404 `not-supported` for the whole hospital's history",
    [undefined, "_history", "404 not-supported"],
  ],
];

const SINCE: Row[] = [
  [
    "returns the versions recorded at or after an instant",
    [undefined, `${M1_HISTORY}?_since=2024-01-01T00:00:00Z`, NEW_VERSION],
    [undefined, `${M1_HISTORY}?_since=${CHANGE}`, NEW_VERSION],
  ],
  [
    "answers 400 for a value that is not an instant",
    [undefined, `${M1_HISTORY}?_since=2024-01-01`, "400 invalid"],
    [undefined, `${M1_HISTORY}?_since=2024-01-01T00:00:00`, "400 invalid"],
  ],
];

const AT: Row[] = [
  [
    "returns every version current at some time in a year",
    [undefined, `${M1_HISTORY}?_at=2024`, BOTH_VERSIONS],
  ],
  [
    "returns the one version current through a year before the change",
    [undefined, `${M1_HISTORY}?_at=2023`, OLD_VERSION],
  ],
  [
    "returns the new version at the instant of the change",
    [undefined, `${M1_HISTORY}?_at=${CHANGE}`, NEW_VERSION],
  ],
  [
    "returns the old version one second before the change",
    [undefined, `${M1_HISTORY}?_at=2024-04-15T15:59:59Z`, OLD_VERSION],
  ],
  [
    "returns the version current on a day",
    [undefined, `${M1_HISTORY}?_at=2024-04-16`, NEW_VERSION],
  ],
  [
    "narrows the versions by `_since` too when both are given",
    [
      undefined,
      `${M1_HISTORY}?_at=2024&_since=2024-04-01T00:00:00Z`,
      NEW_VERSION,
    ],
  ],
  [
    "answers 400 for a date that does not exist",
    [undefined, `${M1_HISTORY}?_at=0099`, "400 invalid"],
    [undefined, `${M1_HISTORY}?_at=2023-02-29`, "400 invalid"],
    [undefined, `${M1_HISTORY}?_at=2024-13`, "400 invalid"],
  ],
];

/**
 * Given `asOf`, the world's date, a hospital answers with its records as they stood then: each record's latest version
 * recorded at or before it. A test pulls one patient at two dates and sees what changed between them.
 */
describe("Reading records as they stood on a date · asOf, recordsAt(), versionsOf()", () => {
  let hospital: Hospital;
  let base: string;
  let token: string;

  const options = (asOf?: string): DemoHospitalOptions => ({
    hospital,
    patients: PATIENTS,
    ...(asOf === undefined ? {} : { asOf }),
  });

  const get = (asOf: string | undefined, path: string, bearer = token) =>
    demoHospital(options(asOf))(
      new Request(`${base}/${path}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      }),
    );

  const tokenFor = async (patient: string, asOf?: string) =>
    (await signInAs(options(asOf), patient)).token;

  const signIn = () =>
    new URLSearchParams({
      response_type: "code",
      client_id: "test-app",
      redirect_uri: REDIRECT,
      scope: "launch/patient patient/*.rs",
      aud: base,
      code_challenge: pkcePair().challenge,
      code_challenge_method: "S256",
    });

  const pageAt = async (asOf?: string) =>
    (
      await demoHospital(options(asOf))(
        new Request(`${base}/authorize?${signIn()}`),
      )
    ).text();

  const searchedByOne = async () =>
    (await get(T, "Observation?patient=p1&_count=1")).json();

  const nextLink = (page: {
    link: { relation: string; url: string }[];
  }): string => page.link.find(({ relation }) => relation === "next")!.url;

  /** Registers one leaf for each row, which asks its examples in turn. */
  const leaves = (rows: Row[]) => {
    for (const [title, ...examples] of rows)
      it(title, async () => {
        for (const [asOf, path, answer] of examples)
          assert.equal(await answered(await get(asOf, path)), answer, path);
      });
  };

  before(async () => {
    ({ hospital } = await loadHospital("cascade-north"));
    base = hospital.fhirBase;
    token = await tokenFor("p1");
  });

  describe("when a record is read", () => {
    leaves(READ);
  });

  describe("when a patient's records are searched", () => {
    leaves(SEARCH);

    it("counts the records there on the date in `total`", async () => {
      assert.equal((await searchedByOne()).total, 2);
    });

    it("keeps the date out of the link to the next page", async () => {
      const link = new URL(nextLink(await searchedByOne()));
      assert.ok(!link.searchParams.has("asOf"));
      assert.ok(![...link.searchParams.values()].includes(T));
    });

    it("serves the next page as of the same date", async () => {
      const next = nextLink(await searchedByOne());
      assert.equal(
        await answered(await get(T, next.slice(base.length + 1))),
        "200 searchset 2 [Observation/o2@1]",
      );
    });
  });

  describe("when one version is read", () => {
    leaves(VREAD);
  });

  describe("when a record's history is read", () => {
    leaves(HISTORY_OF_A_RECORD);

    it("lists a record made again after its deletion as made, not updated", async () => {
      const body = await (
        await get(undefined, "Observation/o4/_history", await tokenFor("p3"))
      ).json();
      assert.deepEqual(
        body.entry.map(
          ({ request }: Entry) => `${request?.method} ${request?.url}`,
        ),
        ["POST Observation", "DELETE Observation/o4", "POST Observation"],
      );
    });

    leaves(HISTORY_ABSENT);

    it("answers 404 `not-supported` for a type's history, saying how a history is read", async () => {
      const response = await get(T, "Condition/_history");
      assert.equal(response.status, 404);
      const outcome = (await response.json()).issue[0];
      assert.equal(outcome.code, "not-supported");
      assert.equal(
        outcome.diagnostics,
        "A history is read for one record, as <type>/<id>/_history.",
      );
    });

    leaves(HISTORY_OF_THE_HOSPITAL);
  });

  describe("with `_since`", () => {
    leaves(SINCE);
  });

  describe("with `_at`", () => {
    leaves(AT);
  });

  describe("when the sign-in page is shown", () => {
    it("says the date the records stand at", async () => {
      const page = await pageAt(T);
      assert.equal(
        /<p class="as-of">[^<]*<time datetime="([^"]*)">1 February 2024<\/time>/.exec(
          page,
        )?.[1],
        T,
      );
    });

    it("lists only the patients at the hospital on the date", async () => {
      const page = await pageAt(T);
      assert.deepEqual(
        [
          ...page.matchAll(/<label class="choice">[^>]*> ([^<]*)<\/label>/g),
        ].map(([, name]) => name),
        ["Brook, Ana", "Wick, Ana"],
      );
    });

    it("shows no date and lists every patient when none is given", async () => {
      const page = await pageAt();
      assert.ok(!page.includes('class="as-of"'));
      assert.ok(page.includes("Corr, Ana"));
    });
  });

  describe("given a patient who is not at the hospital on the date", () => {
    it("redirects with `access_denied` when that patient is picked", async () => {
      const picked = await demoHospital(options(T))(
        new Request(`${base}/authorize`, {
          method: "POST",
          body: new URLSearchParams(`${signIn()}&patient=p3&decision=allow`),
        }),
      );
      assert.equal(
        new URL(picked.headers.get("Location") ?? "").searchParams.get("error"),
        "access_denied",
      );
    });

    it("answers 401 for a token naming a patient made after the date", async () => {
      const theirs = await tokenFor("p3");
      assert.equal((await get(T, "Patient/p3", theirs)).status, 401);
    });

    it("answers 401 for a token naming a patient deleted by the date", async () => {
      const earlier = "2022-01-01T00:00:00Z";
      const deleted = await tokenFor("p4", earlier);
      assert.equal(
        (await get(earlier, "Patient/p4", deleted)).status,
        200,
        "the token was good before the deletion",
      );
      assert.equal((await get(T, "Patient/p4", deleted)).status, 401);
    });

    it("throws for that patient as `autoApprove`", () => {
      for (const patient of ["p3", "p4"])
        assert.throws(
          () => demoHospital({ ...options(T), autoApprove: patient }),
          new RegExp(`has no patient ${patient} to auto-approve`),
        );
    });
  });

  describe("when `asOf` is not an instant", () => {
    const refusing = (error: unknown) =>
      error instanceof HospitalDataError &&
      error.where === NOT_AN_INSTANT_REFUSAL.where &&
      error.reason === NOT_AN_INSTANT_REFUSAL.reason;

    it("throws `HospitalDataError` from `demoHospital()`", () => {
      for (const asOf of NOT_AN_INSTANT)
        assert.throws(() => demoHospital(options(asOf)), refusing, asOf);
    });

    it("throws `HospitalDataError` from `recordsAt()`", () => {
      for (const asOf of NOT_AN_INSTANT)
        assert.throws(() => recordsAt(PATIENTS.p1!, asOf), refusing, asOf);
    });
  });

  describe("recordsAt(bundle, asOf)", () => {
    const named = (asOf?: string) =>
      recordsAt(PATIENTS.p1!, asOf).map((resource) =>
        resource.resourceType === "MedicationStatement"
          ? `${resource.resourceType}/${resource.id} ${resource.status}`
          : `${resource.resourceType}/${resource.id}`,
      );

    it("returns each record of a patient file as it stood at `asOf`", () => {
      assert.deepEqual(named(T).sort(), [
        "MedicationStatement/m1 active",
        "Observation/o1",
        "Observation/o2",
        "Patient/p1",
      ]);
      assert.deepEqual(named().sort(), [
        "Condition/c1",
        "MedicationStatement/m1 completed",
        "Observation/o2",
        "Patient/p1",
      ]);
    });
  });

  describe("versionsOf(bundle, where)", () => {
    it("returns each record's versions in order of record time", () => {
      const records = versionsOf(PATIENTS.p1!, "p1");
      assert.deepEqual(
        records.get(M1)?.map(({ versionId }) => versionId),
        ["1", "2"],
        "although the file lists version 2 first",
      );
      const observation = records.get("Observation/o1")!;
      assert.deepEqual(
        observation.map(({ versionId }) => versionId),
        ["1", "2"],
      );
      assert.equal(observation[1]?.resource, undefined, "a deletion");
    });
  });
});
