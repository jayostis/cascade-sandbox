import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bundle, Hospital, Resource } from "../index.js";
import { fromSynthea, type HospitalFolder, type Removed } from "./synthea.js";

const PACKAGE = fileURLToPath(new URL("../../../", import.meta.url));

interface Person {
  synthea: string;
  hospitals: string[];
}

export function bundleText(bundle: Bundle): string {
  const entries = (bundle.entry ?? []).map((entry) => JSON.stringify(entry));
  return `{"resourceType":"Bundle","type":"${bundle.type}","entry":[\n${entries.join(",\n")}\n]}\n`;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function main(output: string): Promise<void> {
  const fhir = join(output, "fhir");
  const files = await readdir(fhir);
  const providers: Resource[] = [];
  for (const file of files.filter((name) => name.startsWith("hospital"))) {
    const bundle = await readJson<Bundle>(join(fhir, file));
    providers.push(...(bundle.entry ?? []).map((entry) => entry.resource));
  }
  const people = await readJson<Person[]>(
    join(PACKAGE, "synthea", "people.json"),
  );
  const folders = [...new Set(people.flatMap((person) => person.hospitals))];
  const hospitals = new Map<string, HospitalFolder>();
  for (const folder of folders) {
    const hospital = await readJson<Hospital>(
      join(PACKAGE, "data", folder, "hospital.json"),
    );
    hospitals.set(folder, { folder, hospital });
    const patients = join(PACKAGE, "data", folder, "patients");
    for (const file of await readdir(patients)) {
      if (file.startsWith("syn-")) await rm(join(patients, file));
    }
  }

  const removed: Removed = { names: [], addresses: [], telecoms: [] };
  for (const person of people) {
    const file = files.find((name) => name.endsWith(`_${person.synthea}.json`));
    if (!file) throw new Error(`No Synthea output for ${person.synthea}`);
    const result = fromSynthea(
      await readJson<Bundle>(join(fhir, file)),
      person.hospitals.map((folder) => hospitals.get(folder)!),
      providers,
    );
    for (const { folder, id, bundle } of result.files) {
      await writeFile(
        join(PACKAGE, "data", folder, "patients", `${id}.json`),
        bundleText(bundle),
      );
    }
    removed.names.push(...result.removed.names);
    removed.addresses.push(...result.removed.addresses);
    removed.telecoms.push(...result.removed.telecoms);
  }
  const sorted = (list: string[]) => [...new Set(list)].sort();
  await writeFile(
    join(PACKAGE, "synthea", "removed.json"),
    `${JSON.stringify(
      {
        names: sorted(removed.names),
        addresses: sorted(removed.addresses),
        telecoms: sorted(removed.telecoms),
      },
      null,
      2,
    )}\n`,
  );
}

const [output] = process.argv.slice(2);
if (!output) {
  console.error("usage: npm run synthea -- <Synthea output folder>");
  process.exitCode = 2;
} else {
  await main(output);
}
