import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  type Bundle,
  demoHospital,
  HospitalDataError,
  type Resource,
  versionsOf,
} from "../src/index.js";
import { loadHospital } from "../src/node/index.js";
import {
  compileShorthand,
  type ShorthandBundle,
  type ShorthandEntry,
} from "../src/shorthand.js";

const { hospital } = await loadHospital("cascade-north");
const BASE = hospital.fhirBase;

const person: Resource = {
  resourceType: "Patient",
  id: "p1",
  name: [{ family: "Vale", given: ["Tamsin"] }],
};
const med: Resource = {
  resourceType: "MedicationStatement",
  id: "m1",
  status: "active",
  medicationCodeableConcept: { text: "Metformin" },
};
const condition: Resource = {
  resourceType: "Condition",
  id: "c1",
  code: { text: "Bronchitis" },
};
const result: Resource = {
  resourceType: "Observation",
  id: "o1",
  status: "final",
  effectiveDateTime: "2023-01-10T09:00:00Z",
};

const file = (...entry: ShorthandEntry[]): ShorthandBundle => ({
  resourceType: "Bundle",
  type: "collection",
  entry,
});

test("a shorthand compiles to the versions of the hospital's file, and the hospital serves each as of its date", async () => {
  const compiled = compileShorthand(
    file(
      { resource: person },
      {
        resource: med,
        shorthand: { active: "2022-03-01", stopped: "2024-04-15" },
      },
      {
        resource: condition,
        shorthand: { active: "2023-05-01", stopped: "2024-06-10" },
      },
      { resource: result },
    ),
    "tamsin.json",
  );
  assert.equal(compiled.type, "history");
  const times = Object.fromEntries(
    [...versionsOf(compiled, "tamsin.json")].map(([record, versions]) => [
      record,
      versions.map(({ versionId, recorded }) => `${versionId}@${recorded}`),
    ]),
  );
  assert.deepEqual(times, {
    "Patient/p1": ["1@2022-03-01T00:00:00Z"],
    "MedicationStatement/m1": [
      "1@2022-03-01T00:00:00Z",
      "2@2024-04-15T00:00:00Z",
    ],
    "Condition/c1": ["1@2023-05-01T00:00:00Z", "2@2024-06-10T00:00:00Z"],
    "Observation/o1": ["1@2023-01-10T09:00:00Z"],
  });

  const verifier =
    "a-verifier-long-enough-to-be-a-real-pkce-code-verifier-0123";
  const redirect = "https://app.example/callback";
  const asked = async (asOf: string) => {
    const options = { hospital, patients: { p1: compiled }, asOf };
    const hosted = demoHospital({ ...options, autoApprove: "p1" });
    const back = await hosted(
      new Request(
        `${BASE}/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: "test-app",
          redirect_uri: redirect,
          scope: "launch/patient patient/*.rs",
          aud: BASE,
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
        })}`,
      ),
    );
    const code = new URL(back.headers.get("Location") ?? "").searchParams.get(
      "code",
    );
    const token = await (
      await hosted(
        new Request(`${BASE}/token`, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code ?? "",
            redirect_uri: redirect,
            client_id: "test-app",
            code_verifier: verifier,
          }),
        }),
      )
    ).json();
    const search = async (type: string) =>
      (
        (await (
          await hosted(
            new Request(`${BASE}/${type}?patient=p1`, {
              headers: { Authorization: `Bearer ${token.access_token}` },
            }),
          )
        ).json()) as Bundle
      ).entry?.map(({ resource }) => resource as Resource) ?? [];
    const [medication] = await search("MedicationStatement");
    const [problem] = await search("Condition");
    return {
      medication: medication && [
        medication.status,
        (medication.effectivePeriod as { end?: string }).end,
      ],
      condition: problem && [
        (problem.clinicalStatus as { coding: { code: string }[] }).coding[0]
          ?.code,
        problem.abatementDateTime,
      ],
      results: (await search("Observation")).length,
    };
  };
  assert.deepEqual(await asked("2022-06-01T00:00:00Z"), {
    medication: ["active", undefined],
    condition: undefined,
    results: 0,
  });
  assert.deepEqual(await asked("2023-06-01T00:00:00Z"), {
    medication: ["active", undefined],
    condition: ["active", undefined],
    results: 1,
  });
  assert.deepEqual(await asked("2025-01-01T00:00:00Z"), {
    medication: ["completed", "2024-04-15"],
    condition: ["resolved", "2024-06-10"],
    results: 1,
  });
});

test("a shorthand is refused where its dates cannot say the change", () => {
  const rows: [string, ShorthandBundle, string][] = [
    [
      "a MedicationRequest that stopped",
      file(
        { resource: person },
        {
          resource: {
            resourceType: "MedicationRequest",
            id: "r1",
            authoredOn: "2022-03-01",
          },
          shorthand: { stopped: "2024-04-15" },
        },
      ),
      "an R4 MedicationRequest has no date that says when it stopped: write its second version",
    ],
    [
      "another type that stopped",
      file(
        { resource: person },
        { resource: result, shorthand: { stopped: "2024-04-15" } },
      ),
      "Observation has no field that dates a stop",
    ],
    [
      "an entry with no date",
      file({ resource: person }, { resource: med }),
      "MedicationStatement/m1 has no date to place it at: give shorthand.active",
    ],
    [
      "a patient alone, with no record to place it by",
      file({ resource: person }),
      "Patient/p1 has no date to place it at: give shorthand.active",
    ],
    [
      "a stop on the day it began",
      file(
        { resource: person },
        {
          resource: med,
          shorthand: { active: "2022-03-01", stopped: "2022-03-01" },
        },
      ),
      "MedicationStatement/m1 stopped on 2022-03-01, which is not after it began on 2022-03-01",
    ],
    [
      "a day that does not exist",
      file(
        { resource: person },
        { resource: med, shorthand: { active: "2022-02-30" } },
      ),
      'MedicationStatement/m1 shorthand.active "2022-02-30" is not a date, as 2022-03-01, or an instant, as 2022-03-01T09:00:00Z',
    ],
    [
      "a word the shorthand does not take",
      file(
        { resource: person },
        {
          resource: med,
          shorthand: { active: "2022-03-01", stoped: "2024-04-15" } as never,
        },
      ),
      "MedicationStatement/m1 shorthand takes active and stopped, not stoped",
    ],
    [
      "a record twice",
      file({ resource: person }, { resource: result }, { resource: result }),
      "a collection holds Observation/o1 twice",
    ],
    [
      "a file that is not a collection",
      { ...file({ resource: person }), type: "history" },
      "a shorthand file is a Bundle of type collection, not history",
    ],
  ];
  for (const [name, input, reason] of rows) {
    assert.throws(
      () => compileShorthand(input, "tamsin.json"),
      (error) =>
        error instanceof HospitalDataError &&
        error.where === "tamsin.json" &&
        error.reason === reason,
      name,
    );
  }
});
