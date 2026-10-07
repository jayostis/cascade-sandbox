import { createHash } from "node:crypto";
import type { Bundle, Hospital, Resource } from "../index.js";

export const KEPT_TYPES = [
  "Patient",
  "AllergyIntolerance",
  "Condition",
  "Encounter",
  "Immunization",
  "MedicationRequest",
  "Observation",
  "Procedure",
];
const OBSERVATION_CATEGORIES = ["laboratory", "vital-signs"];
const PROVIDER_TYPES = ["Organization", "Location"];

export interface HospitalFolder {
  folder: string;
  hospital: Hospital;
}

export interface PatientFile {
  folder: string;
  id: string;
  bundle: Bundle;
}

export interface Removed {
  names: string[];
  addresses: string[];
  telecoms: string[];
}

type Json = Record<string, unknown>;

export function syntheaId(folder: string, synthea: string): string {
  return `syn-${createHash("sha256")
    .update(`${folder}|${synthea}`)
    .digest("hex")
    .slice(0, 16)}`;
}

export function withoutDigits(text: string): string {
  return text.replace(/(\p{L})\d+/gu, "$1");
}

export function fromSynthea(
  bundle: Bundle,
  hospitals: HospitalFolder[],
  providers: Resource[] = [],
): { files: PatientFile[]; removed: Removed } {
  const [home, away] = hospitals;
  if (!home) throw new Error("A person needs at least one hospital");
  const resources = (bundle.entry ?? []).map((entry) => entry.resource);
  const medications = new Map(
    resources
      .filter((resource) => resource.resourceType === "Medication")
      .map((resource) => [resource.id, resource.code]),
  );
  const kept = resources.filter(keep);
  const patient = kept.find((resource) => resource.resourceType === "Patient");
  if (!patient) throw new Error("A Synthea bundle holds one Patient");

  const encounters = kept.filter((r) => r.resourceType === "Encounter");
  const visits = new Map<string, number>();
  for (const encounter of encounters) {
    const provider = providerKey(encounter);
    visits.set(provider, (visits.get(provider) ?? 0) + 1);
  }
  const busiest = [...visits.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const encounterAt = new Map(
    encounters.map((encounter) => [
      encounter.id,
      !away || providerKey(encounter) === busiest ? home : away,
    ]),
  );

  const placed = new Map<HospitalFolder, Resource[]>(
    hospitals.map((hospital) => [hospital, []]),
  );
  for (const resource of kept) {
    const encounter =
      resource.resourceType === "Encounter"
        ? resource.id
        : uuidOf((resource.encounter as Json | undefined)?.reference);
    const at = encounter ? encounterAt.get(encounter) : undefined;
    for (const hospital of hospitals) {
      if (!at || at === hospital || reconciled(resource)) {
        placed.get(hospital)?.push(resource);
      }
    }
  }

  const seen = new Set<string>();
  const files = hospitals.map((hospital) => {
    const here = placed.get(hospital) ?? [];
    const ids = new Map(
      here.map((resource) => [
        resource.id,
        `${resource.resourceType}/${syntheaId(hospital.folder, resource.id)}`,
      ]),
    );
    const entry = here.map((resource) => ({
      resource: rewrite(resource, hospital, ids, medications, seen),
    }));
    return {
      folder: hospital.folder,
      id: syntheaId(hospital.folder, patient.id),
      bundle: { resourceType: "Bundle" as const, type: "collection", entry },
    };
  });

  const removed: Removed = { names: [], addresses: [], telecoms: [] };
  for (const provider of providers) {
    const identifiers = (provider.identifier as Json[] | undefined) ?? [];
    if (!identifiers.some((identifier) => seen.has(String(identifier.value)))) {
      continue;
    }
    if (typeof provider.name === "string") removed.names.push(provider.name);
    for (const address of [provider.address ?? []].flat() as Json[]) {
      for (const line of (address.line as string[] | undefined) ?? []) {
        removed.addresses.push(line);
      }
    }
    for (const telecom of (provider.telecom as Json[] | undefined) ?? []) {
      if (typeof telecom.value === "string") {
        removed.telecoms.push(telecom.value);
      }
    }
  }
  return { files, removed };
}

function keep(resource: Resource): boolean {
  if (!KEPT_TYPES.includes(resource.resourceType)) return false;
  if (resource.resourceType !== "Observation") return true;
  const codes = categoryCodes(resource);
  return (
    codes.filter((code) => OBSERVATION_CATEGORIES.includes(code)).length === 1
  );
}

function categoryCodes(resource: Resource): string[] {
  const category = (resource.category as Json[] | undefined) ?? [];
  return category.flatMap((concept) =>
    ((concept.coding as Json[] | undefined) ?? []).map((coding) =>
      String(coding.code),
    ),
  );
}

function reconciled(resource: Resource): boolean {
  if (resource.resourceType === "AllergyIntolerance") return true;
  if (resource.resourceType === "MedicationRequest") {
    return resource.status === "active";
  }
  if (resource.resourceType === "Condition") {
    const status = resource.clinicalStatus as Json | undefined;
    const coding = (status?.coding as Json[] | undefined)?.[0];
    return coding?.code === "active";
  }
  return false;
}

function providerKey(encounter: Resource): string {
  const provider = encounter.serviceProvider as Json | undefined;
  return String(provider?.reference ?? provider?.display ?? "");
}

function uuidOf(reference: unknown): string | undefined {
  return typeof reference === "string" && reference.startsWith("urn:uuid:")
    ? reference.slice("urn:uuid:".length)
    : undefined;
}

function rewrite(
  resource: Resource,
  hospital: HospitalFolder,
  ids: Map<string, string>,
  medications: Map<string, unknown>,
  seen: Set<string>,
): Resource {
  const copy = structuredClone(resource) as Json;
  const reference = ids.get(resource.id) ?? "";
  const id = reference.slice(reference.indexOf("/") + 1);
  copy.id = id;
  delete copy.text;
  if (resource.resourceType === "Patient") {
    copy.identifier = [
      {
        system: `${new URL(hospital.hospital.fhirBase).origin}/mrn`,
        value: `SYN-${id.slice(4, 12).toUpperCase()}`,
      },
    ];
    for (const field of ["name", "extension"]) {
      copy[field] = stripDigits(copy[field]);
    }
  } else {
    delete copy.identifier;
  }
  const medication = uuidOf(
    (copy.medicationReference as Json | undefined)?.reference,
  );
  if (medication !== undefined) {
    copy.medicationCodeableConcept = medications.get(medication);
    delete copy.medicationReference;
  }
  return pruned(copy, hospital, ids, seen) as Resource;
}

function stripDigits(value: unknown): unknown {
  if (typeof value === "string") return withoutDigits(value);
  if (Array.isArray(value)) return value.map(stripDigits);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "url" || key === "system" ? item : stripDigits(item),
      ]),
    );
  }
  return value;
}

const GONE = Symbol("gone");

function pruned(
  value: unknown,
  hospital: HospitalFolder,
  ids: Map<string, string>,
  seen: Set<string>,
): unknown {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => pruned(item, hospital, ids, seen))
      .filter((item) => item !== GONE);
    return items.length > 0 ? items : GONE;
  }
  if (!value || typeof value !== "object") return value;
  const object = value as Json;
  if (typeof object.reference === "string") {
    return reference(object, hospital, ids, seen);
  }
  const result: Json = {};
  for (const [key, item] of Object.entries(object)) {
    const next = pruned(item, hospital, ids, seen);
    if (next !== GONE) result[key] = next;
  }
  return result;
}

function reference(
  object: Json,
  hospital: HospitalFolder,
  ids: Map<string, string>,
  seen: Set<string>,
): Json | typeof GONE {
  const target = String(object.reference);
  const uuid = uuidOf(target);
  if (uuid !== undefined) {
    const id = ids.get(uuid);
    if (!id) return GONE;
    const result: Json = { reference: id };
    if (typeof object.display === "string") {
      result.display = id.startsWith("Patient/")
        ? withoutDigits(object.display)
        : object.display;
    }
    return result;
  }
  const type = target.replace(/[?/].*/, "");
  const identifier = /\|(.+)$/.exec(target)?.[1];
  if (identifier) seen.add(identifier);
  if (PROVIDER_TYPES.includes(type)) {
    return { display: hospital.hospital.name };
  }
  return typeof object.display === "string"
    ? { display: withoutDigits(object.display) }
    : GONE;
}
