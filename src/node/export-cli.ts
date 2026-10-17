import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { HospitalDataError } from "../history.js";
import { exportCollection } from "../export.js";
import { loadHospital } from "./index.js";

const USAGE =
  "usage: npm run export -- <hospital> <patient> <out.json> [--as-of <instant>]";

const isMisuse = (error: unknown) =>
  error instanceof TypeError &&
  String((error as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS_");

const parse = () =>
  parseArgs({
    allowPositionals: true,
    options: { "as-of": { type: "string" } },
  });

async function main(): Promise<void> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse();
  } catch (error) {
    if (!isMisuse(error)) throw error;
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const {
    positionals: [hospital, patient, out],
    values,
  } = args;
  if (!hospital || !patient || !out) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const collection = exportCollection(
    await loadHospital(hospital),
    patient,
    values["as-of"],
  );
  await writeFile(out, `${JSON.stringify(collection, null, 2)}\n`);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof HospitalDataError
      ? error.message
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error),
  );
  process.exitCode = 1;
});
