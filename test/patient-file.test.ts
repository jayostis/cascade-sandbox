import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type Bundle,
  type BundleEntry,
  demoHospital,
  type Hospital,
  HospitalDataError,
} from "../src/index.js";
import { loadHospital } from "../src/node/index.js";
import { deletion, history, person, version } from "./fixtures.js";

const AT = "2024-01-01T00:00:00Z";
const LATER = "2024-02-01T00:00:00Z";

const c1 = (at: string, versionId = "1") =>
  version({ resourceType: "Condition", id: "c1" }, versionId, at);
const p1 = version(person("p1", "Wick"), "1", "2020-01-01T00:00:00Z");

type Editable = {
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  resource: { meta: Record<string, unknown> };
};
const edited = (entry: BundleEntry, change: (copy: Editable) => void) => {
  const copy = structuredClone(entry);
  change(copy as unknown as Editable);
  return copy;
};

/**
 * A patient file that breaks a rule, the reason a refusal gives for it, and where the refusal says it is: the hospital
 * names the patient, the loader the file. `{BASE}` stands for the hospital's FHIR base.
 */
type Refusal = {
  title: string;
  patients: Record<string, Bundle>;
  reason: string;
  /** The patient the hospital names; the loader places a file by the patient it holds. */
  where?: string;
  /** Whether the loader can be given the file: it places a file by its Patient, so one named for another patient cannot be written. */
  onDisk?: false;
};

const REFUSALS: Refusal[] = [
  {
    title: "refuses a Bundle that is neither a collection nor a history",
    patients: {
      p1: { resourceType: "Bundle", type: "searchset", entry: [p1] },
    },
    reason:
      "a patient file is a Bundle of type collection or history, not searchset",
  },
  {
    title: "refuses a collection that holds a record twice",
    patients: {
      p1: {
        resourceType: "Bundle",
        type: "collection",
        entry: [
          { resource: person("p1", "Wick") },
          { resource: person("p1", "Wick") },
        ],
      },
    },
    reason: "a collection holds Patient/p1 twice",
  },
  {
    title: "refuses a history entry whose method is not POST, PUT or DELETE",
    patients: {
      p1: history(
        p1,
        edited(c1(AT), (e) => (e.request.method = "PATCH")),
      ),
    },
    reason: "a history entry has a request whose method is POST, PUT or DELETE",
  },
  {
    title: "refuses an entry whose `request.url` names another record",
    patients: {
      p1: history(
        p1,
        edited(c1(AT, "2"), (e) => (e.request.url = "Condition/c9")),
      ),
    },
    reason: "request.url is not <type>/<id> of its resource",
  },
  {
    title: "refuses a record time that is a date",
    patients: {
      p1: history(
        p1,
        edited(c1(AT), (e) => (e.response.lastModified = "2024-01-01")),
      ),
    },
    reason: "a history entry has a response whose lastModified is an instant",
  },
  {
    title: "refuses a record time on a day that does not exist",
    patients: {
      p1: history(
        p1,
        edited(
          c1(AT),
          (e) => (e.response.lastModified = "2024-02-31T00:00:00Z"),
        ),
      ),
    },
    reason: "a history entry has a response whose lastModified is an instant",
  },
  {
    title: "refuses a version with no `meta.versionId`",
    patients: {
      p1: history(
        p1,
        edited(c1(AT), (e) => delete e.resource.meta.versionId),
      ),
    },
    reason: "Condition/c1 has a version with no meta.versionId",
  },
  {
    title: "refuses a `meta.lastUpdated` that is not the entry's record time",
    patients: {
      p1: history(
        p1,
        edited(c1(AT), (e) => (e.resource.meta.lastUpdated = LATER)),
      ),
    },
    reason:
      "Condition/c1 version 1: meta.lastUpdated is not the entry's response.lastModified",
  },
  {
    title: "refuses an etag of another version",
    patients: {
      p1: history(
        p1,
        edited(c1(AT), (e) => (e.response.etag = 'W/"2"')),
      ),
    },
    reason: 'Condition/c1 version 1: the etag is not W/"1"',
  },
  {
    title: "refuses a version id used twice",
    patients: { p1: history(p1, c1(AT), c1(LATER)) },
    reason: "Condition/c1 reuses version 1",
  },
  {
    title: "refuses two versions of a record at one time",
    patients: { p1: history(p1, c1(AT), c1(AT, "2")) },
    reason: `Condition/c1 has two versions at ${AT}`,
  },
  {
    title: "refuses a deletion with no etag",
    patients: {
      p1: history(
        p1,
        c1(AT),
        edited(
          deletion("Condition/c1", "2", LATER),
          (e) => delete e.response.etag,
        ),
      ),
    },
    reason: "Condition/c1 is deleted with a resource, or with no etag",
  },
  {
    title: "refuses a deletion that carries a resource",
    patients: {
      p1: history(p1, c1(AT), {
        ...deletion("Condition/c1", "2", LATER),
        resource: { resourceType: "Condition", id: "c1" },
      }),
    },
    reason: "Condition/c1 is deleted with a resource, or with no etag",
  },
  {
    title: "refuses a deletion of a record that does not exist",
    patients: { p1: history(p1, deletion("Condition/c1", "1", AT)) },
    reason: "Condition/c1 is deleted while it does not exist",
  },
  {
    title: "refuses a `fullUrl` at another base than the hospital's",
    patients: {
      p1: history(p1, {
        ...c1(AT),
        fullUrl: "https://elsewhere.example/fhir/Condition/c1",
      }),
    },
    reason:
      "fullUrl https://elsewhere.example/fhir/Condition/c1 is not {BASE}/Condition/c1",
  },
  {
    title: "refuses a record held in two patients' files",
    patients: {
      p1: history(p1, c1(AT)),
      p2: history(version(person("p2", "Brook"), "1", AT), c1(AT)),
    },
    reason: "Condition/c1 is in two patient files",
    where: "p2",
  },
  {
    title: "refuses a file whose Patient is not the id it is held under",
    patients: { p1: history(version(person("p9", "Wick"), "1", AT)) },
    reason: "holds Patient p9, not p1",
    onDisk: false,
  },
];

/**
 * A patient file is a FHIR Bundle of type `collection`, plain records, or `history`, one entry for each version. A
 * hospital and the loader refuse a file that breaks a rule with a `HospitalDataError` whose `reason` says which, so a
 * developer's own patient fails when it is loaded and not in the middle of a pull.
 */
describe("Checking a patient file · demoHospital(), loadHospital(), HospitalDataError", () => {
  let hospital: Hospital;
  let folder: string;

  const refused = (where: string, reason: string) => (error: unknown) =>
    error instanceof HospitalDataError &&
    error.where === where &&
    error.reason === reason;

  /** A folder of people, one for each patient, and a hospital folder to load them for. */
  async function written(name: string, patients: Record<string, Bundle>) {
    const people = join(folder, name, "people");
    for (const [id, bundle] of Object.entries(patients)) {
      const source = join(people, id, "sources", "cascade-north");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "fhir.json"), JSON.stringify(bundle));
      await writeFile(
        join(people, id, "person.json"),
        JSON.stringify({
          id,
          name: { family: id === "p2" ? "Brook" : "Wick", given: ["Ana"] },
          birthDate: "1970-01-01",
          gender: "unknown",
        }),
      );
    }
    return { hospitals: [join(folder, "hospitals")], people: [people] };
  }

  before(async () => {
    ({ hospital } = await loadHospital("cascade-north"));
    folder = await mkdtemp(join(tmpdir(), "demo-hospital-"));
    await mkdir(join(folder, "hospitals", "cascade-north"), {
      recursive: true,
    });
    await writeFile(
      join(folder, "hospitals", "cascade-north", "hospital.json"),
      JSON.stringify(hospital),
    );
  });

  after(() => rm(folder, { recursive: true, force: true }));

  describe("when a patient file breaks a rule", () => {
    REFUSALS.forEach(({ title, patients, reason, where = "p1", onDisk }, row) =>
      it(title, async () => {
        const said = reason.replace("{BASE}", hospital.fhirBase);
        assert.throws(
          () => demoHospital({ hospital, patients }),
          refused(`patient ${where}`, said),
        );
        if (onDisk === false) return;
        const roots = await written(`row-${row}`, patients);
        await assert.rejects(
          loadHospital("cascade-north", roots),
          refused(`${where}/sources/cascade-north/fhir.json`, said),
        );
      }),
    );
  });
});
