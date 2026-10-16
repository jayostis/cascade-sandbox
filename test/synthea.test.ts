import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Hospital, Resource } from "../src/index.js";
import {
  type MedicationRow,
  type PatientFile,
  fromSynthea,
  medicationRows,
  providerDetails,
  syntheaId,
} from "../src/node/synthea.js";

const TYPES = [
  "Patient",
  "Condition",
  "Encounter",
  "Observation",
  "AllergyIntolerance",
  "MedicationRequest",
  "DiagnosticReport",
];
const hospital = (folder: string, name: string, types = TYPES) => ({
  folder,
  hospital: {
    name,
    fhirBase: `https://${folder}.demo.invalid/fhir`,
    types,
  } as Hospital,
});
const NORTH = hospital("cascade-north", "Cascade North Demo Hospital", [
  ...TYPES,
  "Procedure",
]);
const SOUTH = hospital("cascade-south", "Cascade South Demo Hospital");
const MAIDEN_NAME =
  "http://hl7.org/fhir/StructureDefinition/patient-mothersMaidenName";

const REAL = "Real Facility Medical Center";
const provider = (id: string) => ({
  reference: `Organization?identifier=https://github.com/synthetichealth/synthea|${id}`,
  display: REAL,
});
const category = (code: string) => [{ coding: [{ code }] }];
const encounter = (id: string, org: string, day: string) => ({
  resourceType: "Encounter",
  id,
  identifier: [
    { system: "https://github.com/synthetichealth/synthea", value: id },
  ],
  subject: { reference: "urn:uuid:p", display: "Mrs. Ann12 Lee34" },
  period: { start: `${day}T10:00:00Z`, end: `${day}T11:00:00Z` },
  serviceProvider: provider(org),
  location: [
    {
      location: {
        reference: `Location?identifier=https://github.com/synthetichealth/synthea|loc-${org}`,
        display: REAL,
      },
    },
  ],
});
const condition = (
  id: string,
  recordedDate: string,
  abatementDateTime?: string,
) => ({
  resourceType: "Condition",
  id,
  clinicalStatus: {
    coding: [{ code: abatementDateTime ? "resolved" : "active" }],
  },
  subject: { reference: "urn:uuid:p" },
  encounter: { reference: "urn:uuid:e1" },
  recordedDate,
  ...(abatementDateTime ? { abatementDateTime } : {}),
});
const order = (
  id: string,
  status: string,
  authoredOn: string,
  code: string,
  at = "e1",
) => ({
  resourceType: "MedicationRequest",
  id,
  status,
  subject: { reference: "urn:uuid:p" },
  encounter: { reference: `urn:uuid:${at}` },
  authoredOn,
  medicationCodeableConcept: { coding: [{ code }] },
});
const row = (
  start: string,
  stop: string,
  code: string,
  at = "e1",
): MedicationRow => ({ start, stop, encounter: at, code });

const resources = [
  {
    resourceType: "Patient",
    id: "p",
    name: [{ given: ["Ann12"], family: "Lee34" }],
    identifier: [{ value: "999-12-3456" }],
    extension: [
      { url: "https://example.org/code", valueCode: "A1" },
      { url: MAIDEN_NAME, valueString: "Bea56 Lee34" },
      {
        url: "http://synthetichealth.github.io/synthea/quality-adjusted-life-years",
        valueDecimal: 35.2,
      },
    ],
  },
  {
    resourceType: "Procedure",
    id: "proc",
    subject: { reference: "urn:uuid:p" },
    encounter: { reference: "urn:uuid:e1" },
    performedPeriod: {
      start: "2020-01-01T10:40:00Z",
      end: "2020-01-01T10:50:00Z",
    },
  },
  encounter("e1", "busy", "2020-01-01"),
  encounter("e2", "busy", "2021-06-01"),
  encounter("e3", "other", "2022-03-01"),
  encounter("e4", "other", "2022-09-01"),
  encounter("e5", "busy", "2021-09-01"),
  { resourceType: "Claim", id: "claim", patient: { reference: "urn:uuid:p" } },
  {
    resourceType: "DiagnosticReport",
    id: "report",
    encounter: { reference: "urn:uuid:e1" },
  },
  {
    resourceType: "Observation",
    id: "survey",
    category: category("survey"),
    encounter: { reference: "urn:uuid:e3" },
    issued: "2022-03-01T10:30:00Z",
  },
  {
    resourceType: "Observation",
    id: "lab",
    category: category("laboratory"),
    subject: { reference: "urn:uuid:p" },
    encounter: { reference: "urn:uuid:e3" },
    issued: "2022-03-01T10:30:00Z",
  },
  {
    resourceType: "AllergyIntolerance",
    id: "nuts",
    recordedDate: "2019-05-01T00:00:00Z",
  },
  condition("htn", "2020-01-01T10:30:00Z"),
  condition("flu", "2020-01-01T10:30:00Z", "2020-02-01T00:00:00Z"),
  condition("brief", "2020-01-01T10:45:00Z", "2020-01-01T10:45:00Z"),
  condition("cold", "2020-01-01T10:20:00Z", "2023-01-01T00:00:00Z"),
  { resourceType: "Medication", id: "m1", code: { coding: [{ code: "222" }] } },
  order("renewed", "completed", "2020-01-01T10:00:00Z", "111"),
  order("renewal", "active", "2020-07-01T00:00:00Z", "111", "e2"),
  {
    ...order("stopped", "completed", "2020-01-01T10:00:00Z", "222"),
    medicationCodeableConcept: undefined,
    medicationReference: { reference: "urn:uuid:m1" },
  },
  order("once", "completed", "2020-01-01T10:15:00Z", "333"),
  order("late", "completed", "2020-01-01T10:00:00Z", "444"),
] as Resource[];
const rows = [
  row("2020-01-01T10:00:00Z", "2021-01-01T00:00:00Z", "111"),
  row("2020-01-01T10:00:00Z", "2020-03-01T00:00:00Z", "222"),
  row("2020-01-01T10:00:00Z", "2020-04-01T00:00:00Z", "222", "e2"),
  row("2020-06-01T00:00:00Z", "2020-09-01T00:00:00Z", "222"),
  row("2020-01-01T10:15:00Z", "2020-01-01T10:15:00Z", "333"),
  row("2020-01-01T10:00:00Z", "2023-06-01T00:00:00Z", "444"),
];
const bundle = {
  resourceType: "Bundle",
  type: "transaction",
  entry: resources.map((resource) => ({ resource })),
} as Bundle;
const providers = [
  {
    resourceType: "Organization",
    id: "busy",
    identifier: [{ value: "busy" }],
    name: REAL,
    address: [{ line: ["1 Real Street"] }],
    telecom: [{ system: "phone", value: "555-0100" }],
  },
  {
    resourceType: "Location",
    id: "unseen",
    identifier: [{ value: "unseen" }],
    name: "Unseen Real Clinic",
  },
  {
    resourceType: "Practitioner",
    id: "dr",
    name: [{ family: "Heaney114" }],
    address: [{ line: ["2 Real Avenue"] }],
    telecom: [{ system: "email", value: "dr@example.com" }],
  },
] as Resource[];

const instant = (text: string) => new Date(text).toISOString();

/** What a file holds of one Synthea record: each version's time and state. */
function versionsIn(file: PatientFile) {
  return (record: string) =>
    (file.bundle.entry ?? [])
      .filter((entry) => entry.resource?.id === syntheaId(file.folder, record))
      .map((entry) => {
        const resource = entry.resource!;
        const clinical = resource.clinicalStatus as
          { coding: { code: string }[] } | undefined;
        return {
          at: entry.response!.lastModified,
          versionId: (resource.meta as { versionId: string }).versionId,
          method: entry.request!.method,
          url: entry.request!.url,
          etag: entry.response!.etag,
          status: String(resource.status ?? clinical?.coding[0]?.code),
          abated: "abatementDateTime" in resource,
        };
      });
}

test("a Synthea person becomes each hospital's own patient, trimmed and renamed", () => {
  const files = fromSynthea(bundle, [NORTH, SOUTH], rows);
  const [north, south] = files.map((file) =>
    (file.bundle.entry ?? []).map((entry) => entry.resource),
  ) as [Resource[], Resource[]];
  const of = (records: Resource[], type: string) =>
    records.filter((record) => record.resourceType === type);

  for (const file of files) {
    assert.equal(file.bundle.type, "history");
  }
  for (const records of [north, south]) {
    assert.deepEqual(of(records, "Claim"), []);
    assert.deepEqual(of(records, "DiagnosticReport"), []);
    const text = JSON.stringify(records);
    assert.ok(!text.includes("urn:uuid:") && !text.includes(REAL));
    assert.ok(!text.includes("synthetichealth.github.io"));
    const names = new Set(records.map((r) => `${r.resourceType}/${r.id}`));
    for (const match of text.matchAll(/"reference":"([^"]+)"/g)) {
      assert.ok(names.has(match[1]!), match[1]);
    }
  }
  assert.equal(new Set(of(north, "Encounter").map((e) => e.id)).size, 3);
  assert.equal(of(south, "Encounter").length, 2);
  assert.equal(of(north, "Observation").length, 0);
  assert.equal(of(north, "Procedure").length, 1);
  assert.equal(of(south, "Procedure").length, 0);
  assert.deepEqual(
    of(south, "Observation").map((o) => o.encounter),
    [{ reference: `Encounter/${of(south, "Encounter")[0]!.id}` }],
  );
  const [northHtn] = of(north, "Condition");
  const [southHtn] = of(south, "Condition");
  assert.ok(northHtn && southHtn && northHtn.id !== southHtn.id);
  assert.equal(southHtn.encounter, undefined);
  assert.deepEqual(of(north, "Encounter")[0]!.serviceProvider, {
    display: NORTH.hospital.name,
  });
  assert.equal(of(south, "Encounter")[0]!.identifier, undefined);
  const [patient] = of(south, "Patient");
  assert.deepEqual(patient!.name, [{ given: ["Ann"], family: "Lee" }]);
  assert.deepEqual(patient!.extension, [
    { url: "https://example.org/code", valueCode: "A1" },
    { url: MAIDEN_NAME, valueString: "Bea Lee" },
  ]);
  assert.equal(patient!.id, files[1]!.id);
  assert.deepEqual(patient!.identifier, [
    {
      system: "https://cascade-south.demo.invalid/mrn",
      value: `SYN-${files[1]!.id.slice(4, 12).toUpperCase()}`,
    },
  ]);
  assert.deepEqual(providerDetails(providers), {
    names: [REAL, "Unseen Real Clinic"],
    addresses: ["1 Real Street", "2 Real Avenue"],
    telecoms: ["555-0100"],
  });
});

test("a record is first held when its final content first holds, and a later change is a second version", () => {
  const [northFile, southFile] = fromSynthea(bundle, [NORTH, SOUTH], rows);
  const north = versionsIn(northFile!);
  const south = versionsIn(southFile!);

  const stopped = north("stopped");
  assert.deepEqual(
    stopped.map((v) => [v.at, v.status, v.versionId, v.method, v.etag]),
    [
      [instant("2020-01-01T10:00:00Z"), "active", "1", "POST", 'W/"1"'],
      [instant("2020-03-01T00:00:00Z"), "completed", "2", "PUT", 'W/"2"'],
    ],
  );
  assert.equal(stopped[0]!.url, "MedicationRequest");
  assert.equal(
    stopped[1]!.url,
    `MedicationRequest/${syntheaId("cascade-north", "stopped")}`,
  );
  assert.deepEqual(
    north("once").map((v) => [v.at, v.status]),
    [[instant("2020-01-01T10:15:00Z"), "completed"]],
    "an order stopped at its start has one version, as written",
  );
  assert.deepEqual(
    north("renewed").map((v) => [v.at, v.status]),
    [
      [instant("2020-01-01T10:00:00Z"), "active"],
      [instant("2020-07-01T00:00:00Z"), "completed"],
    ],
    "a renewal before the stop in medications.csv ends the order",
  );
  assert.deepEqual(
    north("renewal").map((v) => [v.at, v.status]),
    [[instant("2020-07-01T00:00:00Z"), "active"]],
  );

  assert.deepEqual(
    north("cold").map((v) => [v.at, v.status, v.abated]),
    [
      [instant("2020-01-01T10:20:00Z"), "active", false],
      [instant("2023-01-01T00:00:00Z"), "resolved", true],
    ],
  );
  assert.deepEqual(
    north("brief").map((v) => [v.at, v.status, v.abated]),
    [[instant("2020-01-01T10:45:00Z"), "resolved", true]],
    "a condition abated when it was recorded has one version, as written",
  );
  assert.equal(north("htn").length, 1);

  assert.deepEqual(
    south("cold").map((v) => [v.at, v.status, v.abated]),
    [
      [instant("2022-03-01T10:00:00Z"), "active", false],
      [instant("2023-01-01T00:00:00Z"), "resolved", true],
    ],
    "a copy starts at the first visit that finds it active and keeps the stop",
  );
  assert.deepEqual(
    south("late").map((v) => [v.at, v.status]),
    [
      [instant("2022-03-01T10:00:00Z"), "active"],
      [instant("2023-06-01T00:00:00Z"), "completed"],
    ],
  );
  assert.deepEqual(
    south("htn").map((v) => v.at),
    [instant("2022-03-01T10:00:00Z")],
  );
  assert.deepEqual(
    north("nuts").map((v) => v.at),
    [instant("2019-05-01T00:00:00Z")],
    "an allergy with no encounter is at the first hospital on its own date",
  );
  assert.deepEqual(
    south("nuts").map((v) => v.at),
    [instant("2022-03-01T10:00:00Z")],
  );
  for (const gone of ["flu", "brief", "once", "stopped", "renewed"]) {
    assert.deepEqual(south(gone), [], `${gone} is active at no visit there`);
  }
});

test("a Patient has one version, at the earliest record time of its file", () => {
  const files = fromSynthea(bundle, [NORTH, SOUTH], rows);
  const patientTimes = files.map((file) => {
    const entries = file.bundle.entry ?? [];
    const patients = entries.filter(
      (entry) => entry.resource?.resourceType === "Patient",
    );
    assert.equal(patients.length, 1);
    const earliest = Math.min(
      ...entries.map((entry) => Date.parse(entry.response!.lastModified!)),
    );
    assert.equal(Date.parse(patients[0]!.response!.lastModified!), earliest);
    return patients[0]!.response!.lastModified;
  });
  assert.deepEqual(patientTimes, [
    instant("2019-05-01T00:00:00Z"),
    instant("2022-03-01T10:00:00Z"),
  ]);
});

test("medications.csv gives a person's rows by their first six columns", () => {
  const csv = [
    "START,STOP,PATIENT,PAYER,ENCOUNTER,CODE,DESCRIPTION,BASE_COST",
    "2020-01-01T10:00:00Z,2021-01-01T00:00:00Z,p,pay,e1,111,Some Drug 5 MG,1.00",
    '2020-01-01T10:00:00Z,,q,pay,e9,999,"Other, Drug",2.00',
    "",
  ].join("\r\n");
  assert.deepEqual(medicationRows(csv, "p"), [
    {
      start: "2020-01-01T10:00:00Z",
      stop: "2021-01-01T00:00:00Z",
      encounter: "e1",
      code: "111",
    },
  ]);
  assert.throws(() => medicationRows("CODE,START\n", "p"), /does not begin/);
});

test("a Synthea person the hospitals cannot hold faithfully is refused", () => {
  const withRecord = (extra: Resource) =>
    ({
      ...bundle,
      entry: [...(bundle.entry ?? []), { resource: extra }],
    }) as Bundle;
  const unknownMedication = withRecord({
    resourceType: "MedicationRequest",
    id: "rx",
    status: "active",
    authoredOn: "2020-01-01T10:00:00Z",
    medicationReference: { reference: "urn:uuid:no-such-medication" },
  });
  const undatedStop = withRecord(
    order("no-stop", "completed", "2020-01-01T10:00:00Z", "555") as Resource,
  );
  const undatedAbatement = withRecord({
    ...condition("no-abatement", "2020-01-01T10:00:00Z"),
    clinicalStatus: { coding: [{ code: "resolved" }] },
  } as Resource);
  const undated = withRecord({ resourceType: "Procedure", id: "no-date" });
  const THIRD = hospital("cascade-west", "Cascade West Demo Hospital");
  for (const [why, input, hospitals, message] of [
    ["three hospitals", bundle, [NORTH, SOUTH, THIRD], /at most two hospitals/],
    [
      "a Medication not in the bundle",
      unknownMedication,
      [NORTH],
      /MedicationRequest\/rx names a Medication not in the bundle/,
    ],
    [
      "a completed order with no stop in medications.csv",
      undatedStop,
      [NORTH, SOUTH],
      /MedicationRequest\/no-stop is completed, but medications.csv gives it no stop/,
    ],
    [
      "a resolved condition with no abatement",
      undatedAbatement,
      [NORTH, SOUTH],
      /Condition\/no-abatement is resolved, but gives no abatementDateTime/,
    ],
    [
      "a record with no date to be first held at",
      undated,
      [NORTH, SOUTH],
      /Procedure\/no-date has no date to be first recorded at/,
    ],
  ] as const) {
    assert.throws(
      () => fromSynthea(input, [...hospitals], rows),
      { message },
      why,
    );
  }
});
