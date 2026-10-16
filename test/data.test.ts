import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Resource } from "../src/index.js";
import { loadHospital } from "../src/node/index.js";
import { OBSERVATION_CATEGORIES } from "../src/node/synthea.js";

const PACKAGE = new URL("../../", import.meta.url);
const FOLDERS = ["cascade-north", "cascade-south"];
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

const PROVIDER_FIELDS = ["serviceProvider", "location", "performer"];

test("every patient file keeps the hospitals' data rules", async () => {
  const idsAt = new Map<string, Set<string>>();
  const people = new Map<string, string[]>();
  for (const folder of FOLDERS) {
    const { hospital, patients } = await loadHospital(folder);
    const ids = new Set<string>();
    idsAt.set(folder, ids);
    for (const [patient, bundle] of Object.entries(patients)) {
      const where = `${folder}/${patient}`;
      const file = fileURLToPath(
        new URL(`data/${folder}/patients/${patient}.json`, PACKAGE),
      );
      assert.ok((await stat(file)).size <= 2 * 1024 * 1024, where);
      const records = (bundle.entry ?? []).map((entry) => entry.resource);
      const names = new Set(
        records.map((record) => `${record.resourceType}/${record.id}`),
      );
      for (const record of records) {
        const name = `${where} ${record.resourceType}/${record.id}`;
        assert.ok(hospital.types.includes(record.resourceType), name);
        assert.ok(!ids.has(`${record.resourceType}/${record.id}`), name);
        ids.add(`${record.resourceType}/${record.id}`);
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
            if (!String(ref.reference ?? "").startsWith("Practitioner")) {
              assert.equal(ref.display ?? hospital.name, hospital.name, name);
            }
          }
        }
        if (patient.startsWith("syn-")) {
          for (const text of strings(record)) {
            assert.ok(!text.toLowerCase().includes("urn:uuid:"), name);
            const named = forbidden.exec(text)?.[0];
            assert.equal(named, undefined, `${name} names "${named}"`);
          }
        }
      }
      const person = records.find(
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
    (hospital.patients[patient]?.entry ?? [])
      .map((entry) => entry.resource)
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
