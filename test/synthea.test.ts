import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Hospital, Resource } from "../src/index.js";
import { fromSynthea, providerDetails } from "../src/node/synthea.js";

const TYPES = ["Patient", "Condition", "Encounter", "Observation"];
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
const encounter = (id: string, org: string) => ({
  resourceType: "Encounter",
  id,
  identifier: [
    { system: "https://github.com/synthetichealth/synthea", value: id },
  ],
  subject: { reference: "urn:uuid:p", display: "Mrs. Ann12 Lee34" },
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
const resources = [
  {
    resourceType: "Patient",
    id: "p",
    name: [{ given: ["Ann12"], family: "Lee34" }],
    identifier: [{ value: "999-12-3456" }],
    extension: [
      { url: "https://example.org/code", valueCode: "A1" },
      { url: MAIDEN_NAME, valueString: "Bea56 Lee34" },
    ],
  },
  {
    resourceType: "Procedure",
    id: "proc",
    subject: { reference: "urn:uuid:p" },
  },
  encounter("e1", "busy"),
  encounter("e2", "busy"),
  encounter("e3", "other"),
  { resourceType: "Claim", id: "claim", patient: { reference: "urn:uuid:p" } },
  {
    resourceType: "Observation",
    id: "survey",
    category: category("survey"),
    encounter: { reference: "urn:uuid:e3" },
  },
  {
    resourceType: "Observation",
    id: "lab",
    category: category("laboratory"),
    subject: { reference: "urn:uuid:p" },
    encounter: { reference: "urn:uuid:e3" },
  },
  {
    resourceType: "Condition",
    id: "htn",
    clinicalStatus: { coding: [{ code: "active" }] },
    subject: { reference: "urn:uuid:p" },
    encounter: { reference: "urn:uuid:e1" },
  },
] as Resource[];
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

test("a Synthea person becomes each hospital's own patient, trimmed and renamed", () => {
  const files = fromSynthea(bundle, [NORTH, SOUTH]);
  const [north, south] = files.map((file) =>
    (file.bundle.entry ?? []).map((entry) => entry.resource),
  ) as [Resource[], Resource[]];
  const of = (records: Resource[], type: string) =>
    records.filter((record) => record.resourceType === type);

  for (const records of [north, south]) {
    assert.deepEqual(of(records, "Claim"), []);
    const text = JSON.stringify(records);
    assert.ok(!text.includes("urn:uuid:") && !text.includes(REAL));
    const names = new Set(records.map((r) => `${r.resourceType}/${r.id}`));
    for (const match of text.matchAll(/"reference":"([^"]+)"/g)) {
      assert.ok(names.has(match[1]!), match[1]);
    }
  }
  assert.equal(of(north, "Encounter").length, 2);
  assert.equal(of(south, "Encounter").length, 1);
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

test("a Synthea person the hospitals cannot hold faithfully is refused", () => {
  const unknownMedication = {
    ...bundle,
    entry: [
      ...(bundle.entry ?? []),
      {
        resource: {
          resourceType: "MedicationRequest",
          id: "rx",
          status: "active",
          medicationReference: { reference: "urn:uuid:no-such-medication" },
        },
      },
    ],
  } as Bundle;
  const THIRD = hospital("cascade-west", "Cascade West Demo Hospital");
  const PRESCRIBER = hospital("cascade-east", "Cascade East Demo Hospital", [
    ...TYPES,
    "MedicationRequest",
  ]);
  for (const [why, input, hospitals] of [
    ["three hospitals", bundle, [NORTH, SOUTH, THIRD]],
    ["a Medication not in the bundle", unknownMedication, [PRESCRIBER]],
  ] as const) {
    assert.throws(() => fromSynthea(input, [...hospitals]), Error, why);
  }
});
