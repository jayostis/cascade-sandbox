import { Signer, sha256 } from "./signed.js";

export interface Hospital {
  name: string;
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

export function demoHospital(options: DemoHospitalOptions): DemoHospital {
  const { hospital, patients } = options;
  const base = hospital.fhirBase.replace(/\/$/, "");
  const authorizeUrl = options.authorizeUrl ?? `${base}/authorize`;
  const tokenUrl = `${base}/token`;
  const now = options.now ?? (() => new Date());
  const signer = new Signer(hospital.key);
  const hidden = new Set(hospital.hiddenFromSearch);
  if (options.autoApprove !== undefined && !patients[options.autoApprove]) {
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
    if (!redirect) {
      return html(
        400,
        page(
          hospital.name,
          "<p>This sign-in request has no valid <code>redirect_uri</code>, so there is nowhere to send you back to.</p>",
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
      !parameters.get("client_id") ||
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
      if (!patients[patient]) return back({ error: "access_denied" });
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
    const choices = Object.entries(patients)
      .map(
        ([id, bundle], index) =>
          `<label><input type="radio" name="patient" value="${escape(id)}"${index === 0 ? " checked" : ""}> ${escape(patientName(bundle, id))}</label>`,
      )
      .join("\n      ");
    const scopes = (parameters.get("scope") ?? "")
      .split(" ")
      .filter(Boolean)
      .map((scope) => `<li><code>${escape(scope)}</code></li>`)
      .join("");
    return page(
      hospital.name,
      `<p>This is a demo hospital for testing. There is no password, and every patient here is made up.</p>
    <p>The app <strong>${escape(parameters.get("client_id") ?? "")}</strong> asks to read your record:</p>
    <ul>${scopes}</ul>
    <form method="post" action="${escape(authorizeUrl)}">
      ${hiddenInputs}
      <fieldset>
      <legend>Sign in as</legend>
      ${choices}
      </fieldset>
      <button type="submit" name="decision" value="allow">Allow</button>
      <button type="submit" name="decision" value="cancel">Cancel</button>
    </form>`,
    );
  }

  async function token(form: URLSearchParams): Promise<Response> {
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
    return json(200, {
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
      !patients[note.patient]
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

    const query = url.searchParams;
    const asked = query.get("patient");
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
    const matches = records.filter(
      (resource) =>
        resource.resourceType === type &&
        !hidden.has(`${type}/${resource.id}`) &&
        (category === null || categories(resource).includes(category)),
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
    return (patients[patient]?.entry ?? []).map((entry) => entry.resource);
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
      return json(200, {
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
    if (address === tokenUrl && request.method === "POST") {
      return token(new URLSearchParams(await request.text()));
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

function categories(resource: Resource): string[] {
  const category = resource.category;
  if (!Array.isArray(category)) return [];
  return category.flatMap((concept: { coding?: { code?: string }[] }) =>
    (concept.coding ?? []).flatMap((coding) =>
      coding.code ? [coding.code] : [],
    ),
  );
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

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escape(title)} (demo)</title>
  </head>
  <body>
    <h1>${escape(title)}</h1>
    <p><strong>Demo only:</strong> a pretend hospital for testing apps. Not a real sign-in.</p>
    ${body}
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function tokenError(error: string): Response {
  return json(400, { error });
}

function fhirJson(status: number, body: unknown, headers = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": FHIR_JSON, ...headers },
  });
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
