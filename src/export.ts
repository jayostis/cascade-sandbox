import { HospitalDataError, recordsAt } from "./history.js";
import type { Bundle, Hospital } from "./types.js";

/**
 * A patient's records as they stood at `asOf` (their latest versions when absent) as a `collection` whose `fullUrl`s
 * are the hospital's own, so a file of it reads as the records a pull of that hospital would have brought. Throws
 * HospitalDataError for a patient the hospital does not hold, and for an `asOf` that is not an instant.
 */
export function exportCollection(
  hospital: { hospital: Hospital; patients: Record<string, Bundle> },
  patient: string,
  asOf?: string,
): Bundle {
  const file = hospital.patients[patient];
  if (file === undefined) {
    throw new HospitalDataError(
      "patient",
      `${hospital.hospital.name} has no patient ${patient}`,
    );
  }
  const base = hospital.hospital.fhirBase.replace(/\/$/, "");
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: recordsAt(file, asOf).map((resource) => ({
      fullUrl: `${base}/${resource.resourceType}/${resource.id}`,
      resource,
    })),
  };
}
