import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  type Bundle,
  HospitalDataError,
  type Resource,
  versionsOf,
} from "../src/index.js";
import { loadHospital } from "../src/node/index.js";
import { signInAs } from "../src/testing.js";
import {
  compileShorthand,
  type ShorthandBundle,
  type ShorthandEntry,
} from "../src/shorthand.js";

const person: Resource = {
  resourceType: "Patient",
  id: "p1",
  name: [{ family: "Quill", given: ["Hedda"] }],
};
const med: Resource = {
  resourceType: "MedicationStatement",
  id: "m1",
  status: "active",
  medicationCodeableConcept: { text: "Metformin" },
};
const condition: Resource = {
  resourceType: "Condition",
  id: "c1",
  code: { text: "Bronchitis" },
};
const result: Resource = {
  resourceType: "Observation",
  id: "o1",
  status: "final",
  effectiveDateTime: "2023-01-10T09:00:00Z",
};

const file = (...entry: ShorthandEntry[]): ShorthandBundle => ({
  resourceType: "Bundle",
  type: "collection",
  entry,
});

const compile = () =>
  compileShorthand(
    file(
      { resource: person },
      {
        resource: med,
        shorthand: { active: "2022-03-01", stopped: "2024-04-15" },
      },
      {
        resource: condition,
        shorthand: { active: "2023-05-01", stopped: "2024-06-10" },
      },
      { resource: result },
    ),
    "hedda.json",
  );

/** The refusals: what is wrong with the file, the file, and the reason the hospital's data rules give. */
const REFUSALS: [string, ShorthandBundle, string][] = [
  [
    "refuses `stopped` on a MedicationRequest",
    file(
      { resource: person },
      {
        resource: {
          resourceType: "MedicationRequest",
          id: "r1",
          authoredOn: "2022-03-01",
        },
        shorthand: { stopped: "2024-04-15" },
      },
    ),
    "an R4 MedicationRequest has no date that says when it stopped: write its second version",
  ],
  [
    "refuses `stopped` on a type with no field that dates a stop",
    file(
      { resource: person },
      { resource: result, shorthand: { stopped: "2024-04-15" } },
    ),
    "Observation has no field that dates a stop",
  ],
  [
    "refuses a record with no date to place it at",
    file({ resource: person }, { resource: med }),
    "MedicationStatement/m1 has no date to place it at: give shorthand.active",
  ],
  [
    "refuses a Patient with no record to place it by",
    file({ resource: person }),
    "Patient/p1 has no date to place it at: give shorthand.active",
  ],
  [
    "refuses a stop that is not after the start",
    file(
      { resource: person },
      {
        resource: med,
        shorthand: { active: "2022-03-01", stopped: "2022-03-01" },
      },
    ),
    "MedicationStatement/m1 stopped on 2022-03-01, which is not after it began on 2022-03-01",
  ],
  [
    "refuses a day that does not exist",
    file(
      { resource: person },
      { resource: med, shorthand: { active: "2022-02-30" } },
    ),
    'MedicationStatement/m1 shorthand.active "2022-02-30" is not a date, as 2022-03-01, or an instant, as 2022-03-01T09:00:00Z',
  ],
  [
    "refuses a `shorthand` key that is neither `active` nor `stopped`",
    file(
      { resource: person },
      {
        resource: med,
        shorthand: { active: "2022-03-01", stoped: "2024-04-15" } as never,
      },
    ),
    "MedicationStatement/m1 shorthand takes active and stopped, not stoped",
  ],
  [
    "refuses a record written twice",
    file({ resource: person }, { resource: result }, { resource: result }),
    "a collection holds Observation/o1 twice",
  ],
  [
    "refuses a file that is not a collection",
    { ...file({ resource: person }), type: "history" },
    "a shorthand file is a Bundle of type collection, not history",
  ],
];

/**
 * A patient file's history can be written short: a plain collection in which an entry says when its record began and
 * when it stopped, as `shorthand: { active, stopped }`. `addPatient()` compiles it to the versions a hospital serves,
 * so a developer writes two dates and not two copies of a record.
 */
describe("Writing a patient's changes in shorthand · addPatient(), shorthand", () => {
  let compiled: Bundle;
  before(() => {
    compiled = compile();
  });

  const times = (record: string) =>
    versionsOf(compiled, "hedda.json")
      .get(record)
      ?.map(({ versionId, recorded }) => `${versionId}@${recorded}`);

  describe("given a collection whose entries carry `shorthand`", () => {
    it("compiles to a `history` Bundle", () => {
      assert.equal(compiled.type, "history");
    });

    it("gives a record with `active` and `stopped` two versions, recorded on those days", () => {
      assert.deepEqual(times("MedicationStatement/m1"), [
        "1@2022-03-01T00:00:00Z",
        "2@2024-04-15T00:00:00Z",
      ]);
      assert.deepEqual(times("Condition/c1"), [
        "1@2023-05-01T00:00:00Z",
        "2@2024-06-10T00:00:00Z",
      ]);
    });

    it("places a record with no `shorthand` at its own clinical date", () => {
      assert.deepEqual(times("Observation/o1"), ["1@2023-01-10T09:00:00Z"]);
    });

    it("places the Patient at the file's earliest record time", () => {
      assert.deepEqual(times("Patient/p1"), ["1@2022-03-01T00:00:00Z"]);
    });
  });

  describe("when a hospital serves the compiled file as of a date", () => {
    type Answer = {
      medication?: Resource;
      problem?: Resource;
      results: Resource[];
    };
    const answers: Record<string, Answer> = {};

    before(async () => {
      const { hospital } = await loadHospital("cascade-north");
      for (const asOf of [
        "2022-06-01T00:00:00Z",
        "2023-06-01T00:00:00Z",
        "2025-01-01T00:00:00Z",
      ]) {
        const { hospital: hosted, token } = await signInAs(
          { hospital, patients: { p1: compiled }, asOf },
          "p1",
        );
        const search = async (type: string) =>
          (
            (await (
              await hosted(
                new Request(`${hospital.fhirBase}/${type}?patient=p1`, {
                  headers: { Authorization: `Bearer ${token}` },
                }),
              )
            ).json()) as Bundle
          ).entry?.map(({ resource }) => resource as Resource) ?? [];
        const [medication] = await search("MedicationStatement");
        const [problem] = await search("Condition");
        answers[asOf] = {
          ...(medication && { medication }),
          ...(problem && { problem }),
          results: await search("Observation"),
        };
      }
    });

    const statusOf = (problem: Resource) =>
      (problem.clinicalStatus as { coding: { code: string }[] }).coding[0]
        ?.code;
    const endOf = (medication: Resource) =>
      (medication.effectivePeriod as { end?: string }).end;

    it("omits a record before the day it became active", () => {
      const early = answers["2022-06-01T00:00:00Z"]!;
      assert.equal(early.problem, undefined);
      assert.deepEqual(early.results, []);
      assert.equal(early.medication?.status, "active");
    });

    it("serves a medication as active until its stop, then as completed with the stop as its period's end", () => {
      const during = answers["2023-06-01T00:00:00Z"]!.medication!;
      assert.equal(during.status, "active");
      assert.equal(endOf(during), undefined);
      const after = answers["2025-01-01T00:00:00Z"]!.medication!;
      assert.equal(after.status, "completed");
      assert.equal(endOf(after), "2024-04-15");
    });

    it("serves a condition as active until its stop, then as resolved with the stop as its abatement", () => {
      const during = answers["2023-06-01T00:00:00Z"]!.problem!;
      assert.equal(statusOf(during), "active");
      assert.equal(during.abatementDateTime, undefined);
      const after = answers["2025-01-01T00:00:00Z"]!.problem!;
      assert.equal(statusOf(after), "resolved");
      assert.equal(after.abatementDateTime, "2024-06-10");
    });
  });

  describe("when the file cannot be compiled", () => {
    for (const [title, input, reason] of REFUSALS)
      it(title, () => {
        assert.throws(
          () => compileShorthand(input, "hedda.json"),
          (error) =>
            error instanceof HospitalDataError &&
            error.where === "hedda.json" &&
            error.reason === reason,
        );
      });
  });
});
