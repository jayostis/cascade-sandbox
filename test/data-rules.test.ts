import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import {
  type Bundle,
  type Resource,
  recordsAt,
  versionsOf,
} from "../src/index.js";
import { DEFAULT_ROOTS, loadHospital, loadPeople } from "../src/node/index.js";
import {
  type Chosen,
  generatedPerson,
  OBSERVATION_CATEGORIES,
} from "../src/node/synthea.js";

const PACKAGE = new URL("../../", import.meta.url);
const FOLDERS = ["cascade-north", "cascade-south"];
const MOST_BYTES = 2 * 1024 * 1024;
const PROVIDER_FIELDS = [
  "serviceProvider",
  "location",
  "performer",
  "custodian",
];

/** One patient's file as a hospital holds it, read once. */
interface Held {
  hospital: string;
  patient: string;
  where: string;
  bundle: Bundle;
  versions: ReturnType<typeof versionsOf>;
  /** Every version of every record, the Patient's included. */
  records: Resource[];
  /** The current records' names, `Type/id`. */
  names: Set<string>;
}

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

const nameOf = (held: Held, record: Resource) =>
  `${held.where} ${record.resourceType}/${record.id}`;

describe("The package's people, held to the hospitals' data rules", () => {
  let held: Held[];
  let sizes: { file: string; bytes: number }[];
  let types: Record<string, string[]>;
  let hospitalNames: Record<string, string>;
  let forbidden: RegExp;

  before(async () => {
    const people = await loadPeople(DEFAULT_ROOTS.people);
    sizes = [];
    for (const { folder, sources } of people)
      for (const source of Object.keys(sources)) {
        const file = join(folder, "sources", source, "fhir.json");
        sizes.push({ file, bytes: (await stat(file)).size });
      }
    held = [];
    types = {};
    hospitalNames = {};
    for (const folder of FOLDERS) {
      const { hospital, patients } = await loadHospital(folder);
      types[folder] = hospital.types;
      hospitalNames[folder] = hospital.name;
      for (const [patient, bundle] of Object.entries(patients)) {
        const where = `${folder}/${patient}`;
        const versions = versionsOf(bundle, where);
        held.push({
          hospital: folder,
          patient,
          where,
          bundle,
          versions,
          records: [...versions.values()].flatMap((each) =>
            each.flatMap(({ resource }) => resource ?? []),
          ),
          names: new Set(versions.keys()),
        });
      }
    }
    assert.ok(held.length > 0, "no patient file was read");
    const removed = JSON.parse(
      await readFile(new URL("synthea/removed.json", PACKAGE), "utf8"),
    ) as Record<string, string[]>;
    forbidden = new RegExp(
      `(?<![\\p{L}\\p{N}])(?:${Object.values(removed)
        .flat()
        .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|")})(?![\\p{L}\\p{N}])`,
      "iu",
    );
  });

  const offenders = (
    from: readonly Held[],
    check: (one: Held, record: Resource) => string | undefined,
  ) =>
    from.flatMap((one) =>
      one.records.flatMap((record) => check(one, record) ?? []),
    );
  const generated = () =>
    held.filter(({ patient }) => patient.startsWith("syn-"));

  describe("given every patient file", () => {
    it("keeps each file under 2 MiB", () => {
      assert.deepEqual(
        sizes.filter(({ bytes }) => bytes > MOST_BYTES),
        [],
      );
    });

    it("holds each record in one patient's file of its hospital", () => {
      const twice: string[] = [];
      for (const folder of FOLDERS) {
        const seen = new Set<string>();
        for (const one of held.filter(({ hospital }) => hospital === folder))
          for (const name of one.names) {
            if (seen.has(name)) twice.push(`${folder} ${name}`);
            seen.add(name);
          }
      }
      assert.deepEqual(twice, []);
    });

    it("holds no record id at both hospitals", () => {
      const at = (folder: string) =>
        new Set(
          held
            .filter(({ hospital }) => hospital === folder)
            .flatMap(({ names }) => [...names]),
        );
      const [north, south] = FOLDERS.map(at);
      assert.ok(north!.size > 0 && south!.size > 0);
      assert.deepEqual(
        [...north!].filter((id) => south!.has(id)),
        [],
      );
    });

    it("holds only the types its hospital serves", () => {
      assert.deepEqual(
        offenders(held, (one, record) =>
          types[one.hospital]!.includes(record.resourceType)
            ? undefined
            : nameOf(one, record),
        ),
        [],
      );
    });

    it("gives each Observation exactly one of the categories the hospitals search by", () => {
      assert.deepEqual(
        offenders(held, (one, record) => {
          if (record.resourceType !== "Observation") return undefined;
          const codes = strings(record.category);
          return OBSERVATION_CATEGORIES.filter((code) => codes.includes(code))
            .length === 1
            ? undefined
            : nameOf(one, record);
        }),
        [],
      );
    });

    it("keeps addresses and telecoms off every record but the Patient", () => {
      assert.deepEqual(
        offenders(held, (one, record) =>
          record.resourceType !== "Patient" &&
          ("address" in record || "telecom" in record)
            ? nameOf(one, record)
            : undefined,
        ),
        [],
      );
    });

    it("resolves every reference inside the patient's own file", () => {
      assert.deepEqual(
        offenders(held, (one, record) => {
          const lost = references(record)
            .flatMap(({ reference }) =>
              typeof reference === "string" ? [reference] : [],
            )
            .filter((reference) => !one.names.has(reference));
          return lost.length === 0
            ? undefined
            : `${nameOf(one, record)} -> ${lost.join(", ")}`;
        }),
        [],
      );
    });

    it("names only the hospital as provider, location, performer or custodian, practitioners apart", () => {
      assert.deepEqual(
        offenders(held, (one, record) => {
          const name = hospitalNames[one.hospital]!;
          const other = PROVIDER_FIELDS.flatMap((field) =>
            references(record[field]),
          ).filter((ref) => {
            const practitioner =
              ref.type === "Practitioner" ||
              String(ref.reference ?? "").startsWith("Practitioner");
            return !practitioner && (ref.display ?? name) !== name;
          });
          return other.length === 0
            ? undefined
            : `${nameOf(one, record)} names ${other.map((ref) => String(ref.display)).join(", ")}`;
        }),
        [],
      );
    });

    it("holds at least two people at both hospitals", () => {
      const where = new Map<string, Set<string>>();
      for (const one of held) {
        const person = recordsAt(one.bundle).find(
          (record): record is Resource => record.resourceType === "Patient",
        );
        const key = JSON.stringify([
          strings(person?.name).join(" "),
          person?.birthDate,
        ]);
        where.set(key, (where.get(key) ?? new Set()).add(one.hospital));
      }
      assert.ok(
        [...where.values()].filter((folders) => folders.size === 2).length >= 2,
      );
    });
  });

  describe("given a generated patient's file", () => {
    it("names no provider, payer or address that `synthea/removed.json` lists", () => {
      assert.deepEqual(
        offenders(generated(), (one, record) => {
          const named = [...strings(record), ...notes(record)]
            .map((text) => forbidden.exec(text)?.[0])
            .filter((text) => text !== undefined);
          return named.length === 0
            ? undefined
            : `${nameOf(one, record)} names "${named.join('", "')}"`;
        }),
        [],
      );
    });

    it("carries no `urn:uuid:` reference and no Synthea URL", () => {
      assert.deepEqual(
        offenders(generated(), (one, record) =>
          [...strings(record), ...notes(record)].some((text) =>
            text.toLowerCase().includes("urn:uuid:"),
          )
            ? nameOf(one, record)
            : undefined,
        ),
        [],
      );
      assert.deepEqual(
        generated()
          .filter(({ records }) =>
            JSON.stringify(records).includes("synthetichealth.github.io"),
          )
          .map(({ where }) => where),
        [],
      );
    });

    it("is a `history` file, one of four", () => {
      assert.equal(generated().length, 4);
      assert.deepEqual(
        generated()
          .filter(({ bundle }) => bundle.type !== "history")
          .map(({ where }) => where),
        [],
      );
    });

    it("gives a record at most two versions, none recorded before the Patient's", () => {
      const problems: string[] = [];
      for (const one of generated()) {
        const patientAt = Date.parse(
          [...one.versions.entries()].find(([key]) =>
            key.startsWith("Patient/"),
          )![1][0]!.recorded!,
        );
        for (const [key, list] of one.versions) {
          if (list.length > 2)
            problems.push(`${one.where} ${key} has ${list.length} versions`);
          for (const version of list)
            if (Date.parse(version.recorded!) < patientAt)
              problems.push(
                `${one.where} ${key} is recorded before the Patient`,
              );
        }
      }
      assert.deepEqual(problems, []);
    });

    it("gives a second version only to a MedicationRequest or a Condition", () => {
      const second = generated().flatMap((one) =>
        [...one.versions.entries()]
          .filter(([, list]) => list.length > 1)
          .map(([key]) => `${one.where} ${key}`),
      );
      assert.ok(second.length > 0, "no record has a second version");
      assert.deepEqual(
        second.filter((name) => !/ (MedicationRequest|Condition)\//.test(name)),
        [],
      );
    });

    it("holds a DiagnosticReport and a DocumentReference with their text", () => {
      const lacking: string[] = [];
      for (const one of generated())
        for (const type of ["DiagnosticReport", "DocumentReference"])
          if (
            !one.records.some(
              (record) =>
                record.resourceType === type && notes(record).length > 0,
            )
          )
            lacking.push(`${one.where} holds no ${type} with its text`);
      assert.deepEqual(lacking, []);
    });
  });
});

describe("Tripwire: the generated people as npm run synthea writes them", () => {
  let chosen: Chosen[];
  let people: Awaited<ReturnType<typeof loadPeople>>;

  before(async () => {
    chosen = JSON.parse(
      await readFile(new URL("synthea/people.json", PACKAGE), "utf8"),
    ) as Chosen[];
    people = await loadPeople(DEFAULT_ROOTS.people);
    assert.ok(chosen.length > 0, "synthea/people.json chooses no one");
  });

  const loaded = (id: string) => {
    const found = people.find(({ person }) => person.id === id);
    assert.ok(found, id);
    return found;
  };

  describe("given `synthea/people.json`", () => {
    it("matches `generatedPerson()` for each person it chooses", () => {
      for (const one of chosen) {
        const { person, sources } = loaded(one.person);
        assert.deepEqual(
          person,
          generatedPerson(one, sources[one.hospitals[0]!]!),
          one.person,
        );
      }
    });

    it("lists the hospitals it gives each person, in its order", () => {
      for (const one of chosen)
        assert.deepEqual(
          Object.keys(loaded(one.person).sources),
          one.hospitals,
          one.person,
        );
    });

    it("holds no generated person it does not choose", () => {
      assert.deepEqual(
        people
          .filter(({ person }) => person.generated)
          .map(({ person }) => person.id),
        chosen.map(({ person }) => person).sort(),
      );
    });
  });
});
