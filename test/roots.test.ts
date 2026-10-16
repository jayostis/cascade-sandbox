import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HospitalDataError } from "../src/index.js";
import {
  addPatient,
  DATA_FOLDER,
  loadHospital,
  loadHospitals,
} from "../src/node/index.js";

const work = await mkdtemp(join(tmpdir(), "t362-roots-"));
after(() => rm(work, { recursive: true, force: true }));

const hospitalAt = (id: string) => ({
  name: `${id} test hospital`,
  fhirBase: `https://${id}.demo.invalid/fhir`,
  pageSize: 50,
  key: `${id}-test-key`,
  types: ["Patient", "MedicationStatement", "Condition"],
  hiddenFromSearch: [],
});

async function folder(parent: string, name: string, id = name) {
  const path = join(parent, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "hospital.json"), JSON.stringify(hospitalAt(id)));
  return path;
}

const ROOT_A = join(work, "a");
const ROOT_B = join(work, "b");
const ROOT_C = join(work, "c");
const names = async (roots: string[]) =>
  (await loadHospitals(roots)).map(({ hospital }) => hospital.name);

await folder(ROOT_A, "zeta");
const alpha = await folder(ROOT_A, "alpha");
await folder(ROOT_B, "mid");
await folder(ROOT_C, "again", "alpha");
await writeFile(join(ROOT_A, "stray"), "a file where a hospital folder goes");
// What a hospital folder may hold that this loader does not know: a face, a note, a folder named like a patient file.
await mkdir(join(alpha, "faces"));
await writeFile(join(alpha, "notes.md"), "x");
await mkdir(join(alpha, "patients", "folder.json"), { recursive: true });
await writeFile(join(alpha, "patients", "notes.txt"), "x");

test("hospitals are loaded from a list of folders, roots in order and each root's hospitals by name", async () => {
  assert.deepEqual(
    await names([ROOT_B, join(work, "missing"), ROOT_A]),
    ["mid", "alpha", "zeta"].map((id) => `${id} test hospital`),
  );
  assert.deepEqual(
    (await loadHospitals()).map(({ hospital }) => hospital.name),
    (await loadHospitals([DATA_FOLDER])).map(({ hospital }) => hospital.name),
  );
  assert.deepEqual(
    (await loadHospitals()).map(({ hospital }) => hospital.fhirBase),
    [
      "https://cascade-north.demo.invalid/fhir",
      "https://cascade-south.demo.invalid/fhir",
    ],
  );
  assert.equal(
    (await loadHospital(alpha)).hospital.name,
    "alpha test hospital",
  );
});

test("a list of folders is refused where two hospitals share an id or one is not a demo hospital", async () => {
  const bad = join(work, "bad");
  await folder(bad, "somewhere", "somewhere");
  await writeFile(
    join(bad, "somewhere", "hospital.json"),
    JSON.stringify({
      ...hospitalAt("somewhere"),
      fhirBase: "https://hospital.example.org/fhir",
    }),
  );
  await mkdir(join(work, "empty", "no-hospital"), { recursive: true });
  const mine = async (
    name: string,
    hospital: string | undefined,
    patient?: string,
  ) => {
    const root = join(work, "mine", name);
    await mkdir(join(root, "mine", "patients"), { recursive: true });
    if (hospital !== undefined)
      await writeFile(join(root, "mine", "hospital.json"), hospital);
    if (patient !== undefined)
      await writeFile(join(root, "mine", "patients", "p1.json"), patient);
    return [root];
  };
  const ok = JSON.stringify(hospitalAt("mine"));
  const noFhirBase = JSON.stringify({ ...hospitalAt("mine"), fhirBase: null });
  const notJson = /^mine\/(hospital|patients\/p1)\.json: is not JSON: /;
  const rows: [string, string[], string | RegExp][] = [
    [
      "one id in two roots",
      [ROOT_A, ROOT_C],
      "hospital.json: two hospitals at alpha",
    ],
    [
      "a base that is no demo host",
      [bad],
      "somewhere/hospital.json: somewhere test hospital's FHIR base is not on a demo.invalid host",
    ],
    [
      "a folder with no hospital.json",
      [join(work, "empty")],
      "no-hospital/hospital.json: is not there",
    ],
    [
      "a hospital.json that is no JSON",
      await mine("badjson", "{ nope"),
      notJson,
    ],
    [
      "a hospital.json with no fhirBase",
      await mine("nobase", noFhirBase),
      "mine/hospital.json: has no fhirBase, a string",
    ],
    [
      "a hospital.json with no types",
      await mine(
        "notypes",
        JSON.stringify({ ...hospitalAt("mine"), types: undefined }),
      ),
      "mine/hospital.json: has no types, a list of strings",
    ],
    [
      "a hospital.json that is a list",
      await mine("list", "[]"),
      "mine/hospital.json: is not an object",
    ],
    [
      "a patient file that is no JSON",
      await mine("badpatient", ok, "{"),
      notJson,
    ],
    [
      "a patient file that is null",
      await mine("nullpatient", ok, "null"),
      "mine/patients/p1.json: is not an object",
    ],
    [
      "a patient file with a null entry",
      await mine("nullentry", ok, '{"entry":[null]}'),
      "mine/patients/p1.json: has an entry that is not an object, or whose resource is not",
    ],
  ];
  for (const [name, roots, message] of rows)
    await assert.rejects(
      loadHospitals(roots),
      (error) =>
        error instanceof HospitalDataError &&
        (typeof message === "string"
          ? error.message === message
          : message.test(error.message)),
      name,
    );
});

const PERSON = {
  resourceType: "Patient",
  id: "tamsin",
  name: [{ family: "Vale", given: ["Tamsin"] }],
};
const authoring = {
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { resource: PERSON },
    {
      resource: {
        resourceType: "MedicationStatement",
        id: "metformin",
        status: "active",
      },
      shorthand: { active: "2022-03-01", stopped: "2024-04-15" },
    },
  ],
};

test("a patient file is checked against the hospital and written once, a shorthand file compiled first", async () => {
  const sources = join(work, "sources");
  await mkdir(sources);
  const write = async (name: string, body: unknown) => {
    const path = join(sources, name);
    await writeFile(
      path,
      typeof body === "string" ? body : JSON.stringify(body),
    );
    return path;
  };
  const written = await addPatient(
    alpha,
    await write("tamsin.json", authoring),
  );
  assert.ok(written.endsWith(join("patients", "tamsin.json")));
  const { patients } = await loadHospital(alpha);
  assert.equal(Object.keys(patients).join(), "tamsin");
  assert.equal(patients.tamsin?.type, "history");
  assert.equal(patients.tamsin?.entry?.length, 3);

  const plain = {
    resourceType: "Bundle",
    type: "collection",
    entry: [{ resource: { ...PERSON, id: "plain" } }],
  };
  await addPatient(alpha, await write("plain.json", plain));
  assert.equal((await loadHospital(alpha)).patients.plain?.type, "collection");
  assert.deepEqual((await readdir(join(alpha, "patients"))).sort(), [
    "folder.json",
    "notes.txt",
    "plain.json",
    "tamsin.json",
  ]);

  const rows: [string, string, string][] = [
    [
      "the same patient again",
      await write("again.json", authoring),
      "patients/tamsin.json: is already in this hospital: remove it first, or give the patient another id",
    ],
    [
      "a file that is no JSON",
      await write("broken.json", "{"),
      "broken.json: is not JSON",
    ],
    [
      "a file with no Patient",
      await write("none.json", {
        resourceType: "Bundle",
        type: "collection",
        entry: [{ resource: { resourceType: "Condition", id: "c" } }],
      }),
      "none.json: holds no Patient",
    ],
    [
      "a record the hospital does not serve",
      await write("unserved.json", {
        resourceType: "Bundle",
        type: "collection",
        entry: [
          { resource: { ...PERSON, id: "unserved" } },
          { resource: { resourceType: "Observation", id: "o" } },
        ],
      }),
      "patients/unserved.json: Observation/o is an Observation, which hospital.json does not list in types",
    ],
    [
      "a Patient id that is no FHIR id",
      await write("escape.json", {
        resourceType: "Bundle",
        type: "collection",
        entry: [{ resource: { ...PERSON, id: "../../escaped" } }],
      }),
      "escape.json: holds Patient ../../escaped, which is not a FHIR id",
    ],
    [
      "a file that is null",
      await write("null.json", "null"),
      "null.json: is not an object",
    ],
    [
      "a null entry",
      await write("nullentry.json", { resourceType: "Bundle", entry: [null] }),
      "nullentry.json: has an entry that is not an object, or whose resource is not",
    ],
    [
      "a null shorthand",
      await write("nullshort.json", {
        resourceType: "Bundle",
        type: "collection",
        entry: [{ resource: PERSON, shorthand: null }],
      }),
      "nullshort.json: a shorthand is an object of active and stopped",
    ],
    [
      "a record another patient holds",
      await write("twice.json", {
        resourceType: "Bundle",
        type: "collection",
        entry: [
          { resource: { ...PERSON, id: "twice" } },
          {
            resource: {
              resourceType: "MedicationStatement",
              id: "metformin",
            },
          },
        ],
      }),
      "patients/twice.json: MedicationStatement/metformin is in two patient files",
    ],
  ];
  for (const [name, source, message] of rows)
    await assert.rejects(
      addPatient(alpha, source),
      (error) =>
        error instanceof HospitalDataError && error.message === message,
      name,
    );
  assert.equal(Object.keys((await loadHospital(alpha)).patients).length, 2);
});
