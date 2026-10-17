import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HospitalDataError, patientRecords, versionsOf } from "../history.js";
import type { Bundle, Hospital, Story } from "../index.js";
import { hospitalId } from "../route.js";
import {
  compileShorthand,
  hasShorthand,
  type ShorthandBundle,
} from "../shorthand.js";

/** The package's own hospitals: a folder of hospital folders, each `hospital.json` and its `patients/`. */
export const DATA_FOLDER = fileURLToPath(
  new URL("../../../data/", import.meta.url),
);
/** Where the stories' written answers and C-CDA copies are, outside `data/` so no hospital serves them. */
export const STORIES = fileURLToPath(
  new URL("../../../stories/", import.meta.url),
);

export type LoadedHospital = {
  hospital: Hospital;
  patients: Record<string, Bundle>;
};

export async function loadStories(): Promise<Story[]> {
  return JSON.parse(
    await readFile(join(STORIES, "stories.json"), "utf8"),
  ) as Story[];
}

/** What `path` is, by asking the file system about it: reading a folder as a file fails differently on each system. */
async function kind(path: string): Promise<"folder" | "file" | undefined> {
  try {
    const found = await stat(path);
    return found.isDirectory() ? "folder" : found.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readJson(path: string, where: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new HospitalDataError(
      where,
      `is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Refuses a file that is not a Bundle-shaped object whose entries are objects, before anything reads inside it. */
function checkBundle(value: unknown, where: string): Bundle {
  if (!isObject(value)) throw new HospitalDataError(where, "is not an object");
  const { entry } = value;
  if (
    entry !== undefined &&
    (!Array.isArray(entry) ||
      entry.some(
        (one) =>
          !isObject(one) ||
          (one.resource !== undefined && !isObject(one.resource)),
      ))
  )
    throw new HospitalDataError(
      where,
      "has an entry that is not an object, or whose resource is not",
    );
  return value as unknown as Bundle;
}

function checkHospital(value: unknown): Hospital {
  const where = "hospital.json";
  if (!isObject(value)) throw new HospitalDataError(where, "is not an object");
  for (const field of ["name", "fhirBase"])
    if (typeof value[field] !== "string")
      throw new HospitalDataError(where, `has no ${field}, a string`);
  if (
    !Array.isArray(value.types) ||
    value.types.some((type) => typeof type !== "string")
  )
    throw new HospitalDataError(where, "has no types, a list of strings");
  return value as unknown as Hospital;
}

/** A hospital's folder, read as it is: `hospital.json`, and the `.json` files of `patients/` if it has any. */
export async function loadHospital(folder: string): Promise<LoadedHospital> {
  const root = resolve(DATA_FOLDER, folder);
  if ((await kind(join(root, "hospital.json"))) !== "file")
    throw new HospitalDataError("hospital.json", "is not there");
  const hospital = checkHospital(
    await readJson(join(root, "hospital.json"), "hospital.json"),
  );
  const patients: Record<string, Bundle> = {};
  const folderOfPatients = join(root, "patients");
  if ((await kind(folderOfPatients)) === "folder")
    for (const file of (await readdir(folderOfPatients)).sort()) {
      if (
        !file.endsWith(".json") ||
        (await kind(join(folderOfPatients, file))) !== "file"
      )
        continue;
      const where = `patients/${file}`;
      patients[file.slice(0, -".json".length)] = checkBundle(
        await readJson(join(folderOfPatients, file), where),
        where,
      );
    }
  patientRecords(hospital.fhirBase, patients);
  return { hospital, patients };
}

function idOf(hospital: Hospital): string {
  try {
    return hospitalId({ hospital, patients: {} });
  } catch (error) {
    throw new HospitalDataError(
      "hospital.json",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Every hospital in the folders given (the package's own by default), as `demoFetch` takes them: roots in order, then
 * each root's hospital folders by name. A root that is not a folder is skipped, and so is a file where a hospital
 * folder would be, and a name with a leading dot (`.git`). Two hospitals with one id throw.
 */
export async function loadHospitals(
  roots: readonly string[] = [DATA_FOLDER],
): Promise<LoadedHospital[]> {
  const hospitals: LoadedHospital[] = [];
  const taken = new Set<string>();
  for (const root of roots) {
    if ((await kind(root)) !== "folder") continue;
    for (const name of (await readdir(root)).sort()) {
      if (name.startsWith(".")) continue;
      const folder = join(root, name);
      if ((await kind(folder)) !== "folder") continue;
      let loaded: LoadedHospital;
      let id: string;
      try {
        loaded = await loadHospital(folder);
        id = idOf(loaded.hospital);
      } catch (error) {
        if (error instanceof HospitalDataError)
          throw new HospitalDataError(`${name}/${error.where}`, error.reason);
        throw error;
      }
      if (taken.has(id))
        throw new HospitalDataError("hospital.json", `two hospitals at ${id}`);
      taken.add(id);
      hospitals.push(loaded);
    }
  }
  return hospitals;
}

/**
 * Checks a patient file as the hospital at `folder` (relative to the working folder) would load it, and writes it as
 * `patients/<id>.json`, `<id>` being its Patient's. The file is a plain or history Bundle, written as it is, or an
 * authoring file with `shorthand`, compiled first. Refuses a patient who is already there. Gives the path written.
 */
export async function addPatient(
  folder: string,
  file: string,
): Promise<string> {
  const where = basename(file);
  let text: string;
  try {
    text = await readFile(resolve(file), "utf8");
  } catch (error) {
    throw new HospitalDataError(
      where,
      `cannot be read: ${(error as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HospitalDataError(where, "is not JSON");
  }
  let bundle = checkBundle(parsed, where);
  if (bundle.resourceType !== "Bundle")
    throw new HospitalDataError(where, "is not a Bundle");
  if (hasShorthand(bundle))
    bundle = compileShorthand(bundle as ShorthandBundle, where);
  const held = [...versionsOf(bundle, where).keys()]
    .filter((record) => record.startsWith("Patient/"))
    .map((record) => record.slice("Patient/".length));
  if (held.length !== 1)
    throw new HospitalDataError(
      where,
      held.length === 0
        ? "holds no Patient"
        : `holds ${held.length} Patients: a patient's file holds one`,
    );
  const [id] = held as [string];
  if (!/^[A-Za-z0-9\-.]{1,64}$/.test(id))
    throw new HospitalDataError(
      where,
      `holds Patient ${id}, which is not a FHIR id`,
    );
  const root = resolve(folder);
  const { hospital, patients } = await loadHospital(root);
  const name = `patients/${id}.json`;
  if (id in patients)
    throw new HospitalDataError(
      name,
      "is already in this hospital: remove it first, or give the patient another id",
    );
  const records = patientRecords(hospital.fhirBase, {
    ...patients,
    [id]: bundle,
  }).get(id);
  for (const record of records?.keys() ?? []) {
    const type = record.slice(0, record.indexOf("/"));
    if (!hospital.types.includes(type))
      throw new HospitalDataError(
        name,
        `${record} is ${/^[AEIOU]/.test(type) ? "an" : "a"} ${type}, which hospital.json does not list in types`,
      );
  }
  const path = join(root, name);
  await mkdir(join(root, "patients"), { recursive: true });
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, { flag: "wx" });
  return path;
}
export * from "./serve.js";
