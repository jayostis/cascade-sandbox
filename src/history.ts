import type { Bundle, BundleEntry, Resource } from "./index.js";

export class HospitalDataError extends Error {
  readonly where: string;
  readonly reason: string;

  constructor(where: string, reason: string) {
    super(`${where}: ${reason}`);
    this.name = "HospitalDataError";
    this.where = where;
    this.reason = reason;
  }
}

export interface RecordVersion {
  /** `<type>/<id>`. */
  readonly record: string;
  /** `"1"` for a plain record with no `meta.versionId`. */
  readonly versionId: string;
  /** The record time; absent for a plain record. */
  readonly recorded?: string;
  /** Absent for a deletion. */
  readonly resource?: Resource;
}

const INSTANT =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d{1,9})?(Z|[+-]((0\d|1[0-3]):[0-5]\d|14:00))$/;

/** Whether `text` is a FHIR `instant`: a time to the second, with a timezone. */
export function isInstant(text: unknown): text is string {
  return (
    typeof text === "string" &&
    INSTANT.test(text) &&
    !Number.isNaN(Date.parse(text))
  );
}

/** Each record's versions in a patient file, oldest first, checked by the file's rules; throws HospitalDataError. */
export function versionsOf(
  bundle: Bundle,
  where: string,
): ReadonlyMap<string, readonly RecordVersion[]> {
  const refuse = (reason: string) => new HospitalDataError(where, reason);
  const records = new Map<string, RecordVersion[]>();
  const add = (version: RecordVersion) => {
    const versions = records.get(version.record);
    if (versions) versions.push(version);
    else records.set(version.record, [version]);
  };

  if (bundle.type === "collection") {
    for (const { resource } of bundle.entry ?? []) {
      if (!resource) continue;
      const record = `${resource.resourceType}/${resource.id}`;
      if (records.has(record)) {
        throw refuse(`a collection holds ${record} twice`);
      }
      add({ record, versionId: versionIdOf(resource) ?? "1", resource });
    }
    return records;
  }
  if (bundle.type !== "history") {
    throw refuse(
      `a patient file is a Bundle of type collection or history, not ${bundle.type}`,
    );
  }

  for (const entry of bundle.entry ?? []) add(historyVersion(entry, refuse));
  for (const [record, versions] of records) {
    const seen = new Set<string>();
    for (const { versionId } of versions) {
      if (seen.has(versionId)) {
        throw refuse(`${record} reuses version ${versionId}`);
      }
      seen.add(versionId);
    }
    versions.sort((a, b) => time(a) - time(b));
    let exists = false;
    versions.forEach((version, index) => {
      const before = versions[index - 1];
      if (before && time(before) === time(version)) {
        throw refuse(`${record} has two versions at ${version.recorded}`);
      }
      if (!version.resource && !exists) {
        throw refuse(`${record} is deleted while it does not exist`);
      }
      exists = version.resource !== undefined;
    });
  }
  return records;
}

function historyVersion(
  entry: BundleEntry,
  refuse: (reason: string) => HospitalDataError,
): RecordVersion {
  const method = entry.request?.method;
  if (method !== "POST" && method !== "PUT" && method !== "DELETE") {
    throw refuse(
      "a history entry has a request whose method is POST, PUT or DELETE",
    );
  }
  const url = entry.request?.url ?? "";
  const recorded = entry.response?.lastModified;
  if (!isInstant(recorded)) {
    throw refuse(
      "a history entry has a response whose lastModified is an instant",
    );
  }
  const etag = entry.response?.etag;
  const { resource } = entry;

  if (method === "DELETE") {
    if (!/^[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/.test(url)) {
      throw refuse("request.url is not <type>/<id> of its resource");
    }
    const versionId = etag === undefined ? undefined : tagged(etag);
    if (resource || versionId === undefined) {
      throw refuse(`${url} is deleted with a resource, or with no etag`);
    }
    return { record: url, versionId, recorded };
  }

  if (
    !resource ||
    url !==
      (method === "POST"
        ? resource.resourceType
        : `${resource.resourceType}/${resource.id}`)
  ) {
    throw refuse("request.url is not <type>/<id> of its resource");
  }
  const record = `${resource.resourceType}/${resource.id}`;
  const versionId = versionIdOf(resource);
  if (versionId === undefined) {
    throw refuse(`${record} has a version with no meta.versionId`);
  }
  const lastUpdated = metaOf(resource).lastUpdated;
  if (
    typeof lastUpdated !== "string" ||
    Date.parse(lastUpdated) !== Date.parse(recorded)
  ) {
    throw refuse(
      `${record} version ${versionId}: meta.lastUpdated is not the entry's response.lastModified`,
    );
  }
  if (etag !== undefined && etag !== `W/"${versionId}"`) {
    throw refuse(
      `${record} version ${versionId}: the etag is not W/"${versionId}"`,
    );
  }
  return { record, versionId, recorded, resource };
}

function metaOf(resource: Resource): Record<string, unknown> {
  const meta = resource.meta;
  return meta && typeof meta === "object"
    ? (meta as Record<string, unknown>)
    : {};
}

function versionIdOf(resource: Resource): string | undefined {
  const versionId = metaOf(resource).versionId;
  return typeof versionId === "string" && versionId !== ""
    ? versionId
    : undefined;
}

function tagged(etag: string): string | undefined {
  return /^W\/"([^"]+)"$/.exec(etag)?.[1];
}

/** A version's record time in milliseconds; a plain record's one version is earlier than every time. */
export function time(version: RecordVersion): number {
  return version.recorded === undefined
    ? Number.NEGATIVE_INFINITY
    : Date.parse(version.recorded);
}

/** The versions of a record whose record time is at or before `asOf` (every version when it is absent), oldest first. */
export function versionsUpTo(
  versions: readonly RecordVersion[],
  asOf?: string,
): readonly RecordVersion[] {
  if (asOf === undefined) return versions;
  const at = Date.parse(asOf);
  return versions.filter((version) => time(version) <= at);
}

/**
 * Each patient's records, by patient id, from a hospital's patient files: each file checked by `versionsOf`, its
 * `fullUrl`s against the hospital's FHIR base, the Patient it holds against its name, and no record in two files.
 */
export function patientRecords(
  fhirBase: string,
  patients: Record<string, Bundle>,
): Map<string, ReadonlyMap<string, readonly RecordVersion[]>> {
  const base = fhirBase.replace(/\/$/, "");
  const owners = new Set<string>();
  const checked = new Map<
    string,
    ReadonlyMap<string, readonly RecordVersion[]>
  >();
  for (const [id, bundle] of Object.entries(patients)) {
    const where = `patients/${id}.json`;
    const records = versionsOf(bundle, where);
    for (const { fullUrl, resource, request } of bundle.entry ?? []) {
      if (fullUrl === undefined) continue;
      const record = resource
        ? `${resource.resourceType}/${resource.id}`
        : (request?.url ?? "");
      if (fullUrl !== `${base}/${record}`) {
        throw new HospitalDataError(
          where,
          `fullUrl ${fullUrl} is not ${base}/${record}`,
        );
      }
    }
    for (const record of records.keys()) {
      if (owners.has(record)) {
        throw new HospitalDataError(where, `${record} is in two patient files`);
      }
      owners.add(record);
    }
    const held = [...records.keys()]
      .find((record) => record.startsWith("Patient/"))
      ?.slice("Patient/".length);
    if (held !== id) {
      throw new HospitalDataError(
        where,
        `${where} holds Patient ${held ?? "(none)"}, not ${id}`,
      );
    }
    checked.set(id, records);
  }
  return checked;
}

/** The resources present at `asOf` (every latest version when absent), each as its version then. */
export function recordsAt(bundle: Bundle, asOf?: string): Resource[] {
  if (asOf !== undefined && !isInstant(asOf)) {
    throw new HospitalDataError(
      "asOf",
      "asOf is an instant, as 2024-02-01T00:00:00Z",
    );
  }
  const resources: Resource[] = [];
  for (const versions of versionsOf(bundle, "a patient file").values()) {
    const resource = versionsUpTo(versions, asOf).at(-1)?.resource;
    if (resource) resources.push(resource);
  }
  return resources;
}
