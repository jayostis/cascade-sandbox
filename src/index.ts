import { Signer, sha256 } from "./signed.js";

export interface Hospital {
  name: string;
  colour?: string;
  fhirBase: string;
  pageSize: number;
  key: string;
  types: string[];
  hiddenFromSearch: string[];
}

export interface Resource {
  resourceType: string;
  id: string;
  [field: string]: unknown;
}

export interface Bundle {
  resourceType: "Bundle";
  type: string;
  entry?: { resource: Resource }[];
}

export interface DemoHospitalOptions {
  hospital: Hospital;
  patients: Record<string, Bundle>;
  authorizeUrl?: string;
  autoApprove?: string;
  now?: () => Date;
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
  const { hospital } = options;
  const patients = new Map(Object.entries(options.patients));
  const base = hospital.fhirBase.replace(/\/$/, "");
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
    const choices = [...patients]
      .map(
        ([id, bundle], index) =>
          `<label class="choice"><input type="radio" name="patient" value="${escape(id)}"${index === 0 ? " checked" : ""}> ${escape(patientName(bundle, id))}</label>`,
      )
      .join("\n        ");
    const scopes = (parameters.get("scope") ?? "")
      .split(" ")
      .filter(Boolean)
      .map(
        (scope) =>
          `<li>${escape(scopeInWords(scope) ?? scope)}<code>${escape(scope)}</code></li>`,
      )
      .join("\n        ");
    return page(
      hospital,
      `<h1>Sign in</h1>
      <p>The app <strong>${escape(parameters.get("client_id") ?? "")}</strong> wants to connect to your record at ${escape(hospital.name)}.</p>
      <form method="post" action="${escape(authorizeUrl)}">
        ${hiddenInputs}
        <fieldset>
        <legend>Sign in as</legend>
        ${choices}
        </fieldset>
        <h2>If you allow it, the app can</h2>
        <ul class="scopes">
        ${scopes}
        </ul>
        <div class="actions">
          <button type="submit" name="decision" value="allow" class="allow">Allow</button>
          <button type="submit" name="decision" value="cancel">Cancel</button>
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
    const [type, id, ...rest] = segments.split("/").filter(Boolean);
    if (!type || rest.length > 0 || !hospital.types.includes(type)) {
      return outcome(404, "not-found", `${hospital.name} serves no ${type}.`);
    }
    const records = recordsOf(patient);
    if (id !== undefined) {
      const record = records.find(
        (resource) => resource.resourceType === type && resource.id === id,
      );
      return record
        ? fhirJson(200, record)
        : outcome(404, "not-found", `No ${type}/${id}.`);
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

  function recordsOf(patient: string): Resource[] {
    return (patients.get(patient)?.entry ?? []).map((entry) => entry.resource);
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

function patientName(bundle: Bundle, id: string): string {
  const patient = bundle.entry?.find(
    (entry) => entry.resource.resourceType === "Patient",
  )?.resource as { name?: { given?: string[]; family?: string }[] } | undefined;
  const name = patient?.name?.[0];
  return name ? [...(name.given ?? []), name.family].join(" ") : id;
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

function page(hospital: Hospital, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escape(hospital.name)} (demo)</title>
    <style>
      :root { --hospital: ${escape(hospital.colour ?? "#3d4f5c")}; }
      * { box-sizing: border-box; }
      body { margin: 0; background: #eef1f4; color: #1f2a33; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      header { background: var(--hospital); color: #fff; padding: 14px 16px; }
      header div { max-width: 460px; margin: 0 auto; display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 1.1rem; }
      header span { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 6px; background: #fff; color: var(--hospital); font-size: 1.4rem; line-height: 1; }
      header p { margin: 0; }
      header small { display: block; font-weight: 400; font-size: 0.8rem; opacity: 0.85; }
      main { max-width: 460px; margin: 24px auto; padding: 24px; background: #fff; border-radius: 10px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12); }
      @media (max-width: 500px) { main { margin: 0; border-radius: 0; box-shadow: none; padding: 20px 16px; } }
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
      @media (max-width: 500px) { footer { margin-top: 16px; } }
    </style>
  </head>
  <body>
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

export * from "./route.js";
