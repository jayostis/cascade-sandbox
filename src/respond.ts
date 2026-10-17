export const NO_STORE = { "Cache-Control": "no-store" };
const FHIR_JSON = "application/fhir+json";

export function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function json(
  status: number,
  headers: Record<string, string>,
  body: unknown,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function fhirJson(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return json(status, { "Content-Type": FHIR_JSON, ...headers }, body);
}

export function tokenError(
  error: string,
  status = 400,
  description?: string,
): Response {
  return json(
    status,
    NO_STORE,
    description === undefined
      ? { error }
      : { error, error_description: description },
  );
}

export function notAllowed(allow: string): Response {
  return outcome(
    405,
    "not-supported",
    "This address does not take that method.",
    {
      Allow: allow,
    },
  );
}

export function outcome(
  status: number,
  code: fhir4.OperationOutcomeIssue["code"],
  diagnostics: string,
  headers: Record<string, string> = {},
): Response {
  const body: fhir4.OperationOutcome = {
    resourceType: "OperationOutcome",
    issue: [
      {
        severity: "error",
        code,
        diagnostics,
      },
    ],
  };
  return fhirJson(status, body, headers);
}
