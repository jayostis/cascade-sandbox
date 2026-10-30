import { createHash } from "node:crypto";
import { historyEntry, recordsAt } from "../history.js";
import type { Bundle, Hospital, Resource } from "../index.js";
import { officialName, type Person } from "./people.js";

/** Who is chosen from the run, as `synthea/people.json` lists them. */
export interface Chosen {
  person: string;
  synthea: string;
  hospitals: string[];
}

/** The run `synthea/README.md` gives, as a generated person records it. */
export const RUN = {
  by: "synthea 4.0.0",
  seed: 90,
  clinicianSeed: 90,
  referenceDate: "2026-10-01",
  endDate: "2026-10-01",
  arguments: "-p 40 -a 45-80 Washington",
};

/** A generated person's `person.json`, from the Patient of their first hospital's file. */
export function generatedPerson(chosen: Chosen, first: Bundle): Person {
  const patient = recordsAt(first).find(
    ({ resourceType }) => resourceType === "Patient",
  );
  const name = patient && officialName(patient);
  if (!patient || !name)
    throw new Error(`${chosen.person} has no named Patient`);
  return {
    id: chosen.person,
    name,
    birthDate: patient.birthDate as string,
    gender: patient.gender as Person["gender"],
    generated: {
      by: RUN.by,
      syntheaId: chosen.synthea,
      seed: RUN.seed,
      clinicianSeed: RUN.clinicianSeed,
      referenceDate: RUN.referenceDate,
      endDate: RUN.endDate,
      arguments: RUN.arguments,
      hospitals: chosen.hospitals,
    },
  };
}

export const OBSERVATION_CATEGORIES = ["laboratory", "vital-signs"];
const PROVIDER_TYPES = ["Organization", "Location"];
const MAIDEN_NAME =
  "http://hl7.org/fhir/StructureDefinition/patient-mothersMaidenName";
const SYNTHEA_EXTENSIONS = "http://synthetichealth.github.io/synthea/";
const RECONCILED = ["AllergyIntolerance", "MedicationRequest", "Condition"];

/** One row of Synthea's `csv/medications.csv`, the only place an order's stop is dated. */
export interface MedicationRow {
  start: string;
  stop: string;
  encounter: string;
  code: string;
}

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

const MEDICATION_COLUMNS = "START,STOP,PATIENT,PAYER,ENCOUNTER,CODE,";

/** A person's rows. The first six columns hold no quotes or commas. */
export function medicationRows(csv: string, patient: string): MedicationRow[] {
  const [header, ...lines] = csv.split(/\r?\n/);
  if (!header?.startsWith(MEDICATION_COLUMNS)) {
    throw new Error(`medications.csv does not begin ${MEDICATION_COLUMNS}…`);
  }
  return lines.flatMap((line) => {
    const [start, stop, who, , encounter, code] = line.split(",");
    return who === patient
      ? [{ start: start!, stop: stop!, encounter: encounter!, code: code! }]
      : [];
  });
}

export function bundleText(bundle: Bundle): string {
  const entries = (bundle.entry ?? []).map((entry) => JSON.stringify(entry));
  return `{"resourceType":"Bundle","type":"${bundle.type}","entry":[\n${entries.join(",\n")}\n]}\n`;
}

export function providerDetails(providers: Resource[]): Removed {
  const removed: Removed = { names: [], addresses: [], telecoms: [] };
  for (const provider of providers) {
    if (
      PROVIDER_TYPES.includes(provider.resourceType) &&
      typeof provider.name === "string"
    ) {
      removed.names.push(provider.name);
    }
    for (const address of [provider.address ?? []].flat() as Json[]) {
      for (const line of (address.line as string[] | undefined) ?? []) {
        removed.addresses.push(line);
      }
    }
    for (const telecom of (provider.telecom as Json[] | undefined) ?? []) {
      if (telecom.system === "phone" && typeof telecom.value === "string") {
        removed.telecoms.push(telecom.value);
      }
    }
  }
  const sorted = (list: string[]) => [...new Set(list)].sort();
  return {
    names: sorted(removed.names),
    addresses: sorted(removed.addresses),
    telecoms: sorted(removed.telecoms),
  };
}

/** A record at one hospital and the instants (ms) of its versions: one, or its first and its stop. */
interface Placed {
  resource: Resource;
  times: number[];
}

export function fromSynthea(
  bundle: Bundle,
  hospitals: HospitalFolder[],
  medications: MedicationRow[],
  payers: string[] = [],
): PatientFile[] {
  const [home, away] = hospitals;
  if (!home) throw new Error("A person needs at least one hospital");
  if (hospitals.length > 2) {
    throw new Error("A person is split across at most two hospitals");
  }
  const resources = (bundle.entry ?? []).flatMap(
    (entry) => entry.resource ?? [],
  );
  const drugs = new Map(
    resources
      .filter((resource) => resource.resourceType === "Medication")
      .map((resource) => [resource.id, resource.code]),
  );
  const kept = resources.filter(
    (resource) =>
      hospitals.some((hospital) => holds(hospital, resource)) && keep(resource),
  );
  const patient = kept.find((resource) => resource.resourceType === "Patient");
  if (!patient) throw new Error("A Synthea bundle holds one Patient");
  const named = digitedNames(patient);

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
  const startsAt = new Map(
    hospitals.map((hospital) => [
      hospital,
      encounters
        .filter((encounter) => encounterAt.get(encounter.id) === hospital)
        .map((encounter) => Date.parse(String(period(encounter).start)))
        .sort((a, b) => a - b),
    ]),
  );

  const placed = new Map<HospitalFolder, Placed[]>(
    hospitals.map((hospital) => [hospital, []]),
  );
  for (const resource of kept) {
    if (resource === patient) {
      for (const hospital of hospitals) {
        if (holds(hospital, resource)) {
          placed.get(hospital)?.push({ resource, times: [] });
        }
      }
      continue;
    }
    const encounter =
      resource.resourceType === "Encounter"
        ? resource.id
        : uuidOf(visitOf(resource)?.reference);
    const at = (encounter && encounterAt.get(encounter)) || home;
    const first = recordedAt(resource);
    const stop = stoppedAt(resource, kept, medications, drugs);
    for (const hospital of hospitals) {
      if (!holds(hospital, resource)) continue;
      let from: number | undefined = first;
      if (at !== hospital) {
        // A reconciled record reaches the other hospital when a visit there
        // finds it active.
        from = RECONCILED.includes(resource.resourceType)
          ? startsAt
              .get(hospital)
              ?.find(
                (start) =>
                  start >= first && (stop === undefined || start < stop),
              )
          : undefined;
      }
      if (from !== undefined) {
        placed.get(hospital)?.push({
          resource,
          times: stop !== undefined && stop > from ? [from, stop] : [from],
        });
      }
    }
  }

  return hospitals.map((hospital) => {
    const all = placed.get(hospital) ?? [];
    const served = new Set(all.map(({ resource }) => resource.id));
    const here = all.filter(
      ({ resource }) =>
        resource.resourceType !== "DiagnosticReport" ||
        resource.presentedForm !== undefined ||
        ((resource.result as Json[] | undefined) ?? []).some((result) =>
          served.has(uuidOf(result.reference) ?? ""),
        ),
    );
    const earliest = Math.min(...here.flatMap((each) => each.times));
    if (!Number.isFinite(earliest)) {
      throw new Error(
        `${hospital.folder} holds no record of the Synthea person`,
      );
    }
    for (const each of here) {
      if (each.resource === patient) each.times = [earliest];
    }
    const ids = new Map(
      here.map(({ resource }) => [
        resource.id,
        `${resource.resourceType}/${syntheaId(hospital.folder, resource.id)}`,
      ]),
    );
    const entry = here.flatMap(({ resource, times }) => {
      const final = rewrite(resource, hospital, ids, drugs, named, payers);
      return times.map((time, index) =>
        historyEntry(
          index === 0 && times.length > 1 ? earlier(final) : final,
          String(index + 1),
          new Date(time).toISOString(),
        ),
      );
    });
    return {
      folder: hospital.folder,
      id: syntheaId(hospital.folder, patient.id),
      bundle: { resourceType: "Bundle" as const, type: "history", entry },
    };
  });
}

function holds(hospital: HospitalFolder, resource: Resource): boolean {
  return hospital.hospital.types.includes(resource.resourceType);
}

function keep(resource: Resource): boolean {
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

/** The visit a record was made at: a note names it in `context`. */
function visitOf(resource: Resource): Json | undefined {
  const context = resource.context as { encounter?: Json[] } | undefined;
  return (resource.encounter as Json | undefined) ?? context?.encounter?.[0];
}

function period(resource: Resource): Json {
  return (resource.period as Json | undefined) ?? {};
}

/** The instant a record's final content first holds. */
function recordedAt(resource: Resource): number {
  const dates: Record<string, unknown> = {
    MedicationRequest: resource.authoredOn,
    Condition: resource.recordedDate,
    AllergyIntolerance: resource.recordedDate,
    Observation: resource.issued,
    Immunization: resource.occurrenceDateTime,
    Procedure: (resource.performedPeriod as Json | undefined)?.end,
    Encounter: period(resource).end,
    DiagnosticReport: resource.issued,
    DocumentReference: resource.date,
  };
  const at = Date.parse(String(dates[resource.resourceType]));
  if (Number.isNaN(at)) {
    throw new Error(
      `${resource.resourceType}/${resource.id} has no date to be first recorded at`,
    );
  }
  return at;
}

/** The instant a record changed after it was first recorded, if it did. */
function stoppedAt(
  resource: Resource,
  all: Resource[],
  rows: MedicationRow[],
  drugs: Map<string, unknown>,
): number | undefined {
  const name = `${resource.resourceType}/${resource.id}`;
  if (resource.resourceType === "Condition") {
    const code = clinicalCode(resource);
    if (code === "active") return undefined;
    const abated = Date.parse(String(resource.abatementDateTime));
    if (Number.isNaN(abated)) {
      throw new Error(`${name} is ${code}, but gives no abatementDateTime`);
    }
    return abated;
  }
  if (resource.resourceType !== "MedicationRequest") return undefined;
  if (resource.status === "active") return undefined;
  const code = drugCode(resource, drugs);
  const authored = Date.parse(String(resource.authoredOn));
  const row = rows.filter(
    (each) =>
      each.encounter ===
        uuidOf((resource.encounter as Json | undefined)?.reference) &&
      each.code === code &&
      Date.parse(each.start) === authored,
  );
  const stop = row.length === 1 ? Date.parse(row[0]!.stop) : NaN;
  if (Number.isNaN(stop)) {
    throw new Error(
      `${name} is ${String(resource.status)}, but medications.csv gives it no stop`,
    );
  }
  // A renewal of the same drug replaces the order before its stop.
  const renewals = all
    .filter(
      (other) =>
        other.resourceType === "MedicationRequest" &&
        drugCode(other, drugs) === code &&
        Date.parse(String(other.authoredOn)) > authored,
    )
    .map((other) => Date.parse(String(other.authoredOn)));
  return Math.min(stop, ...renewals);
}

function clinicalCode(condition: Resource): unknown {
  const status = condition.clinicalStatus as Json | undefined;
  return (status?.coding as Json[] | undefined)?.[0]?.code;
}

function drugCode(order: Resource, drugs: Map<string, unknown>): unknown {
  const concept =
    order.medicationCodeableConcept ??
    drugs.get(
      uuidOf((order.medicationReference as Json | undefined)?.reference) ?? "",
    );
  return ((concept as Json | undefined)?.coding as Json[] | undefined)?.[0]
    ?.code;
}

/** The record as it stood before its change: an order not yet stopped, a condition not yet abated. */
function earlier(resource: Resource): Resource {
  if (resource.resourceType === "MedicationRequest") {
    return { ...resource, status: "active" };
  }
  const copy = structuredClone(resource) as Json;
  delete copy.abatementDateTime;
  const coding = ((copy.clinicalStatus as Json).coding as Json[])[0]!;
  coding.code = "active";
  if ("display" in coding) coding.display = "Active";
  return copy as Resource;
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
  drugs: Map<string, unknown>,
  named: string[],
  payers: string[],
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
    copy.name = stripDigits(copy.name);
    const extensions = ((copy.extension as Json[] | undefined) ?? []).filter(
      (extension) => !String(extension.url).startsWith(SYNTHEA_EXTENSIONS),
    );
    for (const extension of extensions) {
      if (extension.url === MAIDEN_NAME) {
        extension.valueString = stripDigits(extension.valueString);
      }
    }
    if (extensions.length > 0) copy.extension = extensions;
    else delete copy.extension;
  } else {
    delete copy.identifier;
  }
  const medication = uuidOf(
    (copy.medicationReference as Json | undefined)?.reference,
  );
  if (medication !== undefined) {
    if (!drugs.has(medication)) {
      throw new Error(
        `MedicationRequest/${resource.id} names a Medication not in the bundle`,
      );
    }
    copy.medicationCodeableConcept = drugs.get(medication);
    delete copy.medicationReference;
  }
  if (resource.resourceType === "DocumentReference") {
    // A visit's note is not replaced by the next visit's.
    copy.status = "current";
  }
  for (const attachment of attachments(copy)) {
    if (typeof attachment.data !== "string") continue;
    let text = Buffer.from(attachment.data, "base64").toString("utf8");
    for (const word of named) {
      text = text.replaceAll(word, withoutDigits(word));
    }
    payers.forEach((payer, index) => {
      text = text.replaceAll(payer, fictionalPayer(index));
    });
    attachment.data = Buffer.from(text, "utf8").toString("base64");
  }
  return pruned(copy, hospital, ids) as Resource;
}

/** Synthea's payers that are no company: public programs, and none. */
const PUBLIC_PAYERS = ["Medicare", "Medicaid", "Dual Eligible", "NO_INSURANCE"];

/** Every company that pays for a visit in the bundles, by the name Synthea gives it, sorted. */
export function payerNames(bundles: Bundle[]): string[] {
  const names = bundles.flatMap((bundle) =>
    (bundle.entry ?? []).flatMap(({ resource }) => {
      if (resource?.resourceType !== "ExplanationOfBenefit") return [];
      const name = (resource.insurer as Json | undefined)?.display;
      return typeof name === "string" && !PUBLIC_PAYERS.includes(name)
        ? [name]
        : [];
    }),
  );
  return [...new Set(names)].sort();
}

function fictionalPayer(index: number): string {
  return `Cascade Demo Health Plan ${String.fromCharCode(65 + index)}`;
}

/** A note's or a report's attachments. */
function attachments(record: Json): Json[] {
  const content = (record.content as Json[] | undefined) ?? [];
  return [
    ...content.flatMap((each) =>
      each.attachment === undefined ? [] : [each.attachment as Json],
    ),
    ...((record.presentedForm as Json[] | undefined) ?? []),
  ];
}

/** The words of a Patient's names that Synthea gave digits. */
function digitedNames(patient: Resource): string[] {
  const words = JSON.stringify(patient.name ?? []).match(/\p{L}+\d+/gu) ?? [];
  return [...new Set(words)].sort((a, b) => b.length - a.length);
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
): unknown {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => pruned(item, hospital, ids))
      .filter((item) => item !== GONE);
    return items.length > 0 ? items : GONE;
  }
  if (!value || typeof value !== "object") return value;
  const object = value as Json;
  if (typeof object.reference === "string") {
    return reference(object, hospital, ids);
  }
  const result: Json = {};
  for (const [key, item] of Object.entries(object)) {
    const next = pruned(item, hospital, ids);
    if (next !== GONE) result[key] = next;
  }
  return result;
}

function reference(
  object: Json,
  hospital: HospitalFolder,
  ids: Map<string, string>,
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
  if (PROVIDER_TYPES.includes(type)) {
    return { display: hospital.hospital.name };
  }
  return typeof object.display === "string"
    ? { type, display: withoutDigits(object.display) }
    : GONE;
}
