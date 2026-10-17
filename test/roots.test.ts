import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HospitalDataError, type Resource } from "../src/index.js";
import { historyEntry } from "../src/history.js";
import {
  addPatient,
  DEFAULT_ROOTS,
  loadHospital,
  loadHospitals,
  type Roots,
  VOCABULARY_PEOPLE,
} from "../src/node/index.js";

const work = await mkdtemp(join(tmpdir(), "t5-roots-"));
after(() => rm(work, { recursive: true, force: true }));

const hospitalAt = (id: string) => ({
  name: `${id} test hospital`,
  fhirBase: `https://${id}.demo.invalid/fhir`,
  pageSize: 50,
  key: `${id}-test-key`,
  types: ["Patient", "MedicationStatement", "Condition"],
  hiddenFromSearch: [],
});

async function folder(parent: string, name: string, hospital: unknown) {
  const path = join(parent, name);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "hospital.json"),
    typeof hospital === "string" ? hospital : JSON.stringify(hospital),
  );
  return path;
}

const ROOT_A = join(work, "a");
const ROOT_B = join(work, "b");
const ROOT_C = join(work, "c");
const only = (...hospitals: string[]): Roots => ({ hospitals, people: [] });
const names = async (roots: Roots) =>
  (await loadHospitals(roots)).map(({ hospital }) => hospital.name);
const refusedWith = (message: string | RegExp) => (error: unknown) =>
  error instanceof HospitalDataError &&
  (typeof message === "string"
    ? error.message === message
    : message.test(error.message));

await folder(ROOT_A, "zeta", hospitalAt("zeta"));
const alpha = await folder(ROOT_A, "alpha", hospitalAt("alpha"));
await folder(ROOT_B, "mid", hospitalAt("mid"));
await folder(ROOT_C, "alpha", hospitalAt("alpha"));
await writeFile(join(ROOT_A, "stray"), "a file where a hospital folder goes");
// A hospitals root kept in git holds a `.git` folder: no hospital, and no typo to tell the person about.
await mkdir(join(ROOT_A, ".git"));
// What a hospital folder may hold that this loader does not know: a face, a note.
await mkdir(join(alpha, "faces"));
await writeFile(join(alpha, "notes.md"), "x");

test("hospitals are loaded from a list of folders, roots in order and each root's hospitals by name, and found by id", async () => {
  assert.deepEqual(
    await names(only(ROOT_B, join(work, "missing"), ROOT_A)),
    ["mid", "alpha", "zeta"].map((id) => `${id} test hospital`),
  );
  assert.deepEqual(
    await names({}),
    await names({ hospitals: DEFAULT_ROOTS.hospitals }),
  );
  assert.deepEqual(
    (await loadHospitals()).map(({ hospital }) => hospital.fhirBase),
    [
      "https://cascade-north.demo.invalid/fhir",
      "https://cascade-south.demo.invalid/fhir",
    ],
  );
  assert.equal(
    (await loadHospital("alpha", only(ROOT_A))).hospital.name,
    "alpha test hospital",
  );
  await assert.rejects(
    loadHospital("nowhere", only(ROOT_A)),
    refusedWith("hospital.json: there is no hospital nowhere"),
  );
});

test("a hospital folder is refused where its hospital.json lacks a field the hospital needs, names another id, or holds patients", async () => {
  const mine = async (
    name: string,
    hospital: unknown,
    as = "mine",
  ): Promise<Roots> => {
    const root = join(work, "mine", name);
    await folder(root, as, hospital);
    return only(root);
  };
  const ok = hospitalAt("mine");
  const withPatients = await mine("patients", ok);
  await mkdir(join(withPatients.hospitals![0]!, "mine", "patients"));
  const rows: [string, Roots, string | RegExp][] = [
    [
      "one id in two roots",
      only(ROOT_A, ROOT_C),
      "hospital.json: two hospitals at alpha",
    ],
    [
      "a base that is no demo host",
      await mine("bad", {
        ...ok,
        fhirBase: "https://hospital.example.org/fhir",
      }),
      "mine/hospital.json: mine test hospital's FHIR base is not on a demo.invalid host",
    ],
    [
      "a folder with no hospital.json",
      await (async () => {
        await mkdir(join(work, "empty", "no-hospital"), { recursive: true });
        return only(join(work, "empty"));
      })(),
      "no-hospital/hospital.json: is not there",
    ],
    [
      "a hospital.json that is no JSON",
      await mine("badjson", "{ nope"),
      /^mine\/hospital\.json: is not JSON: /,
    ],
    [
      "a hospital.json that is a list",
      await mine("list", []),
      "mine/hospital.json: is not an object",
    ],
    [
      "no fhirBase",
      await mine("nobase", { ...ok, fhirBase: null }),
      "mine/hospital.json: has no fhirBase, a string",
    ],
    [
      "no types",
      await mine("notypes", { ...ok, types: undefined }),
      "mine/hospital.json: has no types, a list of strings",
    ],
    [
      "a page size of no whole number",
      await mine("pagesize", { ...ok, pageSize: 0.5 }),
      "mine/hospital.json: has no pageSize, a whole number of 1 or more",
    ],
    [
      "no page size",
      await mine("nopagesize", { ...ok, pageSize: undefined }),
      "mine/hospital.json: has no pageSize, a whole number of 1 or more",
    ],
    [
      "an empty key",
      await mine("key", { ...ok, key: "" }),
      "mine/hospital.json: has no key, a string",
    ],
    [
      "no hiddenFromSearch",
      await mine("hidden", { ...ok, hiddenFromSearch: undefined }),
      "mine/hospital.json: has no hiddenFromSearch, a list of strings",
    ],
    [
      "a colour that is no string",
      await mine("colour", { ...ok, colour: 7 }),
      "mine/hospital.json: has a colour that is not a string",
    ],
    [
      "places that are no strings",
      await mine("places", { ...ok, places: "Bellingham, WA" }),
      "mine/hospital.json: has places that are not a list of strings",
    ],
    [
      "a folder named for another id",
      await mine("other", ok, "other"),
      "other/hospital.json: has the folder name other, but its fhirBase names mine",
    ],
    [
      "a hospital folder holding patients",
      withPatients,
      "mine: holds patients/: a hospital is its settings, and its patients are people/<person>/sources/mine/fhir.json",
    ],
  ];
  for (const [name, roots, message] of rows)
    await assert.rejects(loadHospitals(roots), refusedWith(message), name);
});

const HEDDA = {
  id: "hedda-quill",
  name: { family: "Quill", given: ["Hedda"] },
  birthDate: "1971-05-02",
  gender: "female",
};
const patient = (fields: Record<string, unknown> = {}): Resource => ({
  resourceType: "Patient",
  id: "hq-1",
  name: [{ use: "official", family: "Quill", given: ["Hedda"] }],
  birthDate: HEDDA.birthDate,
  gender: HEDDA.gender,
  ...fields,
});
const collection = (...resources: Resource[]) => ({
  resourceType: "Bundle",
  type: "collection",
  entry: resources.map((resource) => ({ resource })),
});
const AT = "https://mine.demo.invalid/fhir";
const HOSPITALS = join(work, "identity", "hospitals");
await folder(HOSPITALS, "mine", hospitalAt("mine"));

/**
 * A people root holding one person folder, `person.json` and each source as given: a name is its `fhir.json`, a path
 * with a `/` is that file under `sources/`, and `null` an empty folder. A string is written as it is.
 */
async function people(
  name: string,
  person: unknown,
  sources: Record<string, unknown> = { mine: collection(patient()) },
  at = "hedda-quill",
): Promise<string> {
  const root = join(work, "identity", name);
  const write = async (path: string, body: unknown) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      typeof body === "string" ? body : JSON.stringify(body),
    );
  };
  if (person !== undefined) await write(join(root, at, "person.json"), person);
  for (const [source, bundle] of Object.entries(sources)) {
    const path = join(root, at, "sources", ...source.split("/"));
    if (bundle === null) await mkdir(path, { recursive: true });
    else
      await write(
        source.includes("/") ? path : join(path, "fhir.json"),
        bundle,
      );
  }
  return root;
}

test("each source's Patient agrees with its person on name, birth date and gender, every version of it, but where the person declares a difference, which a C-CDA source or a kit download may show instead", async () => {
  const declared = (source: string) => ({
    source,
    field: "name",
    value: { family: "Natarajan", given: ["Pria"] },
    reason: "The clinic misspelled her name.",
    expectedMatch: "probable",
  });
  const priya = {
    id: "priya-natarajan",
    name: { family: "Natarajan", given: ["Priya"] },
    birthDate: "1968-11-04",
    gender: "female",
  };
  const roots = {
    hospitals: [HOSPITALS],
    people: [
      await people(
        "agreeing",
        {
          ...HEDDA,
          differences: [
            {
              source: "mine",
              field: "name",
              value: { family: "Quill", given: ["Hedy"] },
              reason: "The hospital wrote the name she goes by.",
              expectedMatch: "probable",
            },
          ],
        },
        {
          mine: {
            resourceType: "Bundle",
            type: "history",
            entry: [
              historyEntry(
                patient({
                  name: [
                    { use: "maiden", family: "Lark", given: ["Hedda"] },
                    { use: "official", family: "Quill", given: ["Hedy"] },
                  ],
                  gender: undefined,
                }),
                "1",
                "2020-01-01T00:00:00Z",
              ),
              historyEntry(
                patient({
                  name: [{ family: "Quill", given: ["Hedy"] }],
                }),
                "2",
                "2021-01-01T00:00:00Z",
              ),
            ],
          },
        },
      ),
      await people(
        "kit",
        {
          ...priya,
          kit: "conformance/priya-natarajan",
          differences: [declared("hospital-b")],
        },
        {},
        "priya-natarajan",
      ),
      await people(
        "ccda",
        { ...priya, id: "priya-ccda", differences: [declared("mine")] },
        {
          mine: collection(
            patient({
              id: "pn-1",
              name: [{ family: "Natarajan", given: ["Priya"] }],
              birthDate: priya.birthDate,
            }),
          ),
          "mine/ccda/2025-02-01.xml": "<ClinicalDocument/>",
        },
        "priya-ccda",
      ),
    ],
  };
  assert.deepEqual(Object.keys((await loadHospital("mine", roots)).patients), [
    "hq-1",
    "pn-1",
  ]);
});

test("a person is refused where a source disagrees with them, or a declared difference does not show, or person.json or a source is malformed", async () => {
  const where = "hedda-quill/sources/mine/fhir.json";
  const rows: [string, string[], string | RegExp][] = [
    [
      "a name that differs",
      [
        await people("name", HEDDA, {
          mine: collection(
            patient({
              name: [{ use: "official", family: "Quil", given: ["Hedda"] }],
            }),
          ),
        }),
      ],
      `${where}: Patient hq-1 says name Hedda Quil, person.json says Hedda Quill`,
    ],
    [
      "given names in another order",
      [
        await people(
          "given",
          { ...HEDDA, name: { family: "Quill", given: ["Hedda", "Rue"] } },
          {
            mine: collection(
              patient({ name: [{ family: "Quill", given: ["Rue", "Hedda"] }] }),
            ),
          },
        ),
      ],
      `${where}: Patient hq-1 says name Rue Hedda Quill, person.json says Hedda Rue Quill`,
    ],
    [
      "a birth date that differs",
      [
        await people("birth", HEDDA, {
          mine: collection(patient({ birthDate: "1971-05-03" })),
        }),
      ],
      `${where}: Patient hq-1 says birthDate 1971-05-03, person.json says 1971-05-02`,
    ],
    [
      "a gender that differs in a later version",
      [
        await people("gender", HEDDA, {
          mine: {
            resourceType: "Bundle",
            type: "history",
            entry: [
              historyEntry(patient(), "1", "2020-01-01T00:00:00Z"),
              historyEntry(
                patient({ gender: "male" }),
                "2",
                "2021-01-01T00:00:00Z",
              ),
            ],
          },
        }),
      ],
      `${where}: Patient hq-1 says gender male, person.json says female`,
    ],
    [
      "a declared difference the Patient does not show",
      [
        await people("declared", {
          ...HEDDA,
          differences: [
            {
              source: "mine",
              field: "birthDate",
              value: "1971-05-03",
              reason: "A typing slip at the desk.",
              expectedMatch: "probable",
            },
          ],
        }),
      ],
      "hedda-quill/person.json: declares a difference in birthDate at mine that its Patient does not show",
    ],
    [
      "a declared difference at a source the person has nowhere",
      [
        await people("nowhere", {
          ...HEDDA,
          differences: [
            {
              source: "cascade-west",
              field: "birthDate",
              value: "1971-05-03",
              reason: "A typing slip at the desk.",
              expectedMatch: "probable",
            },
          ],
        }),
      ],
      "hedda-quill/person.json: declares a difference in birthDate at cascade-west, where hedda-quill has no source",
    ],
    [
      "a fhir.json named in another case",
      [
        await people("case", HEDDA, {
          "mine/Fhir.json": collection(patient()),
        }),
      ],
      "hedda-quill/sources/mine/Fhir.json: is not a source file: a source holds fhir.json and ccda/<day>.xml",
    ],
    [
      "a stray file beside a source's fhir.json",
      [
        await people("stray", HEDDA, {
          mine: collection(patient()),
          "mine/notes.txt": "x",
        }),
      ],
      "hedda-quill/sources/mine/notes.txt: is not a source file: a source holds fhir.json and ccda/<day>.xml",
    ],
    [
      "an empty source folder",
      [await people("empty", HEDDA, { mine: null })],
      "hedda-quill/sources/mine: holds no source file: a source holds fhir.json and ccda/<day>.xml",
    ],
    [
      "no person.json",
      [await people("absent", undefined)],
      "hedda-quill/person.json: is not there",
    ],
    [
      "a person.json that is no JSON",
      [await people("badjson", "{")],
      /^hedda-quill\/person\.json: is not JSON: /,
    ],
    [
      "no id",
      [await people("noid", { ...HEDDA, id: undefined })],
      "hedda-quill/person.json: has no id, a name of lower-case letters and digits joined by -",
    ],
    [
      "no name",
      [await people("noname", { ...HEDDA, name: { family: "Quill" } })],
      "hedda-quill/person.json: has no name, an object of family, a string, and given, a list of one or more strings",
    ],
    [
      "no birth date",
      [await people("nobirth", { ...HEDDA, birthDate: "2 May 1971" })],
      "hedda-quill/person.json: has no birthDate, a date as YYYY-MM-DD",
    ],
    [
      "no gender",
      [await people("nogender", { ...HEDDA, gender: "F" })],
      "hedda-quill/person.json: has no gender, male, female, other or unknown",
    ],
    [
      "an id that is not the folder's",
      [await people("id", { ...HEDDA, id: "hedda" })],
      "hedda-quill/person.json: has the id hedda, but its folder is hedda-quill",
    ],
    [
      "a source with no Patient",
      [
        await people("nopatient", HEDDA, {
          mine: collection({ resourceType: "Condition", id: "c" }),
        }),
      ],
      `${where}: holds no Patient`,
    ],
    [
      "a source with two Patients",
      [
        await people("twopatients", HEDDA, {
          mine: collection(patient(), patient({ id: "hq-2" })),
        }),
      ],
      `${where}: holds 2 Patients: a source holds one`,
    ],
    [
      "a source at no hospital",
      [
        await people("nohospital", HEDDA, {
          elsewhere: collection(patient()),
        }),
      ],
      "hedda-quill/sources/elsewhere: there is no hospital elsewhere",
    ],
    [
      "one person in two roots",
      [await people("one", HEDDA, {}), await people("two", HEDDA, {})],
      "people: two people at hedda-quill",
    ],
    [
      "one Patient id held by two people at one hospital",
      [
        await people("first", HEDDA),
        await people(
          "second",
          { ...HEDDA, id: "lark-thorne" },
          {
            mine: collection(
              patient({ name: [{ family: "Quill", given: ["Hedda"] }] }),
            ),
          },
          "lark-thorne",
        ),
      ],
      "lark-thorne/sources/mine/fhir.json: holds Patient hq-1, which hedda-quill holds at mine too",
    ],
    [
      "a record of a fullUrl at another base",
      [
        await people("fullurl", HEDDA, {
          mine: {
            resourceType: "Bundle",
            type: "collection",
            entry: [
              {
                fullUrl: "https://elsewhere.example/Patient/hq-1",
                resource: patient(),
              },
            ],
          },
        }),
      ],
      `${where}: fullUrl https://elsewhere.example/Patient/hq-1 is not ${AT}/Patient/hq-1`,
    ],
  ];
  for (const [name, roots, message] of rows)
    await assert.rejects(
      loadHospitals({ hospitals: [HOSPITALS], people: roots }),
      refusedWith(message),
      name,
    );
});

const APP = join(work, "app");
for (const id of ["alpha", "zeta", "yon"])
  await folder(join(APP, "hospitals"), id, hospitalAt(id));
const APP_ROOTS = {
  hospitals: [...DEFAULT_ROOTS.hospitals, join(APP, "hospitals")],
  people: [...DEFAULT_ROOTS.people, join(APP, "people")],
};
const PERSON = {
  resourceType: "Patient",
  id: "hedda-quill",
  name: [{ family: "Quill", given: ["Hedda"] }],
  birthDate: HEDDA.birthDate,
  gender: HEDDA.gender,
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

test("a patient file is checked against the app's hospital and people and written once as a source of its person, a shorthand file compiled first", async () => {
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
    APP,
    "alpha",
    await write("hedda.json", authoring),
  );
  assert.equal(
    written,
    join(APP, "people", "hedda-quill", "sources", "alpha", "fhir.json"),
  );
  const at = await loadHospital("alpha", APP_ROOTS);
  assert.deepEqual(Object.keys(at.patients), ["hedda-quill"]);
  assert.equal(at.patients["hedda-quill"]?.type, "history");
  assert.equal(at.patients["hedda-quill"]?.entry?.length, 3);
  const personFile = join(APP, "people", "hedda-quill", "person.json");
  assert.deepEqual(JSON.parse(await readFile(personFile, "utf8")), HEDDA);

  const plain = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      {
        resource: {
          ...PERSON,
          name: [{ use: "official", family: "Quill", given: ["Hedda"] }],
        },
      },
    ],
  };
  await addPatient(APP, "zeta", await write("plain.json", plain));
  assert.equal(
    (await loadHospital("zeta", APP_ROOTS)).patients["hedda-quill"]?.type,
    "collection",
  );
  assert.deepEqual(JSON.parse(await readFile(personFile, "utf8")), HEDDA);

  const rue = (given: string) =>
    collection(
      patient({ id: "rue-hale", name: [{ family: "Hale", given: [given] }] }),
    );
  await mkdir(join(APP, "people", "rue-hale", "sources", "alpha"), {
    recursive: true,
  });
  await writeFile(
    join(APP, "people", "rue-hale", "person.json"),
    JSON.stringify({
      ...HEDDA,
      id: "rue-hale",
      name: { family: "Hale", given: ["Rue"] },
      differences: [
        {
          source: "alpha",
          field: "name",
          value: { family: "Hale", given: ["Ru"] },
          reason: "The desk wrote the name she signs with.",
          expectedMatch: "probable",
        },
      ],
    }),
  );
  await writeFile(
    join(APP, "people", "rue-hale", "sources", "alpha", "fhir.json"),
    JSON.stringify(rue("Ru")),
  );
  await addPatient(APP, "zeta", await write("rue.json", rue("Rue")));

  const one = (id: string, ...more: Resource[]) => ({
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: { ...PERSON, id } },
      ...more.map((resource) => ({ resource })),
    ],
  });
  const rows: [string, string, string, string][] = [
    [
      "the same patient again",
      "alpha",
      await write("again.json", authoring),
      "hedda-quill/sources/alpha/fhir.json: is already at this hospital: remove it first, or give the patient another id",
    ],
    [
      "a patient who disagrees with the person already there",
      "yon",
      await write("older.json", {
        ...one("hedda-quill"),
        entry: [{ resource: { ...PERSON, birthDate: "1961-05-02" } }],
      }),
      "hedda-quill/sources/yon/fhir.json: Patient hedda-quill says birthDate 1961-05-02, person.json says 1971-05-02",
    ],
    [
      "a hospital the app does not have",
      "nowhere",
      await write("nowhere.json", one("wren-abbot")),
      "hospital.json: there is no hospital nowhere",
    ],
    [
      "a file that is no JSON",
      "alpha",
      await write("broken.json", "{"),
      "broken.json: is not JSON",
    ],
    [
      "a file with no Patient",
      "alpha",
      await write("none.json", {
        resourceType: "Bundle",
        type: "collection",
        entry: [{ resource: { resourceType: "Condition", id: "c" } }],
      }),
      "none.json: holds no Patient",
    ],
    [
      "a record the hospital does not serve",
      "alpha",
      await write(
        "unserved.json",
        one("unserved", { resourceType: "Observation", id: "o" }),
      ),
      "unserved/sources/alpha/fhir.json: Observation/o is an Observation, which hospital.json does not list in types",
    ],
    [
      "a Patient id that is no person's folder name",
      "alpha",
      await write("escape.json", one("../../escaped")),
      "escape.json: holds Patient ../../escaped, which is not a person's folder name: lower-case letters and digits joined by -",
    ],
    [
      "a Patient with no birth date",
      "alpha",
      await write("nobirth.json", {
        ...one("nobirth"),
        entry: [
          { resource: { ...PERSON, id: "nobirth", birthDate: undefined } },
        ],
      }),
      "nobirth.json: holds Patient nobirth with no birthDate, which its person.json needs",
    ],
    [
      "a file that is null",
      "alpha",
      await write("null.json", "null"),
      "null.json: is not an object",
    ],
    [
      "a null entry",
      "alpha",
      await write("nullentry.json", { resourceType: "Bundle", entry: [null] }),
      "nullentry.json: has an entry that is not an object, or whose resource is not",
    ],
    [
      "a null shorthand",
      "alpha",
      await write("nullshort.json", {
        resourceType: "Bundle",
        type: "collection",
        entry: [{ resource: PERSON, shorthand: null }],
      }),
      "nullshort.json: a shorthand is an object of active and stopped",
    ],
    [
      "a record another patient holds",
      "alpha",
      await write(
        "twice.json",
        one("twice", { resourceType: "MedicationStatement", id: "metformin" }),
      ),
      "twice/sources/alpha/fhir.json: MedicationStatement/metformin is in two patient files",
    ],
    [
      "a Patient id that is a person of the package",
      "zeta",
      await write("tobias.json", {
        ...one("tobias-fenn"),
        entry: [
          {
            resource: {
              resourceType: "Patient",
              id: "tobias-fenn",
              name: [{ family: "Fenn", given: ["Tobias"] }],
              birthDate: "1958-11-03",
              gender: "male",
            },
          },
        ],
      }),
      `tobias.json: holds Patient tobias-fenn, which is a person of ${VOCABULARY_PEOPLE.replace(/[\\/]$/, "")} already: give the patient another id`,
    ],
  ];
  for (const [name, hospital, source, message] of rows)
    await assert.rejects(
      addPatient(APP, hospital, source),
      refusedWith(message),
      name,
    );
  assert.deepEqual(
    (await loadHospitals(APP_ROOTS)).map(
      ({ patients }) => Object.keys(patients).length,
    ),
    [9, 3, 2, 0, 2],
  );
});
