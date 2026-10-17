import {
  HospitalDataError,
  type RecordVersion,
  isInstant,
  patientRecords,
  periodOf,
  time,
  versionsUpTo,
} from "./history.js";
import {
  categories,
  granted,
  pagePosition,
  parseUrl,
  patientId,
  position,
  positive,
  token,
} from "./request.js";
import {
  NO_STORE,
  fhirJson,
  html,
  json,
  notAllowed,
  outcome,
  tokenError,
} from "./respond.js";
import { Signer, sha256 } from "./signed.js";
import {
  escape,
  inWords,
  nameWords,
  namesOf,
  page,
  scopeInWords,
  SIMULATED_ERRORS,
  simulatedError,
} from "./signin.js";
import type { DemoHospital, DemoHospitalOptions, Resource } from "./types.js";

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
    const asked = parameters.get("simulate_error") ?? "";
    const fail = simulatedError(asked);
    if (asked !== "" && fail === undefined) {
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
      fail,
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
    const chosen = simulatedError(parameters.get("simulate_error"));
    const failures = Object.entries(SIMULATED_ERRORS)
      .map(
        ([name, words]) =>
          `<option value="${name}"${name === chosen ? " selected" : ""}>${escape(words)}</option>`,
      )
      .join("\n            ");
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
        <details${chosen === undefined ? "" : " open"}>
          <summary><label for="simulate_error">For app developers: simulate a failure</label></summary>
          <select id="simulate_error" name="simulate_error">
            <option value="">None: sign in normally</option>
            ${failures}
          </select>
        </details>
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
    const fail = simulatedError(
      typeof note.fail === "string" ? note.fail : undefined,
    );
    if (fail === "token_invalid_token") {
      return tokenError(
        "invalid_client",
        401,
        "Simulated invalid client error",
      );
    }
    if (fail === "token_invalid_scope") {
      return tokenError("invalid_scope", 401, "Simulated invalid scope error");
    }
    const scope = typeof note.scope === "string" ? note.scope : "";
    const accessToken = await signer.sign({
      use: "token",
      patient: note.patient,
      scope,
      fail,
      exp: seconds() + TOKEN_LIFETIME,
    });
    return json(200, NO_STORE, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: TOKEN_LIFETIME,
      scope,
      patient: note.patient,
      ...(fail === "request_invalid_token" && { sim_error: "Invalid token" }),
      ...(fail === "request_expired_token" && { sim_error: "Token expired" }),
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
    const fail = simulatedError(
      typeof note.fail === "string" ? note.fail : undefined,
    );
    if (fail === "request_invalid_token") {
      return outcome(401, "login", "Invalid token", {
        "WWW-Authenticate": 'Bearer error="invalid_token"',
      });
    }
    if (fail === "request_expired_token") {
      return outcome(401, "login", "Token expired", {
        "WWW-Authenticate":
          'Bearer error="invalid_token", error_description="The access token expired"',
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
    const during = at === null ? undefined : periodOf(at);
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
