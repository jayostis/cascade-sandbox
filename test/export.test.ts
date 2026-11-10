import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  exportCollection,
  type Hospital,
  HospitalDataError,
} from "../src/index.js";
import { loadHospital } from "../src/node/index.js";
import { PATIENTS, T } from "./fixtures.js";

const NOT_AN_INSTANT = [
  "2024-02-01",
  "2024-02-01T00:00:00",
  "soon",
  "2024-02-30T00:00:00Z",
  "0099-02-01T00:00:00Z",
];

/**
 * `exportCollection()` gives a patient's records as they stood on a date as one `collection` Bundle, each `fullUrl`
 * the hospital's own. The file reads as what a pull of that hospital on that date would have brought.
 */
describe("Exporting a patient's records as a file · exportCollection()", () => {
  let hospital: Hospital;

  before(async () => {
    ({ hospital } = await loadHospital("cascade-north"));
  });

  const held = () => ({ hospital, patients: PATIENTS });

  const refused = (where: string, reason: string) => (error: unknown) =>
    error instanceof HospitalDataError &&
    error.where === where &&
    error.reason === reason;

  /** What the file holds by address: a medication's status, any other record's id. */
  const inFile = (asOf?: string) =>
    Object.fromEntries(
      (exportCollection(held(), "p1", asOf).entry ?? []).map(
        ({ fullUrl, resource }) => [
          fullUrl,
          resource?.resourceType === "MedicationStatement"
            ? resource.status
            : resource?.id,
        ],
      ),
    );

  describe("exportCollection(hospital, patient, asOf)", () => {
    it("returns each record's version current at `asOf`, a deleted record left out", () => {
      const base = hospital.fhirBase;
      assert.deepEqual(inFile(T), {
        [`${base}/Patient/p1`]: "p1",
        [`${base}/MedicationStatement/m1`]: "active",
        [`${base}/Observation/o1`]: "o1",
        [`${base}/Observation/o2`]: "o2",
      });
    });

    it("returns each record's latest version when no `asOf` is given", () => {
      const base = hospital.fhirBase;
      assert.deepEqual(inFile(), {
        [`${base}/Patient/p1`]: "p1",
        [`${base}/MedicationStatement/m1`]: "completed",
        [`${base}/Observation/o2`]: "o2",
        [`${base}/Condition/c1`]: "c1",
      });
    });

    it("addresses each record at the hospital's FHIR base", () => {
      const collection = exportCollection(held(), "p1", T);
      assert.equal(collection.type, "collection");
      assert.ok((collection.entry ?? []).length > 0);
      for (const { fullUrl, resource } of collection.entry ?? [])
        assert.equal(
          fullUrl,
          `${hospital.fhirBase}/${resource?.resourceType}/${resource?.id}`,
        );
    });

    it("throws `HospitalDataError` for a patient the hospital does not hold", () => {
      assert.throws(
        () => exportCollection(held(), "nobody"),
        refused("patient", `${hospital.name} has no patient nobody`),
      );
    });

    it("throws `HospitalDataError` for a patient made after `asOf`", () => {
      assert.throws(
        () => exportCollection(held(), "p3", T),
        refused("patient", `${hospital.name} has no patient p3 at ${T}`),
      );
    });

    it("throws `HospitalDataError` for a patient who is deleted", () => {
      assert.throws(
        () => exportCollection(held(), "p4"),
        refused("patient", `${hospital.name} has no patient p4`),
      );
      assert.throws(
        () => exportCollection(held(), "p4", T),
        refused("patient", `${hospital.name} has no patient p4 at ${T}`),
      );
    });

    it("throws `HospitalDataError` for an `asOf` that is not an instant", () => {
      for (const asOf of NOT_AN_INSTANT)
        assert.throws(
          () => exportCollection(held(), "p1", asOf),
          refused("asOf", "asOf is an instant, as 2024-02-01T00:00:00Z"),
          asOf,
        );
    });
  });
});
