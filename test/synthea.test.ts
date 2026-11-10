import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { Bundle, Hospital, Resource } from "../src/index.js";
import {
  type MedicationRow,
  type PatientFile,
  fromSynthea,
  medicationRows,
  payerNames,
  providerDetails,
  syntheaId,
} from "../src/node/synthea.js";

const TYPES = [
  "Patient",
  "DocumentReference",
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
const NOTE =
  "Ann12 Lee34 is a 45 year-old woman. Vitamin B12 is low. Patient currently has Humana.";
const CLEANED =
  "Ann Lee is a 45 year-old woman. Vitamin B12 is low. Patient currently has Cascade Demo Health Plan B.";
const PAYERS = ["Aetna", "Humana"];
const base64 = (note: string) => Buffer.from(note).toString("base64");
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
    resourceType: "ExplanationOfBenefit",
    id: "eob-1",
    insurer: { display: "Humana" },
  },
  {
    resourceType: "ExplanationOfBenefit",
    id: "eob-2",
    insurer: { display: "Medicare" },
  },
  {
    resourceType: "DiagnosticReport",
    id: "split-panel",
    encounter: { reference: "urn:uuid:e1" },
    issued: "2020-01-01T10:30:00Z",
    result: [{ reference: "urn:uuid:lab" }],
  },
  {
    resourceType: "DiagnosticReport",
    id: "survey-panel",
    encounter: { reference: "urn:uuid:e3" },
    issued: "2022-03-01T10:30:00Z",
    result: [{ reference: "urn:uuid:survey" }],
  },
  {
    resourceType: "DiagnosticReport",
    id: "lab-panel",
    encounter: { reference: "urn:uuid:e3" },
    issued: "2022-03-01T10:30:00Z",
    result: [{ reference: "urn:uuid:lab" }],
  },
  {
    resourceType: "DiagnosticReport",
    id: "report",
    encounter: { reference: "urn:uuid:e1" },
    issued: "2020-01-01T10:55:00Z",
    performer: [
      {
        reference: "Practitioner?identifier=http://hl7.org/fhir/sid/us-npi|1",
        display: "Dr. Kim12 Ito34",
      },
    ],
    presentedForm: [{ contentType: "text/plain", data: base64(NOTE) }],
  },
  {
    resourceType: "DocumentReference",
    id: "note",
    status: "superseded",
    subject: { reference: "urn:uuid:p" },
    date: "2022-03-01T10:55:00Z",
    custodian: provider("other"),
    content: [
      { attachment: { contentType: "text/plain", data: base64(NOTE) } },
    ],
    context: { encounter: [{ reference: "urn:uuid:e3" }] },
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
const text = (form: unknown) =>
  Buffer.from(String((form as { data: string }).data), "base64").toString();

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

const ofType = (records: Resource[], type: string) =>
  records.filter((record) => record.resourceType === type);

/** The person's records with one more. */
const withRecord = (extra: Resource) =>
  ({
    ...bundle,
    entry: [...(bundle.entry ?? []), { resource: extra }],
  }) as Bundle;
const THIRD = hospital("cascade-west", "Cascade West Demo Hospital");

/**
 * `npm run synthea` turns one Synthea person into a patient file for each hospital that holds them: real providers'
 * names removed, ids made the hospital's own, and each record cut into versions by the dates Synthea gave.
 */
describe("Making the generated people from Synthea's output · fromSynthea(), medicationRows(), payerNames(), providerDetails()", () => {
  let files: PatientFile[];
  let north: Resource[];
  let south: Resource[];

  before(() => {
    files = fromSynthea(bundle, [NORTH, SOUTH], rows, PAYERS);
    [north, south] = files.map((file) =>
      (file.bundle.entry ?? []).map((entry) => entry.resource),
    ) as [Resource[], Resource[]];
  });

  describe("fromSynthea()", () => {
    it("returns a `history` file for each hospital", () => {
      assert.deepEqual(
        files.map((file) => file.bundle.type),
        ["history", "history"],
      );
    });

    it("drops a record of a type the hospital does not serve", () => {
      for (const records of [north, south])
        assert.deepEqual(ofType(records, "Claim"), []);
      assert.equal(ofType(north, "Procedure").length, 1);
      assert.equal(ofType(south, "Procedure").length, 0);
    });

    it("sends the provider with the most visits to the first hospital", () => {
      assert.equal(
        new Set(ofType(north, "Encounter").map((e) => e.id)).size,
        3,
      );
      assert.equal(ofType(south, "Encounter").length, 2);
    });

    it("drops an Observation that is neither a lab result nor a vital sign", () => {
      assert.equal(ofType(north, "Observation").length, 0);
      assert.deepEqual(
        ofType(south, "Observation").map(({ id }) => id),
        [syntheaId("cascade-south", "lab")],
      );
    });

    it("drops a DiagnosticReport with no text whose results are not served there", () => {
      assert.equal(ofType(north, "DiagnosticReport").length, 1);
      assert.deepEqual(
        ofType(south, "DiagnosticReport").map((report) => report.result),
        [[{ reference: `Observation/${ofType(south, "Observation")[0]!.id}` }]],
      );
    });

    it("keeps a report's text, cleaned of the digits in names and of the payer's name", () => {
      assert.deepEqual(
        ofType(north, "DiagnosticReport").map((report) => [
          report.performer,
          text((report.presentedForm as unknown[])[0]),
        ]),
        [[[{ type: "Practitioner", display: "Dr. Kim Ito" }], CLEANED]],
      );
    });

    it("keeps a note at the hospital of its visit, as current, with the hospital as custodian", () => {
      const [note, ...others] = ofType(south, "DocumentReference");
      assert.deepEqual(others, []);
      assert.equal(note!.status, "current");
      assert.deepEqual(note!.custodian, { display: SOUTH.hospital.name });
      assert.equal(
        text((note!.content as { attachment: unknown }[])[0]!.attachment),
        CLEANED,
      );
      assert.deepEqual(ofType(north, "DocumentReference"), []);
    });

    it("rewrites each reference to the hospital's own id for the record", () => {
      assert.deepEqual(
        ofType(south, "Observation").map((o) => o.encounter),
        [{ reference: `Encounter/${ofType(south, "Encounter")[0]!.id}` }],
      );
      const [northHtn] = ofType(north, "Condition");
      const [southHtn] = ofType(south, "Condition");
      assert.ok(northHtn && southHtn && northHtn.id !== southHtn.id);
    });

    it("removes a reference to a record the other hospital holds", () => {
      const [southHtn] = ofType(south, "Condition");
      assert.equal(southHtn!.encounter, undefined);
    });

    it("resolves every reference inside the file", () => {
      for (const records of [north, south]) {
        const names = new Set(records.map((r) => `${r.resourceType}/${r.id}`));
        const references = [
          ...JSON.stringify(records).matchAll(/"reference":"([^"]+)"/g),
        ];
        assert.ok(references.length > 0);
        for (const match of references)
          assert.ok(names.has(match[1]!), match[1]);
      }
    });

    it("leaves no `urn:uuid:`, real provider's name or Synthea URL in a file", () => {
      for (const records of [north, south]) {
        const json = JSON.stringify(records);
        assert.ok(!json.includes("urn:uuid:"));
        assert.ok(!json.includes(REAL));
        assert.ok(!json.includes("synthetichealth.github.io"));
      }
    });

    it("names the hospital as each visit's provider, with none of Synthea's identifiers", () => {
      for (const [records, { hospital }] of [
        [north, NORTH],
        [south, SOUTH],
      ] as const)
        for (const visit of ofType(records, "Encounter")) {
          assert.deepEqual(visit.serviceProvider, { display: hospital.name });
          assert.equal(visit.identifier, undefined);
        }
    });

    it("strips the digits from the Patient's names, and removes Synthea's own extensions", () => {
      const [patient] = ofType(south, "Patient");
      assert.deepEqual(patient!.name, [{ given: ["Ann"], family: "Lee" }]);
      assert.deepEqual(patient!.extension, [
        { url: "https://example.org/code", valueCode: "A1" },
        { url: MAIDEN_NAME, valueString: "Bea Lee" },
      ]);
    });

    it("gives the Patient the hospital's own id and medical record number", () => {
      const [patient] = ofType(south, "Patient");
      const [northPatient] = ofType(north, "Patient");
      assert.equal(patient!.id, files[1]!.id);
      const identifier = patient!.identifier as {
        system: string;
        value: string;
      }[];
      assert.equal(identifier.length, 1);
      assert.equal(
        identifier[0]!.system,
        "https://cascade-south.demo.invalid/mrn",
      );
      assert.match(identifier[0]!.value, /^SYN-[0-9A-F]{8}$/);
      assert.notEqual(
        identifier[0]!.value,
        (northPatient!.identifier as { value: string }[])[0]!.value,
      );
    });

    it("gives the Patient one version, at the earliest record time of its file", () => {
      const patientTimes = files.map((file) => {
        const entries = file.bundle.entry ?? [];
        const patients = entries.filter(
          (entry) => entry.resource?.resourceType === "Patient",
        );
        assert.equal(patients.length, 1);
        const earliest = Math.min(
          ...entries.map((entry) => Date.parse(entry.response!.lastModified!)),
        );
        assert.equal(
          Date.parse(patients[0]!.response!.lastModified!),
          earliest,
        );
        return patients[0]!.response!.lastModified;
      });
      assert.deepEqual(patientTimes, [
        instant("2019-05-01T00:00:00Z"),
        instant("2022-03-01T10:00:00Z"),
      ]);
    });
  });

  describe("when a record changes after it is first held", () => {
    let atNorth: ReturnType<typeof versionsIn>;
    let atSouth: ReturnType<typeof versionsIn>;

    before(() => {
      atNorth = versionsIn(files[0]!);
      atSouth = versionsIn(files[1]!);
    });

    it("gives a stopped order two versions: active when written, completed at its stop in `medications.csv`", () => {
      const stopped = atNorth("stopped");
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
    });

    it("ends an order at its renewal when that comes before the stop", () => {
      assert.deepEqual(
        atNorth("renewed").map((v) => [v.at, v.status]),
        [
          [instant("2020-01-01T10:00:00Z"), "active"],
          [instant("2020-07-01T00:00:00Z"), "completed"],
        ],
      );
    });

    it("gives an order stopped at its start one version", () => {
      assert.deepEqual(
        atNorth("once").map((v) => [v.at, v.status]),
        [[instant("2020-01-01T10:15:00Z"), "completed"]],
      );
    });

    it("gives a condition that abates later two versions", () => {
      assert.deepEqual(
        atNorth("cold").map((v) => [v.at, v.status, v.abated]),
        [
          [instant("2020-01-01T10:20:00Z"), "active", false],
          [instant("2023-01-01T00:00:00Z"), "resolved", true],
        ],
      );
    });

    it("gives a condition abated when it was recorded one version", () => {
      assert.deepEqual(
        atNorth("brief").map((v) => [v.at, v.status, v.abated]),
        [[instant("2020-01-01T10:45:00Z"), "resolved", true]],
      );
    });

    it("gives a record that never changes one version", () => {
      assert.deepEqual(
        atNorth("renewal").map((v) => [v.at, v.status]),
        [[instant("2020-07-01T00:00:00Z"), "active"]],
      );
      assert.equal(atNorth("htn").length, 1);
    });

    it("starts the second hospital's copy at its first visit that finds the record active", () => {
      assert.deepEqual(
        atSouth("cold").map((v) => [v.at, v.status, v.abated]),
        [
          [instant("2022-03-01T10:00:00Z"), "active", false],
          [instant("2023-01-01T00:00:00Z"), "resolved", true],
        ],
      );
      assert.deepEqual(
        atSouth("late").map((v) => [v.at, v.status]),
        [
          [instant("2022-03-01T10:00:00Z"), "active"],
          [instant("2023-06-01T00:00:00Z"), "completed"],
        ],
      );
      assert.deepEqual(
        atSouth("htn").map((v) => v.at),
        [instant("2022-03-01T10:00:00Z")],
      );
    });

    it("places an allergy with no visit on its own date at the first hospital", () => {
      assert.deepEqual(
        atNorth("nuts").map((v) => v.at),
        [instant("2019-05-01T00:00:00Z")],
      );
      assert.deepEqual(
        atSouth("nuts").map((v) => v.at),
        [instant("2022-03-01T10:00:00Z")],
      );
    });

    it("leaves out of the second hospital a record no visit there finds active", () => {
      for (const gone of ["flu", "brief", "once", "stopped", "renewed"])
        assert.deepEqual(
          atSouth(gone),
          [],
          `${gone} is active at no visit there`,
        );
    });
  });

  describe("medicationRows()", () => {
    it("returns a person's rows from the first six columns of `medications.csv`", () => {
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
    });

    it("throws for a file that does not begin with those columns", () => {
      assert.throws(
        () => medicationRows("CODE,START\n", "p"),
        /does not begin/,
      );
    });
  });

  describe("payerNames()", () => {
    it("returns each insurer but a public programme", () => {
      assert.deepEqual(payerNames([bundle]), ["Humana"]);
    });
  });

  describe("providerDetails()", () => {
    it("returns the names of organisations and locations, never a practitioner's", () => {
      assert.deepEqual(providerDetails(providers).names, [
        REAL,
        "Unseen Real Clinic",
      ]);
    });

    it("returns each address and phone number once, and no email address", () => {
      const { addresses, telecoms } = providerDetails(providers);
      assert.deepEqual(addresses, ["1 Real Street", "2 Real Avenue"]);
      assert.deepEqual(telecoms, ["555-0100"]);
    });
  });

  describe("when a person cannot be held faithfully", () => {
    for (const [title, input, hospitals, message] of [
      [
        "throws for three hospitals",
        bundle,
        [NORTH, SOUTH, THIRD],
        /at most two hospitals/,
      ],
      [
        "throws for a Medication the bundle does not hold",
        withRecord({
          resourceType: "MedicationRequest",
          id: "rx",
          status: "active",
          authoredOn: "2020-01-01T10:00:00Z",
          medicationReference: { reference: "urn:uuid:no-such-medication" },
        }),
        [NORTH],
        /MedicationRequest\/rx names a Medication not in the bundle/,
      ],
      [
        "throws for a completed order with no stop in `medications.csv`",
        withRecord(
          order(
            "no-stop",
            "completed",
            "2020-01-01T10:00:00Z",
            "555",
          ) as Resource,
        ),
        [NORTH, SOUTH],
        /MedicationRequest\/no-stop is completed, but medications\.csv gives it no stop/,
      ],
      [
        "throws for a resolved condition with no abatement date",
        withRecord({
          ...condition("no-abatement", "2020-01-01T10:00:00Z"),
          clinicalStatus: { coding: [{ code: "resolved" }] },
        } as Resource),
        [NORTH, SOUTH],
        /Condition\/no-abatement is resolved, but gives no abatementDateTime/,
      ],
      [
        "throws for a record with no date to be first held at",
        withRecord({ resourceType: "Procedure", id: "no-date" }),
        [NORTH, SOUTH],
        /Procedure\/no-date has no date to be first recorded at/,
      ],
    ] as const)
      it(title, () => {
        assert.throws(() => fromSynthea(input, [...hospitals], rows), {
          message,
        });
      });
  });
});
