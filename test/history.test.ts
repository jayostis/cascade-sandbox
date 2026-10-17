import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type Bundle,
  type BundleEntry,
  type DemoHospitalOptions,
  demoHospital,
  HospitalDataError,
  type Resource,
  exportCollection,
  recordsAt,
} from "../src/index.js";
import { historyEntry } from "../src/history.js";
import { loadHospital } from "../src/node/index.js";
import { pkcePair, signInAs } from "../src/testing.js";

const { hospital } = await loadHospital("cascade-north");
const BASE = hospital.fhirBase;
const T = "2024-02-01T00:00:00Z";

function version(
  resource: Resource,
  versionId: string,
  at: string,
  method?: "POST" | "PUT",
): BundleEntry {
  const entry = historyEntry(resource, versionId, at);
  if (method === undefined || method === entry.request?.method) return entry;
  const created = method === "POST";
  return {
    ...entry,
    request: {
      method,
      url: created
        ? resource.resourceType
        : `${resource.resourceType}/${resource.id}`,
    },
    response: { ...entry.response!, status: created ? "201" : "200" },
  };
}

function deletion(record: string, versionId: string, at: string): BundleEntry {
  return {
    request: { method: "DELETE", url: record },
    response: { status: "204", lastModified: at, etag: `W/"${versionId}"` },
  };
}

const history = (...entry: BundleEntry[]): Bundle => ({
  resourceType: "Bundle",
  type: "history",
  entry,
});

const person = (id: string, family: string): Resource => ({
  resourceType: "Patient",
  id,
  name: [{ family, given: ["Ana"] }],
});
const med = (status: string): Resource => ({
  resourceType: "MedicationStatement",
  id: "m1",
  status,
});
const obs = (id: string): Resource => ({
  resourceType: "Observation",
  id,
  status: "final",
});

const PATIENTS: Record<string, Bundle> = {
  p1: history(
    version(med("completed"), "2", "2024-04-15T16:00:00Z"),
    version(person("p1", "Wick"), "1", "2020-01-01T00:00:00Z"),
    version(med("active"), "1", "2022-03-01T00:00:00Z"),
    version(obs("o1"), "1", "2023-01-01T00:00:00Z"),
    version(obs("o2"), "1", "2023-02-01T00:00:00Z"),
    deletion("Observation/o1", "2", "2024-05-01T00:00:00Z"),
    version(
      { resourceType: "Condition", id: "c1", onsetDateTime: "2023-06-01" },
      "1",
      "2025-01-01T00:00:00Z",
    ),
  ),
  p2: {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: person("p2", "Brook") },
      { resource: { resourceType: "Condition", id: "c2" } },
    ],
  },
  p3: history(
    version(person("p3", "Corr"), "1", "2025-01-01T00:00:00Z"),
    version(obs("o4"), "1", "2023-03-01T00:00:00Z"),
    deletion("Observation/o4", "2", "2023-04-01T00:00:00Z"),
    version(obs("o4"), "3", "2023-05-01T00:00:00Z", "POST"),
  ),
  p4: history(
    version(person("p4", "Dale"), "1", "2020-01-01T00:00:00Z"),
    deletion("Patient/p4", "2", "2023-01-01T00:00:00Z"),
  ),
};
const options = (asOf?: string): DemoHospitalOptions => ({
  hospital,
  patients: PATIENTS,
  ...(asOf === undefined ? {} : { asOf }),
});

const REDIRECT = "https://app.example/callback";
const { challenge } = pkcePair();

const signIn = () =>
  new URLSearchParams({
    response_type: "code",
    client_id: "test-app",
    redirect_uri: REDIRECT,
    scope: "launch/patient patient/*.rs",
    aud: BASE,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

async function tokenFor(
  patient: string,
  scope?: string,
  asOf?: string,
): Promise<string> {
  const { token } = await signInAs(options(asOf), patient, {
    ...(scope === undefined ? {} : { scope }),
  });
  return token;
}

const token = await tokenFor("p1");

function get(asOf: string | undefined, path: string, bearer = token) {
  return demoHospital(options(asOf))(
    new Request(`${BASE}/${path}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    }),
  );
}

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

test("the hospital answers each read, search, vread and history with its records as they stood at T", async () => {
  const BEFORE = "2021-01-01T00:00:00Z";
  const AFTER = "2024-06-01T00:00:00Z";
  const rows: [string, string | undefined, string, string][] = [
    [
      "a record before it was made",
      BEFORE,
      "MedicationStatement/m1",
      "404 not-found",
    ],
    [
      "a record between its versions",
      T,
      "MedicationStatement/m1",
      "200 MedicationStatement/m1@1",
    ],
    [
      "a record at its version's record time",
      "2024-04-15T16:00:00Z",
      "MedicationStatement/m1",
      "200 MedicationStatement/m1@2",
    ],
    [
      "a record after its last version",
      AFTER,
      "MedicationStatement/m1",
      "200 MedicationStatement/m1@2",
    ],
    [
      "a record with no T",
      undefined,
      "MedicationStatement/m1",
      "200 MedicationStatement/m1@2",
    ],
    ["a record deleted at T", AFTER, "Observation/o1", "410 deleted"],
    [
      "a search of what is present at T",
      T,
      "MedicationStatement?patient=p1",
      "200 searchset 1 [MedicationStatement/m1@1]",
    ],
    [
      "a search omits a record deleted at T",
      AFTER,
      "Observation?patient=p1",
      "200 searchset 1 [Observation/o2@1]",
    ],
    [
      "a search omits a record made after T",
      T,
      "Condition?patient=p1",
      "200 searchset 0 []",
    ],
    [
      "a vread of a version at T",
      T,
      "MedicationStatement/m1/_history/1",
      "200 MedicationStatement/m1@1",
    ],
    [
      "a vread of a version after T",
      T,
      "MedicationStatement/m1/_history/2",
      "404 not-found",
    ],
    [
      "a vread of an unknown version",
      undefined,
      "MedicationStatement/m1/_history/9",
      "404 not-found",
    ],
    [
      "a vread of a deletion",
      AFTER,
      "Observation/o1/_history/2",
      "410 deleted",
    ],
    [
      "a vread of another patient's record",
      undefined,
      "Condition/c2/_history/1",
      "404 not-found",
    ],
    [
      "a history, newest first",
      undefined,
      "MedicationStatement/m1/_history",
      "200 history 2 [MedicationStatement/m1@2, MedicationStatement/m1@1]",
    ],
    [
      "a history at T",
      T,
      "MedicationStatement/m1/_history",
      "200 history 1 [MedicationStatement/m1@1]",
    ],
    [
      "a history holding a deletion",
      undefined,
      "Observation/o1/_history",
      "200 history 2 [DELETE Observation/o1, Observation/o1@1]",
    ],
    [
      "a history since an instant",
      undefined,
      "MedicationStatement/m1/_history?_since=2024-01-01T00:00:00Z",
      "200 history 1 [MedicationStatement/m1@2]",
    ],
    [
      "a history since a date",
      undefined,
      "MedicationStatement/m1/_history?_since=2024-01-01",
      "400 invalid",
    ],
    [
      "a history since a time with no timezone",
      undefined,
      "MedicationStatement/m1/_history?_since=2024-01-01T00:00:00",
      "400 invalid",
    ],
    [
      "a history at a year in which both versions were current",
      undefined,
      "MedicationStatement/m1/_history?_at=2024",
      "200 history 2 [MedicationStatement/m1@2, MedicationStatement/m1@1]",
    ],
    [
      "a history at a year before the change",
      undefined,
      "MedicationStatement/m1/_history?_at=2023",
      "200 history 1 [MedicationStatement/m1@1]",
    ],
    [
      "a history at the instant of the change",
      undefined,
      "MedicationStatement/m1/_history?_at=2024-04-15T16:00:00Z",
      "200 history 1 [MedicationStatement/m1@2]",
    ],
    [
      "a history at the second before the change",
      undefined,
      "MedicationStatement/m1/_history?_at=2024-04-15T15:59:59Z",
      "200 history 1 [MedicationStatement/m1@1]",
    ],
    [
      "a history since the instant of the change",
      undefined,
      "MedicationStatement/m1/_history?_since=2024-04-15T16:00:00Z",
      "200 history 1 [MedicationStatement/m1@2]",
    ],
    [
      "a history at a year below 1000",
      undefined,
      "MedicationStatement/m1/_history?_at=0099",
      "400 invalid",
    ],
    [
      "a history at a day that is not one",
      undefined,
      "MedicationStatement/m1/_history?_at=2023-02-29",
      "400 invalid",
    ],
    [
      "a history at a day after the change",
      undefined,
      "MedicationStatement/m1/_history?_at=2024-04-16",
      "200 history 1 [MedicationStatement/m1@2]",
    ],
    [
      "a history with _at and _since",
      undefined,
      "MedicationStatement/m1/_history?_at=2024&_since=2024-04-01T00:00:00Z",
      "200 history 1 [MedicationStatement/m1@2]",
    ],
    [
      "a history at a month that is not one",
      undefined,
      "MedicationStatement/m1/_history?_at=2024-13",
      "400 invalid",
    ],
    [
      "a history of a record absent at T",
      T,
      "Condition/c1/_history",
      "404 not-found",
    ],
    ["a type's history", undefined, "Condition/_history", "404 not-supported"],
    ["the system's history", undefined, "_history", "404 not-supported"],
  ];
  for (const [name, asOf, path, expected] of rows) {
    assert.equal(await answered(await get(asOf, path)), expected, name);
  }

  const notSupported = await (await get(T, "Condition/_history")).json();
  assert.equal(
    notSupported.issue[0].diagnostics,
    "A history is read for one record, as <type>/<id>/_history.",
  );

  const first = await (await get(T, "Observation?patient=p1&_count=1")).json();
  assert.equal(first.total, 2);
  const next: string = first.link.find(
    (link: { relation: string }) => link.relation === "next",
  ).url;
  assert.ok(!next.includes("2024"), "T is never in a link");
  assert.equal(
    await answered(await get(T, next.slice(BASE.length + 1))),
    "200 searchset 2 [Observation/o2@1]",
  );
});

test("a patient not at the hospital at T is not listed, cannot be picked, and their token and auto-approval are refused", async () => {
  const pageAt = async (asOf?: string) =>
    (
      await demoHospital(options(asOf))(
        new Request(`${BASE}/authorize?${signIn()}`),
      )
    ).text();
  const page = await pageAt(T);
  assert.equal(
    /<p class="as-of">[^<]*<time datetime="([^"]*)">1 February 2024<\/time>/.exec(
      page,
    )?.[1],
    T,
  );
  assert.deepEqual(
    [...page.matchAll(/<label class="choice">[^>]*> ([^<]*)<\/label>/g)].map(
      ([, name]) => name,
    ),
    ["Brook, Ana", "Wick, Ana"],
  );
  const plain = await pageAt();
  assert.ok(!plain.includes('class="as-of"'));
  assert.ok(plain.includes("Corr, Ana"));

  const picked = await demoHospital(options(T))(
    new Request(`${BASE}/authorize`, {
      method: "POST",
      body: new URLSearchParams(`${signIn()}&patient=p3&decision=allow`),
    }),
  );
  assert.equal(
    new URL(picked.headers.get("Location") ?? "").searchParams.get("error"),
    "access_denied",
  );
  const theirs = await tokenFor("p3");
  assert.equal(
    (await get(T, "Patient/p3", theirs)).status,
    401,
    "a token naming a patient not there at T",
  );
  assert.throws(() => demoHospital({ ...options(T), autoApprove: "p3" }));

  const deleted = await tokenFor("p4", undefined, "2022-01-01T00:00:00Z");
  assert.equal(
    (await get("2022-01-01T00:00:00Z", "Patient/p4", deleted)).status,
    200,
  );
  assert.equal(
    (await get(T, "Patient/p4", deleted)).status,
    401,
    "a token naming a patient deleted before T",
  );
  assert.throws(() => demoHospital({ ...options(T), autoApprove: "p4" }));
});

test("a record made again after its deletion is written in its history as a new one", async () => {
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

test("a patient's export is a collection of each record's version at T, addressed as the hospital's own", () => {
  const held = { hospital, patients: PATIENTS };
  const at = (asOf?: string) => {
    const collection = exportCollection(held, "p1", asOf);
    assert.equal(collection.type, "collection");
    return Object.fromEntries(
      (collection.entry ?? []).map(({ fullUrl, resource }) => [
        fullUrl,
        resource?.resourceType === "MedicationStatement"
          ? resource.status
          : resource?.id,
      ]),
    );
  };
  assert.deepEqual(at(T), {
    [`${BASE}/Patient/p1`]: "p1",
    [`${BASE}/MedicationStatement/m1`]: "active",
    [`${BASE}/Observation/o1`]: "o1",
    [`${BASE}/Observation/o2`]: "o2",
  });
  assert.deepEqual(at(), {
    [`${BASE}/Patient/p1`]: "p1",
    [`${BASE}/MedicationStatement/m1`]: "completed",
    [`${BASE}/Observation/o2`]: "o2",
    [`${BASE}/Condition/c1`]: "c1",
  });
});

test("the hospital's scopes grant what SMART says each grants", async () => {
  const rows: [string, string][] = [
    ["patient/Observation.read", "Observation?patient=p1"],
    ["patient/Observation.read", "Observation/o2"],
    ["patient/*.*", "Observation/o2/_history"],
    ["patient/Observation.s", "Observation?patient=p1"],
  ];
  for (const [scope, path] of rows) {
    const response = await get(undefined, path, await tokenFor("p1", scope));
    assert.equal(response.status, 200, `${scope} ${path}`);
  }
});

test("bad data and a bad asOf are refused with a reason, by the hospital and by its loader", async (t) => {
  const c1 = (at: string, versionId = "1") =>
    version({ resourceType: "Condition", id: "c1" }, versionId, at);
  const p1 = version(person("p1", "Wick"), "1", "2020-01-01T00:00:00Z");
  const at = "2024-01-01T00:00:00Z";
  const later = "2024-02-01T00:00:00Z";
  type Editable = {
    request: Record<string, unknown>;
    response: Record<string, unknown>;
    resource: { meta: Record<string, unknown> };
  };
  const edited = (entry: BundleEntry, change: (copy: Editable) => void) => {
    const copy = structuredClone(entry);
    change(copy as unknown as Editable);
    return copy;
  };
  const rows: [string, Record<string, Bundle>, string, string?][] = [
    [
      "a searchset",
      { p1: { resourceType: "Bundle", type: "searchset", entry: [p1] } },
      "a patient file is a Bundle of type collection or history, not searchset",
    ],
    [
      "a collection holding a record twice",
      {
        p1: {
          resourceType: "Bundle",
          type: "collection",
          entry: [
            { resource: person("p1", "Wick") },
            { resource: person("p1", "Wick") },
          ],
        },
      },
      "a collection holds Patient/p1 twice",
    ],
    [
      "a PATCH",
      {
        p1: history(
          p1,
          edited(c1(at), (e) => (e.request.method = "PATCH")),
        ),
      },
      "a history entry has a request whose method is POST, PUT or DELETE",
    ],
    [
      "a PUT to another record",
      {
        p1: history(
          p1,
          edited(c1(at, "2"), (e) => (e.request.url = "Condition/c9")),
        ),
      },
      "request.url is not <type>/<id> of its resource",
    ],
    [
      "a record time that is a date",
      {
        p1: history(
          p1,
          edited(c1(at), (e) => (e.response.lastModified = "2024-01-01")),
        ),
      },
      "a history entry has a response whose lastModified is an instant",
    ],
    [
      "a version with no versionId",
      {
        p1: history(
          p1,
          edited(c1(at), (e) => delete e.resource.meta.versionId),
        ),
      },
      "Condition/c1 has a version with no meta.versionId",
    ],
    [
      "a record time on 31 February",
      {
        p1: history(
          p1,
          edited(
            c1(at),
            (e) => (e.response.lastModified = "2024-02-31T00:00:00Z"),
          ),
        ),
      },
      "a history entry has a response whose lastModified is an instant",
    ],
    [
      "a lastUpdated that is not the record time",
      {
        p1: history(
          p1,
          edited(c1(at), (e) => (e.resource.meta.lastUpdated = later)),
        ),
      },
      "Condition/c1 version 1: meta.lastUpdated is not the entry's response.lastModified",
    ],
    [
      "an etag of another version",
      {
        p1: history(
          p1,
          edited(c1(at), (e) => (e.response.etag = 'W/"2"')),
        ),
      },
      'Condition/c1 version 1: the etag is not W/"1"',
    ],
    [
      "a version id used twice",
      { p1: history(p1, c1(at), c1(later)) },
      "Condition/c1 reuses version 1",
    ],
    [
      "two versions at one time",
      { p1: history(p1, c1(at), c1(at, "2")) },
      `Condition/c1 has two versions at ${at}`,
    ],
    [
      "a deletion with no etag",
      {
        p1: history(
          p1,
          c1(at),
          edited(
            deletion("Condition/c1", "2", later),
            (e) => delete e.response.etag,
          ),
        ),
      },
      "Condition/c1 is deleted with a resource, or with no etag",
    ],
    [
      "a deletion with a resource",
      {
        p1: history(p1, c1(at), {
          ...deletion("Condition/c1", "2", later),
          resource: { resourceType: "Condition", id: "c1" },
        }),
      },
      "Condition/c1 is deleted with a resource, or with no etag",
    ],
    [
      "a deletion of a record that does not exist",
      { p1: history(p1, deletion("Condition/c1", "1", at)) },
      "Condition/c1 is deleted while it does not exist",
    ],
    [
      "a fullUrl at another base",
      {
        p1: history(p1, {
          ...c1(at),
          fullUrl: "https://elsewhere.example/fhir/Condition/c1",
        }),
      },
      `fullUrl https://elsewhere.example/fhir/Condition/c1 is not ${BASE}/Condition/c1`,
    ],
    [
      "a record in two files",
      {
        p1: history(p1, c1(at)),
        p2: history(version(person("p2", "Brook"), "1", at), c1(at)),
      },
      "Condition/c1 is in two patient files",
      "patients/p2.json",
    ],
    [
      "a file named for another patient",
      { p1: history(version(person("p9", "Wick"), "1", at)) },
      "holds Patient p9, not p1",
    ],
  ];
  const refused = (where: string, reason: string) => (error: unknown) =>
    error instanceof HospitalDataError &&
    error.where === where &&
    error.reason === reason;

  const folder = await mkdtemp(join(tmpdir(), "demo-hospital-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const roots = {
    hospitals: [join(folder, "hospitals")],
    people: [join(folder, "people")],
  };
  await mkdir(join(folder, "hospitals", "cascade-north"), { recursive: true });
  await writeFile(
    join(folder, "hospitals", "cascade-north", "hospital.json"),
    JSON.stringify(hospital),
  );
  for (const [name, patients, reason, where = "patients/p1.json"] of rows) {
    assert.throws(
      () => demoHospital({ hospital, patients }),
      refused(where, reason),
      name,
    );
    if (reason.startsWith("holds Patient")) continue;
    await rm(roots.people[0]!, { recursive: true, force: true });
    for (const [id, bundle] of Object.entries(patients)) {
      const source = join(roots.people[0]!, id, "sources", "cascade-north");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "fhir.json"), JSON.stringify(bundle));
      await writeFile(
        join(roots.people[0]!, id, "person.json"),
        JSON.stringify({
          id,
          name: { family: id === "p2" ? "Brook" : "Wick", given: ["Ana"] },
          birthDate: "1970-01-01",
          gender: "unknown",
        }),
      );
    }
    const patient = /^patients\/(.*)\.json$/.exec(where)![1];
    await assert.rejects(
      loadHospital("cascade-north", roots),
      refused(`${patient}/sources/cascade-north/fhir.json`, reason),
      name,
    );
  }

  for (const asOf of [
    "2024-02-01",
    "2024-02-01T00:00:00",
    "soon",
    "2024-02-30T00:00:00Z",
    "0099-02-01T00:00:00Z",
  ]) {
    const reason = "asOf is an instant, as 2024-02-01T00:00:00Z";
    assert.throws(
      () => demoHospital(options(asOf)),
      refused("asOf", reason),
      asOf,
    );
    assert.throws(() => recordsAt(PATIENTS.p1!, asOf), refused("asOf", reason));
    assert.throws(
      () => exportCollection({ hospital, patients: PATIENTS }, "p1", asOf),
      refused("asOf", reason),
      asOf,
    );
  }

  const exportRows: [string, string, string | undefined, string][] = [
    ["an unknown patient", "nobody", undefined, ""],
    ["a Patient made after T", "p3", T, ` at ${T}`],
    ["a Patient deleted, now", "p4", undefined, ""],
    ["a Patient deleted, at T", "p4", T, ` at ${T}`],
  ];
  for (const [name, patient, asOf, at] of exportRows) {
    assert.throws(
      () => exportCollection({ hospital, patients: PATIENTS }, patient, asOf),
      refused("patient", `${hospital.name} has no patient ${patient}${at}`),
      name,
    );
  }
});
