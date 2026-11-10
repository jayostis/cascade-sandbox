import type { Bundle, BundleEntry, Resource } from "../src/index.js";
import { historyEntry } from "../src/history.js";

/** The date the history fixtures are read at. */
export const T = "2024-02-01T00:00:00Z";

export function version(
  resource: Resource,
  versionId: string,
  at: string,
  method?: "POST" | "PUT",
): BundleEntry {
  const entry = historyEntry(resource, versionId, at);
  if (method === undefined || method === entry.request?.method) return entry;
  const created = method === "POST";
  return {
    ...entry,
    request: {
      method,
      url: created
        ? resource.resourceType
        : `${resource.resourceType}/${resource.id}`,
    },
    response: { ...entry.response!, status: created ? "201" : "200" },
  };
}

export function deletion(
  record: string,
  versionId: string,
  at: string,
): BundleEntry {
  return {
    request: { method: "DELETE", url: record },
    response: { status: "204", lastModified: at, etag: `W/"${versionId}"` },
  };
}

export const history = (...entry: BundleEntry[]): Bundle => ({
  resourceType: "Bundle",
  type: "history",
  entry,
});

export const person = (id: string, family: string): Resource => ({
  resourceType: "Patient",
  id,
  name: [{ family, given: ["Ana"] }],
});

export const med = (status: string): Resource => ({
  resourceType: "MedicationStatement",
  id: "m1",
  status,
});

export const obs = (id: string): Resource => ({
  resourceType: "Observation",
  id,
  status: "final",
});

export const PATIENTS: Record<string, Bundle> = {
  p1: history(
    version(med("completed"), "2", "2024-04-15T16:00:00Z"),
    version(person("p1", "Wick"), "1", "2020-01-01T00:00:00Z"),
    version(med("active"), "1", "2022-03-01T00:00:00Z"),
    version(obs("o1"), "1", "2023-01-01T00:00:00Z"),
    version(obs("o2"), "1", "2023-02-01T00:00:00Z"),
    deletion("Observation/o1", "2", "2024-05-01T00:00:00Z"),
    version(
      { resourceType: "Condition", id: "c1", onsetDateTime: "2023-06-01" },
      "1",
      "2025-01-01T00:00:00Z",
    ),
  ),
  p2: {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: person("p2", "Brook") },
      { resource: { resourceType: "Condition", id: "c2" } },
    ],
  },
  p3: history(
    version(person("p3", "Corr"), "1", "2025-01-01T00:00:00Z"),
    version(obs("o4"), "1", "2023-03-01T00:00:00Z"),
    deletion("Observation/o4", "2", "2023-04-01T00:00:00Z"),
    version(obs("o4"), "3", "2023-05-01T00:00:00Z", "POST"),
  ),
  p4: history(
    version(person("p4", "Dale"), "1", "2020-01-01T00:00:00Z"),
    deletion("Patient/p4", "2", "2023-01-01T00:00:00Z"),
  ),
};
