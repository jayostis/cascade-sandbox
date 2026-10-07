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
    patients[file.slice(0, -".json".length)] = JSON.parse(
      await readFile(join(root, "patients", file), "utf8"),
    ) as Bundle;
  }
  return { hospital, patients };
}
