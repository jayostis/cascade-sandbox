import { HospitalDataError, isInstant } from "./history.js";
import type { Bundle, BundleEntry, Resource } from "./index.js";

/** What a shorthand entry says of its record: when it began, and when it stopped. */
export interface Shorthand {
  active?: string;
  stopped?: string;
}

export interface ShorthandEntry {
  fullUrl?: string;
  resource?: Resource;
  shorthand?: Shorthand;
}

/** An authoring file: a `collection` whose entries may carry `shorthand` beside `resource`. */
export interface ShorthandBundle {
  resourceType: "Bundle";
  type: string;
  entry?: ShorthandEntry[];
}

const CONDITION_CLINICAL =
  "http://terminology.hl7.org/CodeSystem/condition-clinical";

/** The fields that date a record's clinical event, the first present one placing it. */
const CLINICAL_DATES = [
  "effectiveDateTime",
  "onsetDateTime",
  "authoredOn",
  "recordedDate",
  "occurrenceDateTime",
  "performedDateTime",
  "period.start",
  "effectivePeriod.start",
  "performedPeriod.start",
];

const DAY = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/** Whether a patient file's entry carries `shorthand`, so the file is an authoring file to compile. */
export function hasShorthand(bundle: Bundle | ShorthandBundle): boolean {
  return (bundle.entry ?? []).some(
    (entry) => "shorthand" in entry && entry.shorthand !== undefined,
  );
}

function instantOf(value: unknown, what: string, where: string): string {
  if (typeof value === "string") {
    const day = DAY.exec(value);
    if (day) {
      const [, year, month = "01", date = "01"] = day;
      const iso = `${year}-${month}-${date}T00:00:00Z`;
      const parsed = new Date(iso);
      if (
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().startsWith(`${year}-${month}-${date}`)
      )
        return iso;
    } else if (isInstant(value)) return value;
  }
  throw new HospitalDataError(
    where,
    `${what} ${JSON.stringify(value)} is not a date, as 2022-03-01, or an instant, as 2022-03-01T09:00:00Z`,
  );
}

function clinicalDate(resource: Resource): string | undefined {
  for (const path of CLINICAL_DATES) {
    let found: unknown = resource;
    for (const key of path.split("."))
      found = (found as Record<string, unknown> | undefined)?.[key];
    if (typeof found === "string") return found;
  }
  return undefined;
}

function version(
  resource: Resource,
  versionId: string,
  at: string,
  fullUrl: string | undefined,
): BundleEntry {
  const first = versionId === "1";
  return {
    ...(fullUrl === undefined ? {} : { fullUrl }),
    resource: {
      ...resource,
      meta: { ...meta(resource), versionId, lastUpdated: at },
    },
    request: first
      ? { method: "POST", url: resource.resourceType }
      : { method: "PUT", url: `${resource.resourceType}/${resource.id}` },
    response: first
      ? { status: "201", lastModified: at }
      : { status: "200", lastModified: at, etag: `W/"${versionId}"` },
  };
}

function meta(resource: Resource): Record<string, unknown> {
  const held = resource.meta;
  return typeof held === "object" && held !== null && !Array.isArray(held)
    ? (held as Record<string, unknown>)
    : {};
}

const medicationStopped = (
  resource: Resource,
  active: string,
  stopped: string,
): [Resource, Resource] => {
  const { effectiveDateTime, effectivePeriod, ...rest } = resource;
  const period = { ...(effectivePeriod as Record<string, unknown>) };
  delete period.end;
  const began = period.start ?? effectiveDateTime ?? active;
  const open = {
    ...rest,
    status: "active",
    effectivePeriod: { ...period, start: began },
  };
  return [
    open,
    {
      ...open,
      status: "completed",
      effectivePeriod: { ...open.effectivePeriod, end: stopped },
    },
  ];
};

const conditionStopped = (
  resource: Resource,
  stopped: string,
): [Resource, Resource] => {
  const rest = Object.fromEntries(
    Object.entries(resource).filter(([key]) => !key.startsWith("abatement")),
  ) as Resource;
  const status = (code: string, display: string) => ({
    coding: [{ system: CONDITION_CLINICAL, code, display }],
  });
  return [
    { ...rest, clinicalStatus: status("active", "Active") },
    {
      ...rest,
      clinicalStatus: status("resolved", "Resolved"),
      abatementDateTime: stopped,
    },
  ];
};

/**
 * Compiles an authoring file to the history Bundle a hospital serves. An entry with no `shorthand` is placed at its
 * clinical date (a Patient, at the file's earliest record time), as one version. A `MedicationStatement` or a
 * `Condition` with `shorthand.stopped` becomes two: active from `shorthand.active` (or its clinical date), then
 * completed or resolved on the day it stopped. Throws HospitalDataError where the dates cannot say it.
 */
export function compileShorthand(file: ShorthandBundle, where: string): Bundle {
  const refuse = (reason: string) => new HospitalDataError(where, reason);
  if (file.type !== "collection")
    throw refuse(
      `a shorthand file is a Bundle of type collection, not ${file.type}`,
    );
  const planned: {
    entry: ShorthandEntry & { resource: Resource };
    record: string;
    start?: string;
    stop?: string;
  }[] = [];
  const seen = new Set<string>();
  for (const entry of file.entry ?? []) {
    const { resource } = entry;
    const shorthand = entry.shorthand === undefined ? {} : entry.shorthand;
    if (
      typeof shorthand !== "object" ||
      shorthand === null ||
      Array.isArray(shorthand)
    )
      throw refuse("a shorthand is an object of active and stopped");
    if (resource === undefined) continue;
    const record = `${resource.resourceType}/${resource.id}`;
    if (seen.has(record)) throw refuse(`a collection holds ${record} twice`);
    seen.add(record);
    for (const key of Object.keys(shorthand))
      if (key !== "active" && key !== "stopped")
        throw refuse(
          `${record} shorthand takes active and stopped, not ${key}`,
        );
    if (shorthand.stopped !== undefined) {
      if (resource.resourceType === "MedicationRequest")
        throw refuse(
          "an R4 MedicationRequest has no date that says when it stopped: write its second version",
        );
      if (!["MedicationStatement", "Condition"].includes(resource.resourceType))
        throw refuse(`${resource.resourceType} has no field that dates a stop`);
    }
    const written = shorthand.active ?? clinicalDate(resource);
    planned.push({
      entry: { ...entry, resource },
      record,
      ...(written === undefined
        ? {}
        : {
            start: instantOf(
              written,
              shorthand.active === undefined
                ? `${record} clinical date`
                : `${record} shorthand.active`,
              where,
            ),
          }),
      ...(shorthand.stopped === undefined
        ? {}
        : {
            stop: instantOf(
              shorthand.stopped,
              `${record} shorthand.stopped`,
              where,
            ),
          }),
    });
  }
  const undated = (record: string) =>
    refuse(`${record} has no date to place it at: give shorthand.active`);
  for (const { entry, record, start } of planned)
    if (start === undefined && entry.resource.resourceType !== "Patient")
      throw undated(record);
  const earliest = planned
    .flatMap(({ start }) => start ?? [])
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const entries = planned.flatMap(({ entry, record, start, stop }) => {
    const { resource, shorthand = {}, fullUrl } = entry;
    const placed =
      start ?? (resource.resourceType === "Patient" ? earliest : undefined);
    if (placed === undefined) throw undated(record);
    if (stop === undefined || shorthand.stopped === undefined)
      return [version(resource, "1", placed, fullUrl)];
    if (Date.parse(stop) <= Date.parse(placed))
      throw refuse(
        `${record} stopped on ${shorthand.stopped}, which is not after it began on ${shorthand.active ?? clinicalDate(resource)}`,
      );
    const [open, closed] =
      resource.resourceType === "Condition"
        ? conditionStopped(resource, shorthand.stopped)
        : medicationStopped(
            resource,
            shorthand.active ?? clinicalDate(resource) ?? placed,
            shorthand.stopped,
          );
    return [
      version(open, "1", placed, fullUrl),
      version(closed, "2", stop, fullUrl),
    ];
  });
  return { resourceType: "Bundle", type: "history", entry: entries };
}
