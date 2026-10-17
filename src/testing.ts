import { createHash, randomBytes } from "node:crypto";
import { type DemoHospitalOptions, demoHospital } from "./index.js";
import type { DemoHospital } from "./index.js";

const CLIENT = "test-app";
const REDIRECT = "https://app.example/callback";
const DEFAULT_SCOPE = "launch/patient patient/*.rs";

/** A PKCE code verifier and its S256 challenge (RFC 7636). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

export interface SignedIn {
  /** The access token. */
  token: string;
  /** The authorization code that was exchanged for it, now spent. */
  code: string;
}

export interface SignInOptions {
  /** The scope the client asks for; the default is a patient launch that reads everything. */
  scope?: string;
  /** The protocol clock of the hospital built to sign in; not allowed when signing in through a `fetch`. */
  now?: () => Date;
}

/**
 * Signs in as `patient` the way a client does: the hospital's discovery, its sign-in form posted with the patient
 * allowed, and the code exchanged with a fresh PKCE pair. Given a hospital's options it builds the hospital and
 * returns it beside the token; given a `fetch` and the hospital's `base`, it signs in through that.
 */
export async function signInAs(
  hospital: DemoHospitalOptions,
  patient: string,
  options?: SignInOptions,
): Promise<SignedIn & { hospital: DemoHospital }>;
export async function signInAs(
  through: { fetch: typeof globalThis.fetch; base: string },
  patient: string,
  options?: Pick<SignInOptions, "scope">,
): Promise<SignedIn>;
export async function signInAs(
  target:
    DemoHospitalOptions | { fetch: typeof globalThis.fetch; base: string },
  patient: string,
  options: SignInOptions = {},
): Promise<SignedIn & { hospital?: DemoHospital }> {
  let hospital: DemoHospital | undefined;
  let fetch: typeof globalThis.fetch;
  let base: string;
  if ("fetch" in target) {
    if (options.now !== undefined)
      throw new TypeError(
        "now is the clock of a hospital that signInAs builds",
      );
    ({ fetch, base } = target);
  } else {
    const built = demoHospital({
      ...target,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    hospital = built;
    fetch = (input, init) => built(new Request(input, init));
    base = target.hospital.fhirBase.replace(/\/$/, "");
  }

  const { verifier, challenge } = pkcePair();
  const discovery = await (
    await fetch(`${base}/.well-known/smart-configuration`)
  ).json();
  const approved = await fetch(discovery.authorization_endpoint, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      scope: options.scope ?? DEFAULT_SCOPE,
      state: "s",
      aud: base,
      code_challenge: challenge,
      code_challenge_method: "S256",
      decision: "allow",
      patient,
    }),
  });
  const code = new URL(approved.headers.get("Location") ?? "").searchParams.get(
    "code",
  );
  if (!code)
    throw new Error(
      `${base} did not give ${patient} a code (${approved.status})`,
    );
  const answer = await (
    await fetch(discovery.token_endpoint, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT,
        code_verifier: verifier,
      }),
    })
  ).json();
  if (typeof answer.access_token !== "string")
    throw new Error(`${base} did not give ${patient} a token`);
  return {
    token: answer.access_token,
    code,
    ...(hospital === undefined ? {} : { hospital }),
  };
}
