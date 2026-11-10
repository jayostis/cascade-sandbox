import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { HospitalDataError, type Resource } from "../src/index.js";
import { historyEntry } from "../src/history.js";
import {
  addPatient,
  DEFAULT_ROOTS,
  loadHospital,
  loadHospitals,
  loadStories,
  type Roots,
  VOCABULARY_PEOPLE,
} from "../src/node/index.js";

let work: string;
before(async () => {
  work = await mkdtemp(join(tmpdir(), "t5-roots-"));
});
after(() => rm(work, { recursive: true, force: true }));

/** A new empty folder under the file's temporary one: each leaf builds what it reads in its own. */
const fresh = () => mkdtemp(join(work, "r-"));

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

/** A new hospitals root holding a folder for each id, with the settings of a test hospital. */
async function hospitalsRoot(...ids: string[]): Promise<string> {
  const root = await fresh();
  for (const id of ids) await folder(root, id, hospitalAt(id));
  return root;
}

const only = (...hospitals: string[]): Roots => ({ hospitals, people: [] });
const names = async (roots: Roots) =>
  (await loadHospitals(roots)).map(({ hospital }) => hospital.name);
const refusedWith = (message: string | RegExp) => (error: unknown) =>
  error instanceof HospitalDataError &&
  (typeof message === "string"
    ? error.message === message
    : message.test(error.message));

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
const history = (...versions: Resource[]) => ({
  resourceType: "Bundle",
  type: "history",
  entry: versions.map((version, at) =>
    historyEntry(version, String(at + 1), `${2020 + at}-01-01T00:00:00Z`),
  ),
});
const AT = "https://mine.demo.invalid/fhir";

/**
 * A new people root holding one person folder, `person.json` and each source as given: a name is its `fhir.json`, a
 * path with a `/` is that file under `sources/`, and `null` an empty folder. A string is written as it is.
 */
async function personRoot(
  person: unknown,
  sources: Record<string, unknown> = { mine: collection(patient()) },
  at = "hedda-quill",
): Promise<string> {
  const root = await fresh();
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

/**
 * An app keeps hospitals and people of its own in folders laid out as this package's are, the roots, and loads them
 * beside the package's or in place of them. Every load checks each person's sources against who the person is, and
 * refuses what disagrees with a `HospitalDataError`.
 */
describe("Loading hospitals and people from an app's own folders · loadHospitals(), loadHospital(), loadStories()", () => {
  describe("loadHospitals(roots)", () => {
    let rootA: string;
    let rootB: string;
    let missing: string;
    before(async () => {
      rootA = await hospitalsRoot("zeta", "alpha");
      rootB = await hospitalsRoot("mid");
      missing = join(work, "missing");
      await writeFile(
        join(rootA, "stray"),
        "a file where a hospital folder goes",
      );
      // A hospitals root kept in git holds a `.git` folder: no hospital, and no typo to tell the person about.
      await mkdir(join(rootA, ".git"));
      // What a hospital folder may hold that this loader does not know: a face, a note.
      await mkdir(join(rootA, "alpha", "faces"));
      await writeFile(join(rootA, "alpha", "notes.md"), "x");
    });

    it("returns the hospitals root by root, each root's in order of folder name", async () => {
      assert.deepEqual(
        await names(only(rootB, missing, rootA)),
        ["mid", "alpha", "zeta"].map((id) => `${id} test hospital`),
      );
    });

    it("skips a root that is not a folder", async () => {
      assert.deepEqual(await loadHospitals(only(missing)), []);
    });

    it("skips a file and a dot-folder beside the hospital folders", async () => {
      assert.deepEqual(
        await names(only(rootA)),
        ["alpha", "zeta"].map((id) => `${id} test hospital`),
      );
    });

    it("ignores what a hospital folder holds beside its `hospital.json`", async () => {
      assert.deepEqual((await readdir(join(rootA, "alpha"))).sort(), [
        "faces",
        "hospital.json",
        "notes.md",
      ]);
      assert.ok((await names(only(rootA))).includes("alpha test hospital"));
    });

    it("returns the package's two hospitals when no roots are given", async () => {
      assert.deepEqual(
        (await loadHospitals()).map(({ hospital }) => hospital.fhirBase),
        [
          "https://cascade-north.demo.invalid/fhir",
          "https://cascade-south.demo.invalid/fhir",
        ],
      );
    });
  });

  describe("loadHospital(id, roots)", () => {
    let roots: Roots;
    before(async () => {
      roots = only(await hospitalsRoot("alpha", "zeta"));
    });

    it("returns the hospital of that id", async () => {
      assert.equal(
        (await loadHospital("alpha", roots)).hospital.name,
        "alpha test hospital",
      );
    });

    it("throws `HospitalDataError` for an id no root holds", async () => {
      await assert.rejects(
        loadHospital("nowhere", roots),
        refusedWith("hospital.json: there is no hospital nowhere"),
      );
    });
  });

  describe("when a hospital folder is refused", () => {
    const ok = hospitalAt("mine");
    /** The roots of one hospital folder, named `as`, holding `hospital`. */
    const mine = async (hospital: unknown, as = "mine"): Promise<Roots> => {
      const root = await fresh();
      await folder(root, as, hospital);
      return only(root);
    };
    /** Each row: the roots it loads (one example for each), and the refusal. */
    const ROWS: [string, (() => Promise<Roots>)[], string | RegExp][] = [
      [
        "refuses one id held by two roots",
        [
          async () =>
            only(await hospitalsRoot("alpha"), await hospitalsRoot("alpha")),
        ],
        "hospital.json: two hospitals at alpha",
      ],
      [
        "refuses a FHIR base that is on no demo host",
        [() => mine({ ...ok, fhirBase: "https://hospital.example.org/fhir" })],
        "mine/hospital.json: mine test hospital's FHIR base is not on a demo.invalid host",
      ],
      [
        "refuses a folder with no `hospital.json`",
        [
          async () => {
            const root = await fresh();
            await mkdir(join(root, "no-hospital"));
            return only(root);
          },
        ],
        "no-hospital/hospital.json: is not there",
      ],
      [
        "refuses a `hospital.json` that is not JSON",
        [() => mine("{ nope")],
        /^mine\/hospital\.json: is not JSON: /,
      ],
      [
        "refuses a `hospital.json` that is not an object",
        [() => mine([])],
        "mine/hospital.json: is not an object",
      ],
      [
        "refuses a `hospital.json` with no `name`",
        [() => mine({ ...ok, name: undefined })],
        "mine/hospital.json: has no name, a string",
      ],
      [
        "refuses a `hospital.json` with no `fhirBase`",
        [() => mine({ ...ok, fhirBase: null })],
        "mine/hospital.json: has no fhirBase, a string",
      ],
      [
        "refuses a `hospital.json` with no `types`",
        [() => mine({ ...ok, types: undefined })],
        "mine/hospital.json: has no types, a list of strings",
      ],
      [
        "refuses a `pageSize` that is not a whole number of 1 or more",
        [
          () => mine({ ...ok, pageSize: 0.5 }),
          () => mine({ ...ok, pageSize: undefined }),
        ],
        "mine/hospital.json: has no pageSize, a whole number of 1 or more",
      ],
      [
        "refuses an empty `key`",
        [() => mine({ ...ok, key: "" })],
        "mine/hospital.json: has no key, a string",
      ],
      [
        "refuses a `hospital.json` with no `hiddenFromSearch`",
        [() => mine({ ...ok, hiddenFromSearch: undefined })],
        "mine/hospital.json: has no hiddenFromSearch, a list of strings",
      ],
      [
        "refuses a `colour` that is not a string",
        [() => mine({ ...ok, colour: 7 })],
        "mine/hospital.json: has a colour that is not a string",
      ],
      [
        "refuses `places` that are not a list of strings",
        [() => mine({ ...ok, places: "Bellingham, WA" })],
        "mine/hospital.json: has places that are not a list of strings",
      ],
      [
        "refuses a folder named for another id than its FHIR base's",
        [() => mine(ok, "other")],
        "other/hospital.json: has the folder name other, but its fhirBase names mine",
      ],
      [
        "refuses a hospital folder that holds `patients/`",
        [
          async () => {
            const roots = await mine(ok);
            await mkdir(join(roots.hospitals![0]!, "mine", "patients"));
            return roots;
          },
        ],
        "mine: holds patients/: a hospital is its settings, and its patients are people/<person>/sources/mine/fhir.json",
      ],
    ];
    for (const [title, builds, message] of ROWS)
      it(title, async () => {
        for (const build of builds)
          await assert.rejects(
            loadHospitals(await build()),
            refusedWith(message),
          );
      });
  });

  describe("given a person's sources", () => {
    let hospitals: string;
    before(async () => {
      hospitals = await hospitalsRoot("mine");
    });
    const at = (people: string): Roots => ({
      hospitals: [hospitals],
      people: [people],
    });
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
    const hedy = {
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
    };

    it("compares the Patient's official name, whatever other names it carries", async () => {
      const roots = at(
        await personRoot(HEDDA, {
          mine: collection(
            patient({
              name: [
                { use: "maiden", family: "Lark", given: ["Hedda"] },
                { use: "official", family: "Quill", given: ["Hedda"] },
              ],
            }),
          ),
        }),
      );
      assert.deepEqual(
        Object.keys((await loadHospital("mine", roots)).patients),
        ["hq-1"],
      );
    });

    it("compares every version of the Patient", async () => {
      const roots = at(
        await personRoot(HEDDA, {
          mine: history(patient(), patient({ birthDate: HEDDA.birthDate })),
        }),
      );
      assert.deepEqual(
        Object.keys((await loadHospital("mine", roots)).patients),
        ["hq-1"],
      );
    });

    it("skips a field the Patient leaves out", async () => {
      const roots = at(
        await personRoot(HEDDA, {
          mine: collection(patient({ gender: undefined })),
        }),
      );
      assert.deepEqual(
        Object.keys((await loadHospital("mine", roots)).patients),
        ["hq-1"],
      );
    });

    it("accepts a difference the person declares, where a version of the Patient shows it", async () => {
      const roots = at(
        await personRoot(hedy, {
          mine: history(
            patient({
              name: [{ use: "official", family: "Quill", given: ["Hedy"] }],
            }),
          ),
        }),
      );
      assert.deepEqual(
        Object.keys((await loadHospital("mine", roots)).patients),
        ["hq-1"],
      );
    });

    it("accepts a difference declared at a source that also holds a C-CDA document", async () => {
      const roots = at(
        await personRoot(
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
      );
      assert.deepEqual(
        Object.keys((await loadHospital("mine", roots)).patients),
        ["pn-1"],
      );
    });

    it("accepts a difference declared for a kit person at a source they have no folder for", async () => {
      const roots = at(
        await personRoot(
          {
            ...priya,
            kit: "conformance/priya-natarajan",
            differences: [declared("hospital-b")],
          },
          {},
          "priya-natarajan",
        ),
      );
      assert.deepEqual(
        Object.keys((await loadHospital("mine", roots)).patients),
        [],
      );
    });
  });

  describe("when a person is refused", () => {
    let hospitals: string;
    before(async () => {
      hospitals = await hospitalsRoot("mine");
    });
    const where = "hedda-quill/sources/mine/fhir.json";
    const slip = (source: string) => ({
      ...HEDDA,
      differences: [
        {
          source,
          field: "birthDate",
          value: "1971-05-03",
          reason: "A typing slip at the desk.",
          expectedMatch: "probable",
        },
      ],
    });
    /** Each row: the people roots it loads, and the refusal. */
    const ROWS: [string, () => Promise<string[]>, string | RegExp][] = [
      [
        "refuses a Patient whose name differs from the person's",
        async () => [
          await personRoot(HEDDA, {
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
        "refuses given names in another order",
        async () => [
          await personRoot(
            { ...HEDDA, name: { family: "Quill", given: ["Hedda", "Rue"] } },
            {
              mine: collection(
                patient({
                  name: [{ family: "Quill", given: ["Rue", "Hedda"] }],
                }),
              ),
            },
          ),
        ],
        `${where}: Patient hq-1 says name Rue Hedda Quill, person.json says Hedda Rue Quill`,
      ],
      [
        "refuses a birth date that differs",
        async () => [
          await personRoot(HEDDA, {
            mine: collection(patient({ birthDate: "1971-05-03" })),
          }),
        ],
        `${where}: Patient hq-1 says birthDate 1971-05-03, person.json says 1971-05-02`,
      ],
      [
        "refuses a gender that differs in a later version",
        async () => [
          await personRoot(HEDDA, {
            mine: history(patient(), patient({ gender: "male" })),
          }),
        ],
        `${where}: Patient hq-1 says gender male, person.json says female`,
      ],
      [
        "refuses a declared difference the Patient does not show",
        async () => [await personRoot(slip("mine"))],
        "hedda-quill/person.json: declares a difference in birthDate at mine that its Patient does not show",
      ],
      [
        "refuses a difference declared at a source the person does not have",
        async () => [await personRoot(slip("cascade-west"))],
        "hedda-quill/person.json: declares a difference in birthDate at cascade-west, where hedda-quill has no source",
      ],
      [
        "refuses a `fhir.json` named in another case",
        async () => [
          await personRoot(HEDDA, { "mine/Fhir.json": collection(patient()) }),
        ],
        "hedda-quill/sources/mine/Fhir.json: is not a source file: a source holds fhir.json and ccda/<day>.xml",
      ],
      [
        "refuses a stray file beside a source's `fhir.json`",
        async () => [
          await personRoot(HEDDA, {
            mine: collection(patient()),
            "mine/notes.txt": "x",
          }),
        ],
        "hedda-quill/sources/mine/notes.txt: is not a source file: a source holds fhir.json and ccda/<day>.xml",
      ],
      [
        "refuses an empty source folder",
        async () => [await personRoot(HEDDA, { mine: null })],
        "hedda-quill/sources/mine: holds no source file: a source holds fhir.json and ccda/<day>.xml",
      ],
      [
        "refuses a person folder with no `person.json`",
        async () => [await personRoot(undefined)],
        "hedda-quill/person.json: is not there",
      ],
      [
        "refuses a `person.json` that is not JSON",
        async () => [await personRoot("{")],
        /^hedda-quill\/person\.json: is not JSON: /,
      ],
      [
        "refuses a `person.json` with no `id`",
        async () => [await personRoot({ ...HEDDA, id: undefined })],
        "hedda-quill/person.json: has no id, a name of lower-case letters and digits joined by -",
      ],
      [
        "refuses a `name` without family and given names",
        async () => [await personRoot({ ...HEDDA, name: { family: "Quill" } })],
        "hedda-quill/person.json: has no name, an object of family, a string, and given, a list of one or more strings",
      ],
      [
        "refuses a `birthDate` that is not `YYYY-MM-DD`",
        async () => [await personRoot({ ...HEDDA, birthDate: "2 May 1971" })],
        "hedda-quill/person.json: has no birthDate, a date as YYYY-MM-DD",
      ],
      [
        "refuses a `gender` that is not one of FHIR's four",
        async () => [await personRoot({ ...HEDDA, gender: "F" })],
        "hedda-quill/person.json: has no gender, male, female, other or unknown",
      ],
      [
        "refuses an `id` that is not the folder's name",
        async () => [await personRoot({ ...HEDDA, id: "hedda" })],
        "hedda-quill/person.json: has the id hedda, but its folder is hedda-quill",
      ],
      [
        "refuses a source with no Patient",
        async () => [
          await personRoot(HEDDA, {
            mine: collection({ resourceType: "Condition", id: "c" }),
          }),
        ],
        `${where}: holds no Patient`,
      ],
      [
        "refuses a source with two Patients",
        async () => [
          await personRoot(HEDDA, {
            mine: collection(patient(), patient({ id: "hq-2" })),
          }),
        ],
        `${where}: holds 2 Patients: a source holds one`,
      ],
      [
        "refuses a source at a hospital that is not loaded",
        async () => [
          await personRoot(HEDDA, { elsewhere: collection(patient()) }),
        ],
        "hedda-quill/sources/elsewhere: there is no hospital elsewhere",
      ],
      [
        "refuses one person held by two roots",
        async () => [await personRoot(HEDDA, {}), await personRoot(HEDDA, {})],
        "people: two people at hedda-quill",
      ],
      [
        "refuses one Patient id held by two people at a hospital",
        async () => [
          await personRoot(HEDDA),
          await personRoot(
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
        "refuses a `fullUrl` at another base than the hospital's",
        async () => [
          await personRoot(HEDDA, {
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
    for (const [title, build, message] of ROWS)
      it(title, async () => {
        await assert.rejects(
          loadHospitals({ hospitals: [hospitals], people: await build() }),
          refusedWith(message),
        );
      });
  });

  describe("loadStories(roots)", () => {
    const STORY = { hospital: "mine", story: "a story", findings: [] };
    /** A people root of hedda-quill, who has a source at `mine`, with the story file `story` as her `expected/story.json`. */
    async function storyRoot(story: unknown): Promise<string> {
      const root = await personRoot(HEDDA);
      await mkdir(join(root, "hedda-quill", "expected"));
      await writeFile(
        join(root, "hedda-quill", "expected", "story.json"),
        JSON.stringify(story),
      );
      return root;
    }

    it("returns each story with its patient's id at the story's hospital", async () => {
      const stories = await loadStories([await storyRoot(STORY)]);
      assert.equal(stories.length, 1);
      assert.equal(stories[0]?.patient, "hq-1");
      assert.equal(stories[0]?.hospital, "mine");
      assert.equal(stories[0]?.ccdaFile, undefined);
    });

    it("throws `HospitalDataError` for a hospital where the person has no source", async () => {
      await assert.rejects(
        loadStories([await storyRoot({ ...STORY, hospital: "elsewhere" })]),
        refusedWith(
          "hedda-quill/expected/story.json: names the hospital elsewhere, where hedda-quill has no source",
        ),
      );
    });

    it("throws `HospitalDataError` for a C-CDA file that is not there", async () => {
      await assert.rejects(
        loadStories([
          await storyRoot({
            ...STORY,
            ccda: "sources/mine/ccda/2025-02-01.xml",
          }),
        ]),
        refusedWith(
          "hedda-quill/expected/story.json: names sources/mine/ccda/2025-02-01.xml, which is not there",
        ),
      );
    });
  });
});

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
/** A file of one Patient `id`, and the records given. */
const one = (id: string, ...more: Resource[]) => ({
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { resource: { ...PERSON, id } },
    ...more.map((resource) => ({ resource })),
  ],
});
/** A file of `body` named `name`, in a folder of its own; its path. */
async function file(name: string, body: unknown): Promise<string> {
  const path = join(await fresh(), name);
  await writeFile(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

/**
 * `addPatient()` checks a patient's file as the app would load it at one of its hospitals, then writes it into the
 * app's `people/` folder. A developer brings a patient of their own without learning the folder layout.
 */
describe("Adding a patient to an app's hospital · addPatient()", () => {
  let app: string;
  let roots: Roots;
  let written: string;
  let personAfterFirst: unknown;
  let personAfterSecond: unknown;
  let atAlpha: Awaited<ReturnType<typeof loadHospital>>;
  let atZeta: Awaited<ReturnType<typeof loadHospital>>;
  const personFile = () => join(app, "people", "hedda-quill", "person.json");
  const readPerson = async () =>
    JSON.parse(await readFile(personFile(), "utf8"));

  before(async () => {
    app = await fresh();
    for (const id of ["alpha", "zeta", "yon"])
      await folder(join(app, "hospitals"), id, hospitalAt(id));
    roots = {
      hospitals: [...DEFAULT_ROOTS.hospitals, join(app, "hospitals")],
      people: [...DEFAULT_ROOTS.people, join(app, "people")],
    };
    written = await addPatient(
      app,
      "alpha",
      await file("hedda.json", authoring),
    );
    personAfterFirst = await readPerson();

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
    await addPatient(app, "zeta", await file("plain.json", plain));
    personAfterSecond = await readPerson();

    const rue = (given: string) =>
      collection(
        patient({ id: "rue-hale", name: [{ family: "Hale", given: [given] }] }),
      );
    await mkdir(join(app, "people", "rue-hale", "sources", "alpha"), {
      recursive: true,
    });
    await writeFile(
      join(app, "people", "rue-hale", "person.json"),
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
      join(app, "people", "rue-hale", "sources", "alpha", "fhir.json"),
      JSON.stringify(rue("Ru")),
    );
    await addPatient(app, "zeta", await file("rue.json", rue("Rue")));
    atAlpha = await loadHospital("alpha", roots);
    atZeta = await loadHospital("zeta", roots);
  });

  describe("addPatient(app, hospital, file)", () => {
    it("returns the path it wrote, `people/<Patient id>/sources/<hospital>/fhir.json`", () => {
      assert.equal(
        written,
        join(app, "people", "hedda-quill", "sources", "alpha", "fhir.json"),
      );
    });

    it("writes a file the hospital then loads the patient from", () => {
      assert.ok("hedda-quill" in atAlpha.patients);
    });

    it("compiles a file with `shorthand` to a history before writing it", () => {
      const bundle = atAlpha.patients["hedda-quill"];
      assert.equal(bundle?.type, "history");
      assert.equal(bundle?.entry?.length, 3);
    });

    it("writes a plain collection as it is", () => {
      assert.equal(atZeta.patients["hedda-quill"]?.type, "collection");
    });

    it("writes `person.json` from the Patient's official name, birth date and gender", () => {
      assert.deepEqual(personAfterFirst, HEDDA);
    });

    it("leaves the `person.json` of a person already there as it is", () => {
      assert.deepEqual(personAfterSecond, HEDDA);
    });

    it("accepts a second source of a person who declares a difference at their first", () => {
      assert.ok("rue-hale" in atZeta.patients);
    });
  });

  describe("when the file is refused", () => {
    const unserved = () =>
      file(
        "unserved.json",
        one("unserved", { resourceType: "Observation", id: "o" }),
      );
    /** Each row: the hospital, the file it is given, and the refusal. */
    const ROWS: [string, string, () => Promise<string>, string | RegExp][] = [
      [
        "refuses a patient who is already at the hospital",
        "alpha",
        () => file("again.json", authoring),
        "hedda-quill/sources/alpha/fhir.json: is already at this hospital: remove it first, or give the patient another id",
      ],
      [
        "refuses a patient who disagrees with the person already there",
        "yon",
        () =>
          file("older.json", {
            ...one("hedda-quill"),
            entry: [{ resource: { ...PERSON, birthDate: "1961-05-02" } }],
          }),
        "hedda-quill/sources/yon/fhir.json: Patient hedda-quill says birthDate 1961-05-02, person.json says 1971-05-02",
      ],
      [
        "refuses a hospital the app does not have",
        "nowhere",
        () => file("nowhere.json", one("wren-abbot")),
        "hospital.json: there is no hospital nowhere",
      ],
      [
        "refuses a file that cannot be read",
        "alpha",
        async () => join(await fresh(), "missing.json"),
        /^missing\.json: cannot be read: /,
      ],
      [
        "refuses a file that is not JSON",
        "alpha",
        () => file("broken.json", "{"),
        "broken.json: is not JSON",
      ],
      [
        "refuses a file that is not an object",
        "alpha",
        () => file("null.json", "null"),
        "null.json: is not an object",
      ],
      [
        "refuses a file that is not a Bundle",
        "alpha",
        () => file("notbundle.json", { resourceType: "Patient", id: "x" }),
        "notbundle.json: is not a Bundle",
      ],
      [
        "refuses an entry that is not an object",
        "alpha",
        () => file("nullentry.json", { resourceType: "Bundle", entry: [null] }),
        "nullentry.json: has an entry that is not an object, or whose resource is not",
      ],
      [
        "refuses a `shorthand` that is not an object",
        "alpha",
        () =>
          file("nullshort.json", {
            resourceType: "Bundle",
            type: "collection",
            entry: [{ resource: PERSON, shorthand: null }],
          }),
        "nullshort.json: a shorthand is an object of active and stopped",
      ],
      [
        "refuses a file with no Patient",
        "alpha",
        () =>
          file("none.json", {
            resourceType: "Bundle",
            type: "collection",
            entry: [{ resource: { resourceType: "Condition", id: "c" } }],
          }),
        "none.json: holds no Patient",
      ],
      [
        "refuses a Patient id that is no folder name",
        "alpha",
        () => file("escape.json", one("../../escaped")),
        "escape.json: holds Patient ../../escaped, which is not a person's folder name: lower-case letters and digits joined by -",
      ],
      [
        "refuses a Patient id that is a person of the package already",
        "zeta",
        () =>
          file("tobias.json", {
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
      [
        "refuses a Patient with no birth date",
        "alpha",
        () =>
          file("nobirth.json", {
            ...one("nobirth"),
            entry: [
              {
                resource: { ...PERSON, id: "nobirth", birthDate: undefined },
              },
            ],
          }),
        "nobirth.json: holds Patient nobirth with no birthDate, which its person.json needs",
      ],
      [
        "refuses a record of a type the hospital does not serve",
        "alpha",
        unserved,
        "unserved/sources/alpha/fhir.json: Observation/o is an Observation, which hospital.json does not list in types",
      ],
      [
        "refuses a record another patient's file holds",
        "alpha",
        () =>
          file(
            "twice.json",
            one("twice", {
              resourceType: "MedicationStatement",
              id: "metformin",
            }),
          ),
        "twice/sources/alpha/fhir.json: MedicationStatement/metformin is in two patient files",
      ],
    ];
    for (const [title, hospital, source, message] of ROWS)
      it(title, async () => {
        await assert.rejects(
          addPatient(app, hospital, await source()),
          refusedWith(message),
        );
      });

    it("writes nothing for a file it refuses", async () => {
      await assert.rejects(
        addPatient(app, "alpha", await unserved()),
        HospitalDataError,
      );
      assert.deepEqual((await readdir(join(app, "people"))).sort(), [
        "hedda-quill",
        "rue-hale",
      ]);
      assert.deepEqual(
        (await loadHospitals(roots))
          .filter(({ hospital }) => hospital.name.endsWith(" test hospital"))
          .map(({ hospital, patients }) => [
            hospital.name,
            Object.keys(patients).length,
          ]),
        [
          ["alpha test hospital", 2],
          ["yon test hospital", 0],
          ["zeta test hospital", 2],
        ],
      );
    });
  });
});
