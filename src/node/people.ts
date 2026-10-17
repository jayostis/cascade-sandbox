import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { HospitalDataError, versionsOf } from "../history.js";
import type { Bundle, Resource } from "../types.js";
import { checkBundle, isObject, isStrings, kind, readJson } from "./read.js";

export type Gender = "male" | "female" | "other" | "unknown";
export interface PersonName {
  family: string;
  given: string[];
}
type Field = "name" | "birthDate" | "gender";
type Grade = "certain" | "probable" | "possible" | "certainly-not";

/** A deliberate disagreement of one source with its person, and the match grade a matcher is expected to give it. */
export interface Difference {
  source: string;
  field: Field;
  value: PersonName | string;
  reason: string;
  expectedMatch: Grade;
}

/** How a generated person was made: written by `npm run synthea`, never by hand. */
export interface Generated {
  by: string;
  syntheaId: string;
  seed: number;
  clinicianSeed: number;
  referenceDate: string;
  endDate: string;
  arguments: string;
  hospitals: string[];
}

/** A person's `person.json`: who they are, the one place their name, birth date, gender and pod subject live. */
export interface Person {
  id: string;
  name: PersonName;
  birthDate: string;
  gender: Gender;
  subject?: { iri: string; name: string; storage: string };
  kit?: string;
  differences?: Difference[];
  generated?: Generated;
}

export interface LoadedPerson {
  /** The person's folder, an absolute path. */
  folder: string;
  person: Person;
  /** Each FHIR source's Bundle, by the source's folder name. */
  sources: Record<string, Bundle>;
  /** The sources that hold C-CDA documents, by folder name: their differences are the vocabulary's to check. */
  documents: string[];
}

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GENDERS = ["male", "female", "other", "unknown"];
const FIELDS = ["name", "birthDate", "gender"];
const GRADES = ["certain", "probable", "possible", "certainly-not"];

const RULE = "a source holds fhir.json and ccda/<day>.xml";

export const isName = (value: unknown): value is PersonName =>
  isObject(value) &&
  typeof value.family === "string" &&
  value.family !== "" &&
  isStrings(value.given) &&
  value.given.length > 0 &&
  value.given.every((given) => given !== "");

const isDifference = (value: unknown): value is Difference =>
  isObject(value) &&
  typeof value.source === "string" &&
  FIELDS.includes(value.field as string) &&
  (value.field === "name"
    ? isName(value.value)
    : typeof value.value === "string") &&
  typeof value.reason === "string" &&
  GRADES.includes(value.expectedMatch as string);

const REQUIRED: [Field | "id", (value: unknown) => boolean, string][] = [
  [
    "id",
    (value) => typeof value === "string" && ID.test(value),
    "a name of lower-case letters and digits joined by -",
  ],
  [
    "name",
    isName,
    "an object of family, a string, and given, a list of one or more strings",
  ],
  [
    "birthDate",
    (value) => typeof value === "string" && DATE.test(value),
    "a date as YYYY-MM-DD",
  ],
  [
    "gender",
    (value) => GENDERS.includes(value as string),
    "male, female, other or unknown",
  ],
];

/** Refuses a `person.json` without the fields every person has, or whose id is not its folder's name. */
export function checkPerson(value: unknown, folder: string): Person {
  const where = `${folder}/person.json`;
  if (!isObject(value)) throw new HospitalDataError(where, "is not an object");
  for (const [field, valid, what] of REQUIRED)
    if (!valid(value[field]))
      throw new HospitalDataError(where, `has no ${field}, ${what}`);
  if (value.id !== folder)
    throw new HospitalDataError(
      where,
      `has the id ${String(value.id)}, but its folder is ${folder}`,
    );
  if (
    value.differences !== undefined &&
    !(Array.isArray(value.differences) && value.differences.every(isDifference))
  )
    throw new HospitalDataError(
      where,
      "has no differences, a list of source, field, value, reason and expectedMatch",
    );
  return value as unknown as Person;
}

/** The id of the one Patient a source holds; refuses a source holding none or more. */
export function patientOf(bundle: Bundle, where: string): string {
  const held = [...versionsOf(bundle, where).keys()]
    .filter((record) => record.startsWith("Patient/"))
    .map((record) => record.slice("Patient/".length));
  if (held.length === 0) throw new HospitalDataError(where, "holds no Patient");
  if (held.length > 1)
    throw new HospitalDataError(
      where,
      `holds ${held.length} Patients: a source holds one`,
    );
  return held[0]!;
}

/** A Patient's name entry with `use` `official`, else its first, or undefined where it has none. */
export function officialName(patient: Resource): PersonName | undefined {
  const names = Array.isArray(patient.name)
    ? (patient.name as unknown[]).filter(isObject)
    : [];
  const name = names.find((one) => one.use === "official") ?? names[0];
  if (name === undefined) return undefined;
  return {
    family: typeof name.family === "string" ? name.family : "",
    given: isStrings(name.given) ? name.given : [],
  };
}

/** What a Patient states of a field, or undefined where it omits it. */
function stated(
  patient: Resource,
  field: Field,
): PersonName | string | undefined {
  if (field === "name") return officialName(patient);
  const value = patient[field];
  return typeof value === "string" ? value : undefined;
}

const said = (value: PersonName | string): string =>
  typeof value === "string" ? value : [...value.given, value.family].join(" ");

const agree = (one: PersonName | string, other: PersonName | string) =>
  typeof one === "string" || typeof other === "string"
    ? one === other
    : one.family === other.family &&
      one.given.length === other.given.length &&
      one.given.every((given, at) => given === other.given[at]);

/**
 * Compares every version of each source's Patient with the person on name, birth date and gender; a field a Patient
 * omits is not compared. Refuses a disagreement the person does not declare. A declared difference must show in its
 * source where that source is a `fhir.json` alone; one at a source among `documents` (C-CDA, which this loader does not
 * read) or, for a kit person, at a source with no folder (a kit download) is the vocabulary's to check. A difference at
 * a source the person has nowhere is refused.
 */
export function checkIdentity(
  person: Person,
  sources: Record<string, Bundle>,
  documents: readonly string[] = [],
): void {
  const declared = new Map(
    (person.differences ?? []).map((difference) => [
      `${difference.source}|${difference.field}`,
      difference.value,
    ]),
  );
  const shown = new Set<string>();
  for (const [source, bundle] of Object.entries(sources)) {
    const where = `${person.id}/sources/${source}/fhir.json`;
    const id = patientOf(bundle, where);
    for (const { resource } of versionsOf(bundle, where).get(
      `Patient/${id}`,
    )!) {
      if (resource === undefined) continue;
      for (const field of FIELDS as Field[]) {
        const value = stated(resource, field);
        if (value === undefined) continue;
        if (agree(value, person[field])) continue;
        shown.add(`${source}|${field}`);
        const expected = declared.get(`${source}|${field}`) ?? person[field];
        if (!agree(value, expected))
          throw new HospitalDataError(
            where,
            `Patient ${id} says ${field} ${said(value)}, person.json says ${said(expected)}`,
          );
      }
    }
  }
  for (const { source, field } of person.differences ?? []) {
    if (shown.has(`${source}|${field}`) || documents.includes(source)) continue;
    if (source in sources)
      throw new HospitalDataError(
        `${person.id}/person.json`,
        `declares a difference in ${field} at ${source} that its Patient does not show`,
      );
    if (person.kit === undefined)
      throw new HospitalDataError(
        `${person.id}/person.json`,
        `declares a difference in ${field} at ${source}, where ${person.id} has no source`,
      );
  }
}

/**
 * One person's folder: `person.json` and each `sources/<source>/`, identity-checked. A source folder holds `fhir.json`,
 * `ccda/<day>.xml` or both, by those names exactly; anything else there is refused, and so is a source holding neither.
 */
async function loadPerson(folder: string, name: string): Promise<LoadedPerson> {
  const file = join(folder, "person.json");
  if ((await kind(file)) !== "file")
    throw new HospitalDataError(`${name}/person.json`, "is not there");
  const person = checkPerson(await readJson(file, `${name}/person.json`), name);
  const sources: Record<string, Bundle> = {};
  const documents: string[] = [];
  const held = join(folder, "sources");
  if ((await kind(held)) === "folder")
    for (const source of (await readdir(held)).sort()) {
      if (source.startsWith(".")) continue;
      const at = `${name}/sources/${source}`;
      const path = join(held, source);
      if ((await kind(path)) !== "folder")
        throw new HospitalDataError(at, `is not a source folder: ${RULE}`);
      for (const entry of (await readdir(path)).sort()) {
        if (entry.startsWith(".")) continue;
        const what = await kind(join(path, entry));
        if (entry === "fhir.json" && what === "file") {
          const where = `${at}/fhir.json`;
          sources[source] = checkBundle(
            await readJson(join(path, entry), where),
            where,
          );
        } else if (entry === "ccda" && what === "folder") {
          for (const day of (await readdir(join(path, entry))).sort()) {
            if (
              !day.endsWith(".xml") ||
              (await kind(join(path, entry, day))) !== "file"
            )
              throw new HospitalDataError(
                `${at}/ccda/${day}`,
                `is not a source file: ${RULE}`,
              );
            if (!documents.includes(source)) documents.push(source);
          }
        } else
          throw new HospitalDataError(
            `${at}/${entry}`,
            `is not a source file: ${RULE}`,
          );
      }
      if (!(source in sources) && !documents.includes(source))
        throw new HospitalDataError(at, `holds no source file: ${RULE}`);
    }
  checkIdentity(person, sources, documents);
  return { folder, person, sources, documents };
}

/**
 * Every person in the folders given, in the order of their ids: each folder of a root that holds people, identity-checked.
 * A root that is not a folder is skipped, and so is a file at a root's top level, and a name with a leading dot. One id in
 * two roots throws.
 */
export async function loadPeople(
  roots: readonly string[],
): Promise<LoadedPerson[]> {
  const people = new Map<string, LoadedPerson>();
  for (const root of roots) {
    if ((await kind(root)) !== "folder") continue;
    for (const name of (await readdir(root)).sort()) {
      if (name.startsWith(".")) continue;
      const folder = join(root, name);
      if ((await kind(folder)) !== "folder") continue;
      if (people.has(name))
        throw new HospitalDataError("people", `two people at ${name}`);
      people.set(name, await loadPerson(folder, name));
    }
  }
  return [...people.keys()].sort().map((id) => people.get(id)!);
}
