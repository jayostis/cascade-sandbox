import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bundle, Hospital } from "../index.js";

const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));

export async function loadHospital(
  folder: string,
): Promise<{ hospital: Hospital; patients: Record<string, Bundle> }> {
  const root = resolve(DATA, folder);
  const hospital = JSON.parse(
    await readFile(join(root, "hospital.json"), "utf8"),
  ) as Hospital;
  const patients: Record<string, Bundle> = {};
  for (const file of (await readdir(join(root, "patients"))).sort()) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -".json".length);
    const bundle = JSON.parse(
      await readFile(join(root, "patients", file), "utf8"),
    ) as Bundle;
    const held = bundle.entry?.find(
      (entry) => entry.resource.resourceType === "Patient",
    )?.resource.id;
    if (held !== id) {
      throw new Error(
        `patients/${file} holds Patient ${held ?? "(none)"}, not ${id}`,
      );
    }
    patients[id] = bundle;
  }
  return { hospital, patients };
}

/** Every hospital in `data/`, in its folders' order, as `demoFetch` takes them. */
export async function loadHospitals(): Promise<
  { hospital: Hospital; patients: Record<string, Bundle> }[]
> {
  const hospitals: { hospital: Hospital; patients: Record<string, Bundle> }[] =
    [];
  for (const entry of (await readdir(DATA, { withFileTypes: true })).sort(
    (a, b) => (a.name < b.name ? -1 : 1),
  ))
    if (entry.isDirectory()) hospitals.push(await loadHospital(entry.name));
  return hospitals;
}
