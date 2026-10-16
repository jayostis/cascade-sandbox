// Validates every resource the demo hospitals serve, each version of each record, and their brands bundle, against
// FHIR R4, US Core and SMART App Launch, with the HL7 validator in Docker. Run from the repository's root after `tsc -b`: `npm run validate:data`.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { brandsBundle, versionsOf } from "../dist/src/index.js";
import { loadHospitals } from "../dist/src/node/index.js";

const VALIDATOR = {
  version: "6.10.4",
  sha256: "1106b9d58f9e363e47bea7c4fc065841e5fc91fe9d062775c3bfdd212bd653cc",
};
const IMAGE =
  "eclipse-temurin:21-jre@sha256:cff19e6215689161eb6162c11b86b0c60ddf802164f2eaf48d570f8fb79a36c5";
const IGS = ["hl7.fhir.us.core#6.1.0", "hl7.fhir.uv.smart-app-launch#2.2.0"];
const WORK = fileURLToPath(
  new URL("../../../build/validator/", import.meta.url),
);

/**
 * Each resource the hospitals serve, as `[file name, resource]`: every version of every record of every patient file,
 * and the brands bundle that lists them.
 */
async function* inputs() {
  const hospitals = await loadHospitals();
  yield [
    "brands.json",
    brandsBundle(
      hospitals.map(({ hospital }) => hospital),
      "2026-01-01T00:00:00Z",
    ),
  ];
  for (const { hospital, patients } of hospitals) {
    const at = new URL(hospital.fhirBase).hostname.split(".")[0];
    for (const [patient, bundle] of Object.entries(patients)) {
      for (const versions of versionsOf(bundle, patient).values()) {
        for (const { record, versionId, resource } of versions) {
          if (!resource) continue;
          const name = `${at}__${patient}__${record.replace("/", "-")}__${versionId}.json`;
          yield [name, resource];
        }
      }
    }
  }
}

const input = join(WORK, "in");
await rm(input, { recursive: true, force: true });
await mkdir(input, { recursive: true });
let count = 0;
for await (const [name, resource] of inputs()) {
  await writeFile(join(input, name), JSON.stringify(resource));
  count += 1;
}
process.stdout.write(`validating ${count} resources\n`);

const jar = `/work/validator_cli-${VALIDATOR.version}.jar`;
const script = [
  "set -euo pipefail",
  `[ -f ${jar} ] || curl -sSL -o ${jar} https://github.com/hapifhir/org.hl7.fhir.core/releases/download/${VALIDATOR.version}/validator_cli.jar`,
  `echo "${VALIDATOR.sha256}  ${jar}" | sha256sum -c - > /dev/null`,
  [
    `java -Xmx3g -jar ${jar} /work/in -version 4.0.1`,
    ...IGS.map((ig) => `-ig ${ig}`),
    "-tx n/a -output /work/outcome.json > /work/validator.log 2>&1",
  ].join(" "),
].join("\n");
const run = spawnSync(
  "docker",
  ["run", "--rm", "-v", `${WORK}:/work`, IMAGE, "bash", "-c", script],
  { stdio: "inherit" },
);
if (run.status !== 0 && run.status !== 1) {
  process.stderr.write(
    `the validator did not finish (exit ${run.status}); see build/validator/validator.log\n`,
  );
  process.exit(2);
}

const outcome = JSON.parse(await readFile(join(WORK, "outcome.json"), "utf8"));
const outcomes =
  outcome.resourceType === "Bundle"
    ? outcome.entry.map(({ resource }) => resource)
    : [outcome];
const errors = outcomes.flatMap((each) => {
  const file =
    each.extension
      ?.find(({ url }) => url.endsWith("operationoutcome-file"))
      ?.valueString?.split("/")
      .at(-1) ?? "(a file)";
  return (each.issue ?? [])
    .filter(({ severity }) => severity === "error" || severity === "fatal")
    .map(
      ({ expression, location, details, diagnostics }) =>
        `${file} ${(expression ?? location ?? []).join(", ")}: ${details?.text ?? diagnostics}`,
    );
});
for (const error of errors) process.stdout.write(`${error}\n`);
process.stdout.write(
  `${errors.length} errors in ${count} resources (${errors.filter((error) => error.includes("__syn-")).length} in the Synthea data)\n`,
);
process.exit(errors.length === 0 ? 0 : 1);
