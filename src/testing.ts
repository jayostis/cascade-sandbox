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

/**
 * Answers a hospital's sign-in page as `patient`: fetches the page at `authorizeUrl`, posts its form with
 * `decision` (`allow` or `cancel`), and returns the callback URL the hospital redirects to.
 */
export async function answerSignIn(
  fetch: typeof globalThis.fetch,
  authorizeUrl: string | URL,
  patient: string,
  decision = "allow",
): Promise<URL> {
  const url = new URL(authorizeUrl);
  const page = await fetch(url);
  if (!page.ok)
    throw new Error(
      `${url.origin}${url.pathname} gave no sign-in page (${page.status})`,
    );
  const form = new URLSearchParams(url.search);
  form.set("decision", decision);
  form.set("patient", patient);
  const answered = await fetch(`${url.origin}${url.pathname}`, {
    method: "POST",
    redirect: "manual",
    body: form,
  });
  const location = answered.headers.get("Location");
  if (!location)
    throw new Error(
      `${url.origin}${url.pathname} did not redirect ${patient} (${answered.status})`,
    );
  return new URL(location, url);
}

export interface SignedIn {
  token: string;
  /** The authorization code that was exchanged for it, now spent. */
  code: string;
}

export interface SignInOptions {
  /** The scope the client asks for; the default is a patient launch that reads everything. */
  scope?: string;
  /** The protocol clock of the hospital built to sign in. */
  now?: () => Date;
}

/**
 * Signs in as `patient` the way a client does through a hospital reached at `base` by `fetch`: its discovery, its
 * sign-in form posted with the patient allowed, and the code exchanged with a fresh PKCE pair.
 */
export async function signInThrough(
  fetch: typeof globalThis.fetch,
  base: string,
  patient: string,
  options: Pick<SignInOptions, "scope"> = {},
): Promise<SignedIn> {
  const { verifier, challenge } = pkcePair();
  const discovery = await (
    await fetch(`${base}/.well-known/smart-configuration`)
  ).json();
  const authorize = new URL(discovery.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    scope: options.scope ?? DEFAULT_SCOPE,
    state: "s",
    aud: base,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const code = (await answerSignIn(fetch, authorize, patient)).searchParams.get(
    "code",
  );
  if (!code) throw new Error(`${base} did not give ${patient} a code`);
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
  return { token: answer.access_token, code };
}

/**
 * Builds the hospital from its options, with `options.now` as its clock, and signs in as `patient` through it with
 * `signInThrough`; returns the hospital beside the token.
 */
export async function signInAs(
  hospital: DemoHospitalOptions,
  patient: string,
  options: SignInOptions = {},
): Promise<SignedIn & { hospital: DemoHospital }> {
  const built = demoHospital({
    ...hospital,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const signedIn = await signInThrough(
    (input, init) => built(new Request(input, init)),
    hospital.hospital.fhirBase.replace(/\/$/, ""),
    patient,
    options.scope === undefined ? {} : { scope: options.scope },
  );
  return { ...signedIn, hospital: built };
}
