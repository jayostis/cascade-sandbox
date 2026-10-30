import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { type Resource, recordsAt, versionsOf } from "../src/index.js";
import {
  DEFAULT_ROOTS,
  loadHospital,
  loadHospitals,
  loadPeople,
} from "../src/node/index.js";
import {
  type Chosen,
  generatedPerson,
  OBSERVATION_CATEGORIES,
} from "../src/node/synthea.js";

const PACKAGE = new URL("../../", import.meta.url);
const FOLDERS = ["cascade-north", "cascade-south"];
const PEOPLE = await loadPeople(DEFAULT_ROOTS.people);

test("the hospitals serve the people the package holds: each patient at each hospital, with as many records as when each hospital held its own patients", async () => {
  const served = Object.fromEntries(
    (await loadHospitals()).map(({ hospital, patients }) => [
      new URL(hospital.fhirBase).hostname.split(".")[0],
      Object.fromEntries(
        Object.entries(patients)
          .map(([id, bundle]) => [id, versionsOf(bundle, id).size] as const)
          .sort(([one], [other]) => one.localeCompare(other)),
      ),
    ]),
  );
  assert.deepEqual(served, {
    "cascade-north": {
      "pt-1001": 17,
      "pt-1002": 10,
      "story-red-herring": 16,
      "story-side-effect": 8,
      "story-statin": 9,
      "story-stopped": 8,
      "story-too-little": 6,
      "syn-c521b4f4b8f5b303": 745,
      "syn-eb3d267fcb803202": 780,
    },
    "cascade-south": {
      "s-48213": 10,
      "syn-0c7c8edf48f450e1": 566,
      "syn-25b2cdfcaf0b380e": 736,
    },
  });
});

test("Rowan Ellery Marsh is one person at two hospitals, under each hospital's own patient id", async () => {
  const rowan = PEOPLE.find(({ person }) => person.id === "rowan-ellery-marsh");
  assert.deepEqual(Object.keys(rowan?.sources ?? {}), [
    "cascade-north",
    "cascade-south",
  ]);
  const [north, south] = await Promise.all(
    FOLDERS.map((id) => loadHospital(id)),
  );
  assert.ok(north && "pt-1001" in north.patients);
  assert.ok(south && "s-48213" in south.patients);
  assert.deepEqual(north.patients["pt-1001"], rowan!.sources["cascade-north"]);
});

test("each generated person is what npm run synthea writes of their first hospital's Patient", async () => {
  const chosen = JSON.parse(
    await readFile(new URL("synthea/people.json", PACKAGE), "utf8"),
  ) as Chosen[];
  for (const one of chosen) {
    const loaded = PEOPLE.find(({ person }) => person.id === one.person);
    assert.ok(loaded, one.person);
    assert.deepEqual(Object.keys(loaded.sources), one.hospitals, one.person);
    assert.deepEqual(
      loaded.person,
      generatedPerson(one, loaded.sources[one.hospitals[0]!]!),
      one.person,
    );
  }
  assert.deepEqual(
    PEOPLE.filter(({ person }) => person.generated).map(
      ({ person }) => person.id,
    ),
    chosen.map(({ person }) => person).sort(),
  );
});
const removed = JSON.parse(
  await readFile(new URL("synthea/removed.json", PACKAGE), "utf8"),
) as Record<string, string[]>;
const forbidden = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${Object.values(removed)
    .flat()
    .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

function references(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(references);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const own = "reference" in object || "display" in object ? [object] : [];
  return [...own, ...Object.values(object).flatMap(references)];
}

const PROVIDER_FIELDS = [
  "serviceProvider",
  "location",
  "performer",
  "custodian",
];

test("every patient file keeps the hospitals' data rules", async () => {
  const idsAt = new Map<string, Set<string>>();
  const people = new Map<string, string[]>();
  for (const { folder, sources } of PEOPLE)
    for (const source of Object.keys(sources)) {
      const file = join(folder, "sources", source, "fhir.json");
      assert.ok((await stat(file)).size <= 2 * 1024 * 1024, file);
    }
  for (const folder of FOLDERS) {
    const { hospital, patients } = await loadHospital(folder);
    const ids = new Set<string>();
    idsAt.set(folder, ids);
    for (const [patient, bundle] of Object.entries(patients)) {
      const where = `${folder}/${patient}`;
      const versions = versionsOf(bundle, where);
      const names = new Set(versions.keys());
      for (const key of names) {
        assert.ok(!ids.has(key), `${where} ${key} is in another file`);
        ids.add(key);
      }
      const records = [...versions.values()].flatMap((each) =>
        each.flatMap(({ resource }) => resource ?? []),
      );
      for (const record of records) {
        const name = `${where} ${record.resourceType}/${record.id}`;
        assert.ok(hospital.types.includes(record.resourceType), name);
        if (record.resourceType === "Observation") {
          const codes = strings(record.category);
          assert.equal(
            OBSERVATION_CATEGORIES.filter((code) => codes.includes(code))
              .length,
            1,
            name,
          );
        }
        if (record.resourceType !== "Patient") {
          assert.ok(!("address" in record) && !("telecom" in record), name);
        }
        for (const ref of references(record)) {
          if (typeof ref.reference === "string") {
            assert.ok(names.has(ref.reference), `${name} → ${ref.reference}`);
          }
        }
        for (const field of PROVIDER_FIELDS) {
          for (const ref of references(record[field])) {
            const practitioner =
              ref.type === "Practitioner" ||
              String(ref.reference ?? "").startsWith("Practitioner");
            if (!practitioner) {
              assert.equal(ref.display ?? hospital.name, hospital.name, name);
            }
          }
        }
        if (patient.startsWith("syn-")) {
          for (const text of [...strings(record), ...notes(record)]) {
            assert.ok(!text.toLowerCase().includes("urn:uuid:"), name);
            const named = forbidden.exec(text)?.[0];
            assert.equal(named, undefined, `${name} names "${named}"`);
          }
        }
      }
      const person = recordsAt(bundle).find(
        (record): record is Resource => record.resourceType === "Patient",
      );
      const key = JSON.stringify([
        strings(person?.name).join(" "),
        person?.birthDate,
      ]);
      people.set(key, [...(people.get(key) ?? []), folder]);
    }
  }
  const [north, south] = FOLDERS.map((folder) => idsAt.get(folder)!);
  assert.deepEqual(
    [...north!].filter((id) => south!.has(id)),
    [],
    "an id at both hospitals",
  );
  const atBoth = [...people.values()].filter((folders) => folders.length > 1);
  assert.ok(atBoth.length >= 2, "patient A and the Synthea person at both");
});

/** The text of each attachment of a note or a report. */
function notes(record: Resource): string[] {
  const content = (record.content ?? []) as {
    attachment?: { data?: string };
  }[];
  const forms = (record.presentedForm ?? []) as { data?: string }[];
  return [...content.map(({ attachment }) => attachment ?? {}), ...forms]
    .flatMap(({ data }) => (typeof data === "string" ? [data] : []))
    .map((data) => Buffer.from(data, "base64").toString("utf8"));
}

/** The instant a record's final content first holds, by its type. */
function firstHeld(record: Resource): number | undefined {
  const dates: Record<string, unknown> = {
    MedicationRequest: record.authoredOn,
    Condition: record.recordedDate,
    AllergyIntolerance: record.recordedDate,
    Observation: record.issued,
    Immunization: record.occurrenceDateTime,
    Procedure: (record.performedPeriod as { end?: string } | undefined)?.end,
    Encounter: (record.period as { end?: string } | undefined)?.end,
    DiagnosticReport: record.issued,
    DocumentReference: record.date,
  };
  const at = Date.parse(String(dates[record.resourceType]));
  return Number.isNaN(at) ? undefined : at;
}

test("a Synthea patient is a history cut by the dates Synthea gave: a record is first held when its final content holds, and only an order stopped or a condition abated has a second version", async () => {
  let files = 0;
  for (const folder of FOLDERS) {
    const { patients } = await loadHospital(folder);
    for (const [patient, bundle] of Object.entries(patients)) {
      if (!patient.startsWith("syn-")) continue;
      files++;
      const where = `${folder}/${patient}`;
      assert.equal(bundle.type, "history", where);
      const versions = versionsOf(bundle, where);
      const all = [...versions.values()].flat();
      const patientAt = Date.parse(
        [...versions.entries()].find(([key]) =>
          key.startsWith("Patient/"),
        )![1][0]!.recorded!,
      );
      const visits = all
        .filter(({ record }) => record.startsWith("Encounter/"))
        .map(({ resource }) =>
          Date.parse(String((resource!.period as { start: string }).start)),
        );
      for (const [key, list] of versions) {
        const name = `${where} ${key}`;
        const [first, second, ...rest] = list;
        assert.deepEqual(rest, [], `${name} has at most two versions`);
        for (const version of list) {
          assert.ok(Date.parse(version.recorded!) >= patientAt, name);
        }
        const record = first!.resource!;
        if (record.resourceType !== "Patient") {
          const held = firstHeld(record);
          const at = Date.parse(first!.recorded!);
          assert.ok(
            at === held || visits.includes(at),
            `${name}: version 1 is neither when it was first held nor a visit there`,
          );
        }
        if (!second) continue;
        const later = second.resource!;
        const state = (each: Resource) =>
          each.resourceType === "MedicationRequest"
            ? each.status
            : (each.clinicalStatus as { coding: { code: string }[] }).coding[0]!
                .code;
        assert.ok(
          ["MedicationRequest", "Condition"].includes(record.resourceType),
          name,
        );
        assert.equal(state(record), "active", name);
        assert.notEqual(state(later), "active", name);
        assert.ok(!("abatementDateTime" in record), name);
        if (record.resourceType === "Condition") {
          assert.equal(
            Date.parse(second.recorded!),
            Date.parse(String(later.abatementDateTime)),
            name,
          );
        }
      }
      const text = JSON.stringify(bundle);
      assert.ok(!text.includes("synthetichealth.github.io"), where);
      for (const type of ["DiagnosticReport", "DocumentReference"])
        assert.ok(
          all.some(
            ({ resource }) =>
              resource?.resourceType === type && notes(resource).length > 0,
          ),
          `${where} holds a ${type} with its text`,
        );
    }
  }
  assert.equal(files, 4);
});

function codings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(codings);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const own =
    typeof object.system === "string" && typeof object.code === "string"
      ? [`${object.system}|${object.code}`]
      : [];
  return [...own, ...Object.values(object).flatMap(codings)];
}

const ICD = "http://hl7.org/fhir/sid/icd-10-cm";
const CVX = "http://hl7.org/fhir/sid/cvx";
const LOINC = "http://loinc.org";
const RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm";

test("hand-written patients hold the codes that reach the reference tables: retired and current ICD-10-CM, CVX and LOINC beside each other, a brand and its generic, two allergies and two medicines of one ingredient, in two hospitals for one person", async () => {
  const north = await loadHospital("cascade-north");
  const south = await loadHospital("cascade-south");
  const held = (
    hospital: typeof north,
    patient: string,
    type: string,
    system: string,
  ) =>
    recordsAt(
      hospital.patients[patient] ?? {
        resourceType: "Bundle",
        type: "collection",
      },
    )
      .filter((record) => record.resourceType === type)
      .map((record) => ({
        record,
        code: codings(record.code ?? record.vaccineCode ?? record)
          .filter((coding) => coding.startsWith(`${system}|`))
          .map((coding) => coding.slice(system.length + 1)),
      }));
  const has = (
    hospital: typeof north,
    patient: string,
    type: string,
    system: string,
    code: string,
  ) => held(hospital, patient, type, system).find((r) => r.code.includes(code));

  const conditions = ["T84.040A", "M97.01XA"].map((code) =>
    has(north, "pt-1002", "Condition", ICD, code),
  );
  for (const condition of conditions) {
    assert.ok(condition);
    assert.deepEqual(
      codings(condition.record.code).filter(
        (coding) => !coding.startsWith(`${ICD}|`),
      ),
      [],
      "coded by ICD-10-CM alone, so only the conversion joins them",
    );
  }
  assert.ok(
    Date.parse(String(conditions[0]!.record.recordedDate)) <
      Date.parse(String(conditions[1]!.record.recordedDate)),
    "the retired code was recorded before its replacement",
  );
  assert.ok(has(north, "pt-1002", "Immunization", CVX, "154"));
  const hdl = ["2086-7", "2085-9"].map((code) =>
    has(north, "pt-1002", "Observation", LOINC, code),
  );
  assert.ok(hdl[0] && hdl[1]);
  assert.ok(
    Date.parse(String(hdl[0].record.effectiveDateTime)) <
      Date.parse(String(hdl[1].record.effectiveDateTime)),
  );

  assert.ok(has(north, "pt-1001", "MedicationRequest", RXNORM, "206805"));
  assert.ok(has(south, "s-48213", "MedicationRequest", RXNORM, "311372"));
  assert.ok(has(north, "pt-1001", "AllergyIntolerance", RXNORM, "723"));
  assert.ok(has(south, "s-48213", "AllergyIntolerance", RXNORM, "308191"));
  const ten = has(south, "s-48213", "MedicationRequest", RXNORM, "314076");
  const twenty = has(south, "s-48213", "MedicationRequest", RXNORM, "314077");
  assert.ok(has(north, "pt-1001", "MedicationRequest", RXNORM, "314076"));
  assert.ok(ten && twenty);
  assert.ok(
    Date.parse(String(ten.record.authoredOn)) <
      Date.parse(String(twenty.record.authoredOn)),
    "the 20 mg order is dated after the 10 mg order",
  );
  for (const [hospital, patient, code] of [
    [north, "pt-1001", "206805"],
    [south, "s-48213", "311372"],
    [south, "s-48213", "314077"],
  ] as const)
    assert.equal(
      has(hospital, patient, "MedicationRequest", RXNORM, code)?.record.status,
      "active",
      `${code} is an active medicine, which the Medications tile lists`,
    );
});
