import {
  HospitalDataError,
  type RecordVersion,
  isInstant,
  patientRecords,
  time,
  versionsUpTo,
} from "./history.js";
import { Signer, sha256 } from "./signed.js";

export interface Hospital {
  name: string;
  /** A dark CSS colour: the header and the Allow button carry white text on it. */
  colour?: string;
  fhirBase: string;
  /** The towns a person would search for it by, as `"Bellingham, WA"`. */
  places?: string[];
  pageSize: number;
  key: string;
  types: string[];
  hiddenFromSearch: string[];
}

/** One result of a story's pair, by the day it was taken. */
export interface StoryResult {
  date: string;
  value: number;
}

/** What a story's data shows of one medication and one test, in the words of an analysis's finding. */
export interface StoryFinding {
  kind: "after start" | "after stop";
  /** A bare RxNorm code. */
  medication: string;
  /** A bare LOINC code. */
  test: string;
  /** The day the medication started or stopped. */
  date: string;
  direction: "up" | "down" | "not enough results";
  unit: string;
  before: StoryResult[];
  after: StoryResult[];
}

/** A pull of a story's record from its hospital as the record stood on a date, saved under a name. */
export interface StoryPull {
  /** The folder the pull is saved as. */
  name: string;
  /** The world's date the hospital answers for, a FHIR instant. */
  asOf: string;
}

/** A synthetic patient whose data holds a planted finding, or none, and the written answer. */
export interface Story {
  /** The patient's id at the hospital. */
  patient: string;
  hospital: string;
  story: string;
  findings: StoryFinding[];
  /** The file name, under the stories folder, of the same record as a C-CDA document. */
  ccda?: string;
  /** The pulls a conformance kit saves of the story, in the order they are made. */
  pulls?: StoryPull[];
}

export interface Resource {
  resourceType: string;
  id: string;
  [field: string]: unknown;
}

export interface BundleEntry {
  fullUrl?: string;
  /** Absent only on a history entry whose request is a DELETE. */
  resource?: Resource;
  request?: { method: "POST" | "PUT" | "DELETE"; url: string };
  response?: { status: string; lastModified?: string; etag?: string };
}

export interface Bundle {
  resourceType: "Bundle";
  type: string;
  entry?: BundleEntry[];
}

export interface DemoHospitalOptions {
  hospital: Hospital;
  patients: Record<string, Bundle>;
  authorizeUrl?: string;
  autoApprove?: string;
  /** The protocol clock: when codes and tokens expire. */
  now?: () => Date;
  /** The world's date, a FHIR instant: the hospital answers with its records as they stood then. Absent: every record's latest version. */
  asOf?: string;
}

export type DemoHospital = (request: Request) => Promise<Response>;

const CODE_LIFETIME = 5 * 60;
const TOKEN_LIFETIME = 60 * 60;
const AUTHORIZE_PARAMETERS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "aud",
  "code_challenge",
  "code_challenge_method",
];
const FHIR_JSON = "application/fhir+json";
const NO_STORE = { "Cache-Control": "no-store" };

export function demoHospital(options: DemoHospitalOptions): DemoHospital {
  const { hospital, asOf } = options;
  if (asOf !== undefined && !isInstant(asOf)) {
    throw new HospitalDataError(
      "asOf",
      "asOf is an instant, as 2024-02-01T00:00:00Z",
    );
  }
  const base = hospital.fhirBase.replace(/\/$/, "");
  const charts = new Map<string, Map<string, readonly RecordVersion[]>>();
  for (const [patient, records] of patientRecords(base, options.patients)) {
    const chart = new Map<string, readonly RecordVersion[]>();
    for (const [record, versions] of records) {
      const then = versionsUpTo(versions, asOf);
      if (then.length > 0) chart.set(record, then);
    }
    if (chart.get(`Patient/${patient}`)?.at(-1)?.resource) {
      charts.set(patient, chart);
    }
  }
  const patients = new Map(
    [...charts].map(([patient, chart]) => [
      patient,
      [...chart.values()].flatMap(
        (versions) => versions.at(-1)?.resource ?? [],
      ),
    ]),
  );
  const authorizeUrl = options.authorizeUrl ?? `${base}/authorize`;
  const tokenUrl = `${base}/token`;
  const now = options.now ?? (() => new Date());
  const signer = new Signer(hospital.key);
  const hidden = new Set(hospital.hiddenFromSearch);
  if (options.autoApprove !== undefined && !patients.has(options.autoApprove)) {
    throw new Error(
      `${hospital.name} has no patient ${options.autoApprove} to auto-approve`,
    );
  }

  const seconds = () => Math.floor(now().getTime() / 1000);

  async function authorize(
    parameters: URLSearchParams,
    form: boolean,
  ): Promise<Response> {
    const redirect = parseUrl(parameters.get("redirect_uri"));
    if (!redirect || !parameters.get("client_id")) {
      return html(
        400,
        page(
          hospital,
          "<h1>This sign-in cannot go on</h1><p>This sign-in request has no valid <code>redirect_uri</code> or no <code>client_id</code>, so it cannot be answered by sending you back to the app.</p>",
        ),
      );
    }
    const state = parameters.get("state");
    const back = (answer: Record<string, string>) => {
      const location = new URL(redirect);
      for (const [name, value] of Object.entries(answer)) {
        location.searchParams.set(name, value);
      }
      if (state !== null) location.searchParams.set("state", state);
      return new Response(null, {
        status: 302,
        headers: { Location: location.href },
      });
    };
    if (parameters.get("response_type") !== "code") {
      return back({ error: "unsupported_response_type" });
    }
    if (
      !parameters.get("code_challenge") ||
      parameters.get("code_challenge_method") !== "S256" ||
      (parameters.get("aud") ?? "").replace(/\/$/, "") !== base
    ) {
      return back({ error: "invalid_request" });
    }

    let patient: string | undefined;
    if (form) {
      if (parameters.get("decision") === "cancel") {
        return back({ error: "access_denied" });
      }
      patient = parameters.get("patient") ?? undefined;
      if (parameters.get("decision") !== "allow" || !patient) {
        return back({ error: "invalid_request" });
      }
      if (!patients.has(patient)) return back({ error: "access_denied" });
    } else if (options.autoApprove !== undefined) {
      patient = options.autoApprove;
    } else {
      return html(200, signInPage(parameters));
    }

    const code = await signer.sign({
      use: "code",
      patient,
      client: parameters.get("client_id"),
      redirect: parameters.get("redirect_uri"),
      challenge: parameters.get("code_challenge"),
      scope: parameters.get("scope") ?? "",
      exp: seconds() + CODE_LIFETIME,
    });
    return back({ code });
  }

  function signInPage(parameters: URLSearchParams): string {
    const hiddenInputs = AUTHORIZE_PARAMETERS.filter((name) =>
      parameters.has(name),
    )
      .map(
        (name) =>
          `<input type="hidden" name="${name}" value="${escape(parameters.get(name) ?? "")}">`,
      )
      .join("\n      ");
    const hint = nameWords(parameters.get("login_hint") ?? "");
    const choices = [...patients.keys()]
      .map((id) => ({ id, ...namesOf(personOf(id), id) }))
      .sort(
        (first, second) =>
          first.family.localeCompare(second.family) ||
          first.given.localeCompare(second.given),
      )
      .map(
        ({ id, family, given }) =>
          `<label class="choice"><input type="radio" name="patient" value="${escape(id)}" required${hint !== "" && nameWords(`${given} ${family}`) === hint ? " checked" : ""}> ${escape([family, given].filter(Boolean).join(", "))}</label>`,
      )
      .join("\n        ");
    const scopes = (parameters.get("scope") ?? "")
      .split(" ")
      .filter(Boolean)
      .map((scope) => {
        const words = scopeInWords(scope);
        return words === undefined
          ? `<li><code>${escape(scope)}</code></li>`
          : `<li>${escape(words)}<code>${escape(scope)}</code></li>`;
      })
      .join("\n        ");
    const asOfLine =
      asOf === undefined
        ? ""
        : `
      <p class="as-of">Records as they stood on <time datetime="${escape(asOf)}">${inWords(asOf)}</time>.</p>`;
    return page(
      hospital,
      `<h1>Sign in</h1>${asOfLine}
      <p>The app <strong>${escape(parameters.get("client_id") ?? "")}</strong> wants to connect to your record at ${escape(hospital.name)}.</p>
      <form method="post" action="${escape(authorizeUrl)}">
        ${hiddenInputs}
        <fieldset>
        <legend>Sign in as</legend>
        ${choices}
        </fieldset>
        ${
          scopes &&
          `<h2>If you allow it, the app can</h2>
        <ul class="scopes">
        ${scopes}
        </ul>`
        }
        <div class="actions">
          <button type="submit" name="decision" value="allow" class="allow">Allow</button>
          <button type="submit" name="decision" value="cancel" formnovalidate>Cancel</button>
        </div>
      </form>`,
    );
  }

  async function exchange(form: URLSearchParams): Promise<Response> {
    const grantType = form.get("grant_type");
    if (!grantType) return tokenError("invalid_request");
    if (grantType !== "authorization_code") {
      return tokenError("unsupported_grant_type");
    }
    const [code, redirect, client, verifier] = [
      "code",
      "redirect_uri",
      "client_id",
      "code_verifier",
    ].map((name) => form.get(name));
    if (!code || !redirect || !client || !verifier) {
      return tokenError("invalid_request");
    }
    const note = await signer.verify(code);
    if (
      !note ||
      note.use !== "code" ||
      typeof note.exp !== "number" ||
      note.exp <= seconds() ||
      note.redirect !== redirect ||
      note.client !== client ||
      note.challenge !== (await sha256(verifier))
    ) {
      return tokenError("invalid_grant");
    }
    const scope = typeof note.scope === "string" ? note.scope : "";
    const accessToken = await signer.sign({
      use: "token",
      patient: note.patient,
      scope,
      exp: seconds() + TOKEN_LIFETIME,
    });
    return json(200, NO_STORE, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: TOKEN_LIFETIME,
      scope,
      patient: note.patient,
    });
  }

  async function fhir(request: Request, url: URL): Promise<Response> {
    const bearer = /^Bearer (.+)$/.exec(
      request.headers.get("Authorization") ?? "",
    )?.[1];
    const note = bearer ? await signer.verify(bearer) : undefined;
    if (
      !note ||
      note.use !== "token" ||
      typeof note.exp !== "number" ||
      note.exp <= seconds() ||
      typeof note.patient !== "string" ||
      !patients.has(note.patient)
    ) {
      return outcome(401, "login", "A valid bearer token is required.", {
        "WWW-Authenticate": "Bearer",
      });
    }
    const patient = note.patient;
    const segments = url.pathname.slice(new URL(base).pathname.length);
    const [type, id, history, vid, ...rest] = segments
      .split("/")
      .filter(Boolean);
    if (type === "_history" || id === "_history") {
      return outcome(
        404,
        "not-supported",
        "A history is read for one record, as <type>/<id>/_history.",
      );
    }
    if (
      !type ||
      rest.length > 0 ||
      (history !== undefined && history !== "_history") ||
      !hospital.types.includes(type)
    ) {
      return outcome(404, "not-found", `${hospital.name} serves no ${type}.`);
    }
    const interaction = id === undefined ? "search" : "read";
    const scope = typeof note.scope === "string" ? note.scope : "";
    if (!granted(scope, type).includes(interaction === "search" ? "s" : "r")) {
      return outcome(
        403,
        "forbidden",
        `The token's scopes do not cover a ${interaction} of ${type}.`,
      );
    }
    const records = patients.get(patient) ?? [];
    if (id !== undefined) {
      const record = `${type}/${id}`;
      const versions = charts.get(patient)?.get(record) ?? [];
      if (vid !== undefined) {
        const version = versions.find(({ versionId }) => versionId === vid);
        if (!version) {
          return outcome(404, "not-found", `No ${record} version ${vid}.`);
        }
        return version.resource
          ? fhirJson(200, version.resource)
          : outcome(410, "deleted", `${record} version ${vid} is a deletion.`);
      }
      if (versions.length === 0) {
        return outcome(404, "not-found", `No ${record}.`);
      }
      if (history !== undefined) {
        return historyOf(type, record, versions, url.searchParams);
      }
      const resource = versions.at(-1)?.resource;
      return resource
        ? fhirJson(200, resource)
        : outcome(410, "deleted", `${record} was deleted.`);
    }

    if (type === "Patient") {
      return outcome(
        404,
        "not-found",
        "A Patient is read by id, not searched.",
      );
    }
    const query = url.searchParams;
    const asked = patientId(query.get("patient"), base);
    if (!asked) {
      return outcome(400, "required", "A search needs a patient.");
    }
    if (asked !== patient) {
      return outcome(403, "forbidden", "This token is for another patient.");
    }
    const count = positive(query.get("_count")) ?? hospital.pageSize;
    const pageParameter = query.get("_page");
    const start = pageParameter === null ? 0 : position(pageParameter);
    if (start === undefined) {
      return outcome(
        400,
        "invalid",
        "This page is not one this hospital gave.",
      );
    }
    const category = query.get("category");
    const wanted = category?.split(",").map(token);
    const matches = records.filter(
      (resource) =>
        resource.resourceType === type &&
        !hidden.has(`${type}/${resource.id}`) &&
        (wanted === undefined ||
          categories(resource).some((coding) =>
            wanted.some(
              (want) =>
                want.code === coding.code &&
                (want.system === undefined ||
                  want.system === (coding.system ?? "")),
            ),
          )),
    );
    const link = (offset: number) => {
      const next = new URL(`${base}/${type}`);
      next.searchParams.set("patient", patient);
      if (category !== null) next.searchParams.set("category", category);
      next.searchParams.set("_count", String(count));
      if (offset > 0) next.searchParams.set("_page", pagePosition(offset));
      return next.href;
    };
    const links = [{ relation: "self", url: link(start) }];
    if (start + count < matches.length) {
      links.push({ relation: "next", url: link(start + count) });
    }
    return fhirJson(200, {
      resourceType: "Bundle",
      type: "searchset",
      total: matches.length,
      link: links,
      entry: matches.slice(start, start + count).map((resource) => ({
        fullUrl: `${base}/${type}/${resource.id}`,
        resource,
        search: { mode: "match" },
      })),
    });
  }

  function historyOf(
    type: string,
    record: string,
    versions: readonly RecordVersion[],
    query: URLSearchParams,
  ): Response {
    const since = query.get("_since");
    if (since !== null && !isInstant(since)) {
      return outcome(
        400,
        "invalid",
        "_since is an instant, as 2024-02-01T00:00:00Z.",
      );
    }
    const at = query.get("_at");
    const during = at === null ? undefined : period(at);
    if (at !== null && during === undefined) {
      return outcome(
        400,
        "invalid",
        "_at is a date or a dateTime, as 2024 or 2024-02-01T00:00:00Z.",
      );
    }
    const kept = versions.filter((version, index) => {
      const from = time(version);
      if (since !== null && !(from >= Date.parse(since))) return false;
      if (during === undefined) return true;
      const next = versions[index + 1];
      const until = next === undefined ? Number.POSITIVE_INFINITY : time(next);
      return from < during.end && until > during.start;
    });
    return fhirJson(200, {
      resourceType: "Bundle",
      type: "history",
      total: kept.length,
      entry: kept.reverse().map((version) => {
        const before = versions[versions.indexOf(version) - 1];
        const created = !before?.resource;
        return {
          fullUrl: `${base}/${record}`,
          ...(version.resource ? { resource: version.resource } : {}),
          request: !version.resource
            ? { method: "DELETE", url: record }
            : created
              ? { method: "POST", url: type }
              : { method: "PUT", url: record },
          response: {
            status: !version.resource ? "204" : created ? "201" : "200",
            ...(version.recorded === undefined
              ? {}
              : { lastModified: version.recorded }),
            etag: `W/"${version.versionId}"`,
          },
        };
      }),
    });
  }

  function personOf(patient: string): Resource | undefined {
    return charts.get(patient)?.get(`Patient/${patient}`)?.at(-1)?.resource;
  }

  return async (request) => {
    const url = new URL(request.url);
    const address = `${url.origin}${url.pathname}`.replace(/\/$/, "");
    if (address === authorizeUrl.replace(/\/$/, "")) {
      if (request.method === "GET") return authorize(url.searchParams, false);
      if (request.method === "POST") {
        return authorize(new URLSearchParams(await request.text()), true);
      }
    }
    if (address === `${base}/.well-known/smart-configuration`) {
      if (request.method !== "GET") return notAllowed("GET");
      return json(200, NO_STORE, {
        issuer: base,
        authorization_endpoint: authorizeUrl,
        token_endpoint: tokenUrl,
        grant_types_supported: ["authorization_code"],
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["launch/patient", "patient/*.read", "patient/*.rs"],
        capabilities: [
          "launch-standalone",
          "client-public",
          "context-standalone-patient",
          "permission-patient",
        ],
      });
    }
    if (address === tokenUrl) {
      if (request.method !== "POST") return notAllowed("POST");
      return exchange(new URLSearchParams(await request.text()));
    }
    if (address.startsWith(`${base}/`) && request.method === "GET") {
      return fhir(request, url);
    }
    return outcome(404, "not-found", `${hospital.name} has nothing here.`);
  };
}

function parseUrl(text: string | null): URL | undefined {
  if (!text) return undefined;
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

function positive(text: string | null): number | undefined {
  const value = Number(text);
  return text !== null && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function pagePosition(offset: number): string {
  return btoa(`at:${offset}`).replace(/=+$/, "");
}

function position(page: string): number | undefined {
  try {
    const match = /^at:(\d+)$/.exec(atob(page));
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

interface Coding {
  system?: string;
  code?: string;
}

function categories(resource: Resource): Coding[] {
  const category = resource.category;
  if (!Array.isArray(category)) return [];
  return category.flatMap(
    (concept: { coding?: Coding[] }) => concept.coding ?? [],
  );
}

function token(text: string): { system?: string; code: string } {
  const bar = text.indexOf("|");
  return bar === -1
    ? { code: text }
    : { system: text.slice(0, bar), code: text.slice(bar + 1) };
}

/**
 * A name's words, lower-cased, without accents and in alphabetical order, so a pod's name (`rowan-ellery-marsh`) and
 * a patient's (`Marsh`, `Rowan Ellery`) are the same whichever way round they are written.
 */
function nameWords(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function namesOf(
  patient: Resource | undefined,
  id: string,
): { family: string; given: string } {
  const name = (
    patient as { name?: { given?: string[]; family?: string }[] } | undefined
  )?.name?.[0];
  return name
    ? { family: name.family ?? "", given: (name.given ?? []).join(" ") }
    : { family: id, given: "" };
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** An instant's UTC day in words: `1 February 2024`. */
function inWords(instant: string): string {
  const day = new Date(Date.parse(instant));
  return `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
}

/** The letters of `cruds` that a token's scopes grant on `type`. */
function granted(scopes: string, type: string): string {
  const letters = new Set<string>();
  for (const scope of scopes.split(" ")) {
    const match = /^patient\/(\*|[A-Za-z]+)\.(read|write|\*|c?r?u?d?s?)$/.exec(
      scope,
    );
    if (!match || (match[1] !== "*" && match[1] !== type)) continue;
    const asked = match[2] ?? "";
    const given =
      asked === "read"
        ? "rs"
        : asked === "write"
          ? "cud"
          : asked === "*"
            ? "cruds"
            : asked;
    for (const letter of given) letters.add(letter);
  }
  return [...letters].join("");
}

/** The period a FHIR date or dateTime names at its precision, in milliseconds, its end excluded: `2024` is the whole year. */
function period(text: string): { start: number; end: number } | undefined {
  const date = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?)?$/.exec(
    text,
  );
  if (date) {
    const [year, month, day] = date
      .slice(1)
      .map((part) => (part === undefined ? undefined : Number(part)));
    const start = Date.UTC(year!, (month ?? 1) - 1, day ?? 1);
    const end =
      day !== undefined
        ? Date.UTC(year!, month! - 1, day + 1)
        : month !== undefined
          ? Date.UTC(year!, month, 1)
          : Date.UTC(year! + 1, 0, 1);
    if (
      year! < 1000 ||
      (day !== undefined && new Date(start).getUTCDate() !== day)
    ) {
      return undefined;
    }
    return { start, end };
  }
  if (!isInstant(text)) return undefined;
  const start = Date.parse(text);
  return { start, end: start + (text.includes(".") ? 1 : 1000) };
}

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scopeInWords(scope: string): string | undefined {
  if (scope === "launch/patient") return "Know which patient you are";
  const read = /^patient\/(\*|[A-Za-z]+)\.(read|rs)$/.exec(scope)?.[1];
  if (read === undefined) return undefined;
  return read === "*"
    ? "Read your whole health record"
    : `Read your ${read} records`;
}

const STYLE = `
* { box-sizing: border-box; }
body { margin: 0; background: #eef1f4; color: #1f2a33; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header { background: var(--hospital); color: #fff; padding: 14px 16px; }
header div { max-width: 460px; margin: 0 auto; display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 1.1rem; }
header span { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 6px; background: #fff; color: var(--hospital); font-size: 1.4rem; line-height: 1; }
header p { margin: 0; }
header small { display: block; font-weight: 400; font-size: 0.8rem; opacity: 0.85; }
main { max-width: 460px; margin: 24px auto; padding: 24px; background: #fff; border-radius: 10px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12); }
h1 { margin: 0 0 8px; font-size: 1.4rem; }
h2 { margin: 20px 0 8px; font-size: 1rem; }
fieldset { margin: 16px 0 0; padding: 0; border: 0; }
legend { padding: 0; margin-bottom: 8px; font-weight: 600; }
.choice { display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin-bottom: 8px; border: 1px solid #ccd3da; border-radius: 8px; cursor: pointer; }
.choice:has(input:checked) { border-color: var(--hospital); background: #f4f8fb; }
.choice input { accent-color: var(--hospital); margin: 0; }
.scopes { margin: 0; padding: 0; list-style: none; }
.scopes li { padding: 8px 0; border-top: 1px solid #e3e7eb; }
.scopes code { display: block; color: #66727d; font-size: 0.75rem; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
button { flex: 1 1 140px; padding: 12px; border-radius: 8px; border: 1px solid #9aa6b1; background: #fff; color: #1f2a33; font: inherit; font-weight: 600; cursor: pointer; }
button.allow { border-color: var(--hospital); background: var(--hospital); color: #fff; }
button:focus-visible { outline: 3px solid #f2b705; outline-offset: 2px; }
footer { max-width: 460px; margin: 0 auto 24px; padding: 0 16px; color: #56636e; font-size: 0.85rem; text-align: center; }
@media (max-width: 500px) {
  main { margin: 0; border-radius: 0; box-shadow: none; padding: 20px 16px; }
  footer { margin-top: 16px; }
}
`;

function page(hospital: Hospital, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escape(hospital.name)} (demo)</title>
    <style>${STYLE}</style>
  </head>
  <body style="--hospital: ${escape(hospital.colour ?? "#3d4f5c")}">
    <header><div><span aria-hidden="true">+</span><p>${escape(hospital.name)}<small>Patient portal</small></p></div></header>
    <main>
      ${body}
    </main>
    <footer>A demo hospital for testing apps: there is no password, and every patient here is made up.</footer>
  </body>
</html>
`;
}

function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function json(
  status: number,
  headers: Record<string, string>,
  body: unknown,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function fhirJson(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return json(status, { "Content-Type": FHIR_JSON, ...headers }, body);
}

function tokenError(error: string): Response {
  return json(400, NO_STORE, { error });
}

function notAllowed(allow: string): Response {
  return outcome(
    405,
    "not-supported",
    "This address does not take that method.",
    {
      Allow: allow,
    },
  );
}

function patientId(reference: string | null, base: string): string | null {
  for (const prefix of [`${base}/Patient/`, "Patient/"]) {
    if (reference?.startsWith(prefix)) return reference.slice(prefix.length);
  }
  return reference;
}

function outcome(
  status: number,
  code: string,
  diagnostics: string,
  headers: Record<string, string> = {},
): Response {
  return fhirJson(
    status,
    {
      resourceType: "OperationOutcome",
      issue: [{ severity: "error", code, diagnostics }],
    },
    headers,
  );
}

export {
  HospitalDataError,
  type RecordVersion,
  recordsAt,
  versionsOf,
} from "./history.js";
export * from "./route.js";
export { demoRemapFetch } from "./remap.js";
export { brandsBundle } from "./brands.js";
