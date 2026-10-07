import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bundle, Hospital, Resource } from "../index.js";
import {
  bundleText,
  fromSynthea,
  providerDetails,
  type HospitalFolder,
  type PatientFile,
} from "./synthea.js";

const PACKAGE = fileURLToPath(new URL("../../../", import.meta.url));
const DATA = join(PACKAGE, "data");

interface Person {
  synthea: string;
  hospitals: string[];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function main(output: string): Promise<void> {
  const fhir = join(output, "fhir");
  const files = await readdir(fhir);
  const providers: Resource[] = [];
  for (const file of files.filter(
    (name) =>
      name.startsWith("hospitalInformation") ||
      name.startsWith("practitionerInformation"),
  )) {
    const bundle = await readJson<Bundle>(join(fhir, file));
    providers.push(...(bundle.entry ?? []).map((entry) => entry.resource));
  }
  const people = await readJson<Person[]>(
    join(PACKAGE, "synthea", "people.json"),
  );
  const hospitals = new Map<string, HospitalFolder>();
  for (const folder of new Set(people.flatMap((person) => person.hospitals))) {
    const hospital = await readJson<Hospital>(
      join(DATA, folder, "hospital.json"),
    );
    hospitals.set(folder, { folder, hospital });
  }

  const results: PatientFile[] = [];
  for (const person of people) {
    const file = files.find((name) => name.endsWith(`_${person.synthea}.json`));
    if (!file) throw new Error(`No Synthea output for ${person.synthea}`);
    results.push(
      ...fromSynthea(
        await readJson<Bundle>(join(fhir, file)),
        person.hospitals.map((folder) => hospitals.get(folder)!),
      ),
    );
  }

  for (const entry of await readdir(DATA, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const patients = join(DATA, entry.name, "patients");
    for (const file of await readdir(patients)) {
      if (file.startsWith("syn-")) await rm(join(patients, file));
    }
  }
  for (const { folder, id, bundle } of results) {
    await writeFile(
      join(DATA, folder, "patients", `${id}.json`),
      bundleText(bundle),
    );
  }
  await writeFile(
    join(PACKAGE, "synthea", "removed.json"),
    `${JSON.stringify(providerDetails(providers), null, 2)}\n`,
  );
}

const [output] = process.argv.slice(2);
if (!output) {
  console.error("usage: npm run synthea -- <Synthea output folder>");
  process.exitCode = 2;
} else {
  await main(output);
}
