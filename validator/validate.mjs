// Validates every resource the demo hospitals serve, each version of each record, each patient file and served Bundle whole, and their brands bundle, against
// FHIR R4, US Core and SMART App Launch, with the HL7 validator in Docker. Run from the repository's root after `tsc -b`: `npm run validate:data`.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL, URLSearchParams } from "node:url";
import { createHash } from "node:crypto";
import { brandsBundle, demoHospital, versionsOf } from "../dist/src/index.js";
import { loadHospitals } from "../dist/src/node/index.js";

const { Request } = globalThis;

const VALIDATOR = {
  version: "6.10.4",
  sha256: "1106b9d58f9e363e47bea7c4fc065841e5fc91fe9d062775c3bfdd212bd653cc",
};
const IMAGE =
  "eclipse-temurin:21-jre@sha256:cff19e6215689161eb6162c11b86b0c60ddf802164f2eaf48d570f8fb79a36c5";
const IGS = ["hl7.fhir.us.core#6.1.0", "hl7.fhir.uv.smart-app-launch#2.2.0"];
const EXTENSIONS = ["http://synthetichealth.github.io/synthea/"];
const WORK = fileURLToPath(
  new URL("../../../build/validator/", import.meta.url),
);

/** A token for `patient` at `hospital`, signed in through its own authorize and token endpoints. */
async function tokenFor(hospital, patients, patient) {
  const redirect = "https://app.example/callback";
  const verifier =
    "a-verifier-long-enough-to-be-a-real-pkce-code-verifier-0123";
  const serve = demoHospital({ hospital, patients, autoApprove: patient });
  const base = hospital.fhirBase;
  const back = await serve(
    new Request(
      `${base}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: "validator",
        redirect_uri: redirect,
        scope: "launch/patient patient/*.rs",
        aud: base,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      })}`,
    ),
  );
  const code = new URL(back.headers.get("Location")).searchParams.get("code");
  const answer = await serve(
    new Request(`${base}/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: "validator",
        code_verifier: verifier,
      }),
    }),
  );
  return [serve, (await answer.json()).access_token];
}

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
    const [first] = Object.keys(patients);
    const [serve, token] = await tokenFor(hospital, patients, first);
    for (const path of [
      `Observation?patient=${first}`,
      `Patient/${first}/_history`,
    ]) {
      const served = await serve(
        new Request(`${hospital.fhirBase}/${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      yield [
        `${at}__served__${path.replace(/[^A-Za-z0-9]+/g, "-")}.json`,
        await served.json(),
      ];
    }
    for (const [patient, bundle] of Object.entries(patients)) {
      const base = hospital.fhirBase.replace(/\/$/, "");
      const all = versionsOf(bundle, patient);
      // The validator cannot resolve a reference to a record that has two entries, so the whole file is
      // checked with each record's newest version; every version is checked on its own below.
      const newest = new Map(
        [...all].map(([record, versions]) => [
          record,
          versions.at(-1).versionId,
        ]),
      );
      yield [
        `${at}__${patient}.json`,
        {
          ...bundle,
          entry: bundle.entry
            .filter(
              ({ resource }) =>
                !resource ||
                newest.get(`${resource.resourceType}/${resource.id}`) ===
                  (resource.meta?.versionId ?? "1"),
            )
            .map((entry) =>
              entry.fullUrl || !entry.resource
                ? entry
                : {
                    fullUrl: `${base}/${entry.resource.resourceType}/${entry.resource.id}`,
                    ...entry,
                  },
            ),
        },
      ];
      for (const versions of all.values()) {
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
    ...EXTENSIONS.map((extension) => `-extension ${extension}`),
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
