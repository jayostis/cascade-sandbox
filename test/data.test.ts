import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Resource } from "../src/index.js";
import { loadHospital } from "../src/node/index.js";

const PACKAGE = new URL("../../", import.meta.url);
const FOLDERS = ["cascade-north", "cascade-south"];
const removed = JSON.parse(
  await readFile(new URL("synthea/removed.json", PACKAGE), "utf8"),
) as Record<string, string[]>;
const forbidden = Object.values(removed)
  .flat()
  .map((text) => text.toLowerCase());

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
            ["laboratory", "vital-signs"].filter((code) => codes.includes(code))
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
            const lower = text.toLowerCase();
            assert.ok(!lower.includes("urn:uuid:"), name);
            for (const word of forbidden) {
              assert.ok(!lower.includes(word), `${name} names "${word}"`);
            }
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
