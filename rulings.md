# Rulings

Where the demo hospital follows a specification, and where it chose among what one allows. Each ruling quotes the
text, names where it was read and when, and the test that pins it. Tests are in `test/`.

## The as-of rule

The hospital answers as its records stood at one time T, `asOf`, fixed for an instance. A record's version at T is its
latest version whose record time (`response.lastModified`) is at or before T. A record with none is absent at T; one
whose version at T is a deletion is deleted at T. Search, read, vread and instance history answer from those versions
only, and T is never in a link, so every page an instance gives is a page of one list. A plain record (a `collection`
file) has one version, present at every T.

> "The `vread` interaction performs a version specific read of the resource."
>
> "Only include resource versions that were created at or after the given instant in time" (`_since`)
>
> "Only include resource versions that were current at some point during the time period specified in the date time
> value" (`_at`)

FHIR R4, RESTful API, [read, vread and history](https://hl7.org/fhir/R4/http.html#history), read 2026-10-16. FHIR
has no parameter for reading a server as of a date; T is the world's date of a pretend hospital, the time of its story
at which an app connects, and every answer is the one a real server would have given then.

Pinned by `history.test.ts`, "the hospital answers each read, search, vread and history with its records as they stood
at T".

## The three clocks

Three times are in play, and "as of" names only the first.

- **Source record time:** when the source recorded a version, its `response.lastModified`, equal to the version's
  `meta.lastUpdated`. T above is a point on this clock. A pull's document says it as `rec:answeredAsOf`.
- **Clinical time:** the dates inside a resource (`effectiveDateTime`, `onsetDateTime`, `period.start`, and the rest).
  The hospital never reads them to answer, and the shorthand reads them only to place a record on the first clock.
- **Pod arrival time:** when a pod received a revision, `prov:generatedAtTime` on it. The hospital has no say in it.

"As of" is never clinical time: a record dated before T is still absent at T when the source recorded it after T.

Pinned by `history.test.ts`, "a patient's export is a collection of each record's version at T".

## Scopes

Read, vread and history need `r` on the type; a search needs `s`. A v2 scope `patient/<Type|*>.<letters>` grants its
letters; v1 `.read` grants `rs`, `.write` grants `cud` and `.*` grants `cruds`. A scope with a `?` query, a `user/`
scope and a `system/` scope grant nothing. A request the scopes do not cover is a 403 `forbidden`.

> "Valid suffixes are a subset of the in-order string `.cruds`."
>
> "servers SHOULD process v1 scopes with the following semantics in v2:" v1 `.read` ⇒ v2 `.rs`; v1 `.write` ⇒ v2
> `.cud`; v1 `.*` ⇒ v2 `.cruds`.
>
> "these requests may be rejected, or results may be omitted from responses."

SMART App Launch 2.2.0, [Scopes and Launch Context](https://hl7.org/fhir/smart-app-launch/scopes-and-launch-context.html),
read 2026-10-16. Query scopes ("add a query string suffix to existing scopes, starting with `?`") are not required of
a server and are partly "experimental"; granting nothing for them refuses rather than over-shares. The hospital
serves only patients, so `user/` and `system/` scopes have nothing to grant.

Pinned by `history.test.ts`, "the hospital's scopes grant what SMART says each grants", and the scope rows of
`hospital.test.ts`, "each bad request is refused as the protocol says".

## Not yours is not there

A read, vread or history of another patient's record answers exactly as one of an unknown id: 404 `not-found`, the
same body. A search naming another patient is a 403 whether that patient exists or not.

> "This also protects from data leakage as it is indistinguishable from a query against a resource that doesn't
> exist."

FHIR R4, Security, [Access Denied Response Handling](https://hl7.org/fhir/R4/security.html), read 2026-10-16.

Pinned by `history.test.ts` ("another patient's … answers as an unknown one") and the rows "another patient's record",
"another patient's version" and "another patient's history" of `hospital.test.ts`.

## 410 for a deleted record

The patient's own record deleted at T answers a read with 410 `deleted`; a vread of the deletion's version does too.

> "a `GET` for a deleted resource returns a `410` status code, whereas a `GET` for an unknown resource returns `404`."
>
> "If the version referred to is actually one where the resource was deleted, the server should return a `410` status
> code."

FHIR R4, RESTful API, [read](https://hl7.org/fhir/R4/http.html#read) and [vread](https://hl7.org/fhir/R4/http.html#vread),
read 2026-10-16.

Pinned by `history.test.ts`, rows "a record deleted at T" and "a vread of a deletion".

## `aud` is one URL

The authorize request's `aud` must be the hospital's FHIR base, as one URL; anything else is `invalid_request`.

> "URL of the EHR resource server from which the app wishes to retrieve FHIR data." … "This parameter prevents leaking
> a genuine bearer token to a counterfeit resource server."

SMART App Launch 2.2.0, [App Launch](https://hl7.org/fhir/smart-app-launch/app-launch.html), read 2026-10-16.

An `aud` that is an array is a JWT claim's form ("In the general case, the "aud" value is an array of case-sensitive
strings", [RFC 7519 §4.1.3](https://www.rfc-editor.org/rfc/rfc7519#section-4.1.3)), used by token formats such as the
imaging one, which name each service a token is good for. It was not adopted: the authorize parameter is one URL, and
this hospital's tokens are opaque signed notes with no `aud` claim.

Pinned by `hospital.test.ts`, row "a wrong aud".

## Plain records are served as written

A record of a `collection` file is served exactly as it is in the file, its `meta` included or absent; it is never
stamped with a version. Its version id, `meta.versionId` or `"1"` when it has none, is used only to answer vread and
history.

> "The metadata items are all optional"
>
> `Meta.versionId`: "This value changes when the resource is created, updated, or deleted."

FHIR R4, [Resource](https://hl7.org/fhir/R4/resource.html), read 2026-10-16. A stamped `"1"` would be a claim the data
does not make, and a later edit of a hand-written file would keep the same `"1"`, so an app comparing versions would
miss it.

Pinned by `cascade-runtime`'s `connect.test.ts` (every pulled resource deep-equals the file's) and
`hospital.test.ts`, "a client walks the whole protocol for patient A at North".

## History is newest first

An instance history is a Bundle of `type` `history` with the record's versions at or before T, newest first, a
deletion as an entry with `request.method` `DELETE` and no `resource`. Type-level and system-level history answer 404
`not-supported`.

> "containing the specified version history, sorted with oldest versions last, and including deleted resources."

FHIR R4, RESTful API, [history](https://hl7.org/fhir/R4/http.html#history), read 2026-10-16.

Pinned by `history.test.ts`, rows "a history, newest first", "a history holding a deletion", "a type's history" and
"the system's history".

## `_at` at the value's precision

`_at=2024` keeps the versions current at some point during 2024; `2024-04` during that month; `2024-04-16` during that
day (UTC); an instant during that second. A version is current from its record time until the next version's.

> "When the date parameter is not fully specified, matches against it are based on the behavior of intervals" … "e.g.
> 2000 is equivalent to an interval of [2000-01-01T00:00, 2000-12-31T23:59]."

FHIR R4, Search, [date](https://hl7.org/fhir/R4/search.html#date), read 2026-10-16; `_at` refers to it for date
handling. `_since` is an instant, and one with no timezone is a 400 `invalid`.

Pinned by `history.test.ts`, rows "a history at a year in which both versions were current", "a history at a year
before the change", "a history at a day after the change" and "a history since a time with no timezone".

## Error switches follow smart-launcher-v2

`simulate_error` on the authorize request (or the sign-in page's "Simulate a failure" menu) is one of four names. It is
signed into the code and from the code into the token, so the hospital keeps no state. An unknown name redirects with
`error=invalid_request`; an empty one is no switch.

- `token_invalid_token`: the token request answers 401 `{"error":"invalid_client"}`.
- `token_invalid_scope`: the token request answers 401 `{"error":"invalid_scope"}`.
- `request_invalid_token`: the token is issued, and every FHIR request with it answers 401, "Invalid token".
- `request_expired_token`: the same, "Token expired".

> `if (authorizationToken.auth_error === "token_invalid_token") { throw new InvalidClientError("Simulated invalid client error").status(401) }`

smart-launcher-v2, `backend/routes/auth/token.ts` (`finish`), read 2026-10-17. The launcher raises `token_invalid_scope`
only on its backend-services grant, 401 `invalid_scope`, `launchOptions.auth_error === "token_invalid_scope"`; it ignores
it on the code exchange, which this hospital does not copy, because it has no other grant. On the code exchange the two
`request_*` names only put `sim_error` ("Invalid token", "Token expired") on the token response, and the launcher still
serves that token (`token.ts` `finish`; `backend/lib.ts` checks `sim_error` only on the token's own claims, which only
its backend-services grant sets).

This hospital diverges, and the failure on every FHIR request is our own choice: it fails each request made with the
token, as the launcher does for a backend-services token (`HttpError(sim_error).status(401)`), and it also puts the same
`sim_error` on the token response, so a client written against the launcher sees it.

Also ours: the 401 carries `WWW-Authenticate: Bearer error="invalid_token"` (RFC 6750 section 3), with
`error_description="The access token expired"` for the expired switch, so a client can tell the two apart without
reading prose; and the body is an OperationOutcome, as every FHIR error here is, not the launcher's plain text.

Pinned by `hospital.test.ts`, "each error switch fails at its own step, as smart-launcher-v2 does, and an unknown one is
refused".
