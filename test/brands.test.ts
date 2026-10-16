import assert from "node:assert/strict";
import { test } from "node:test";
import { brandsBundle, type Hospital } from "../src/index.js";

function hospital(id: string, places?: string[]): Hospital {
  return {
    name: `${id} Hospital`,
    fhirBase: `https://${id}.demo.invalid/fhir`,
    places,
    pageSize: 2,
    key: "k",
    types: ["Patient"],
    hiddenFromSearch: [],
  };
}

test("a brands bundle holds an Organization and its Endpoint for each hospital, tied by reference", () => {
  const bundle = brandsBundle(
    [
      hospital("one", ["Bellingham, WA", "Port Angeles, Clallam, WA"]),
      hospital("two"),
    ],
    "2026-01-01T00:00:00Z",
  );
  assert.equal(bundle.type, "collection");
  assert.equal(bundle.timestamp, "2026-01-01T00:00:00Z");
  assert.deepEqual(bundle.meta, {
    lastUpdated: "2026-01-01T00:00:00Z",
    profile: [
      "http://hl7.org/fhir/smart-app-launch/StructureDefinition/user-access-brands-bundle",
    ],
  });
  const resources = (bundle.entry ?? []).map(({ resource }) => resource);
  assert.deepEqual(
    resources.map((each) => `${each?.resourceType}/${each?.id}`),
    [
      "Organization/one",
      "Endpoint/one-fhir",
      "Organization/two",
      "Endpoint/two-fhir",
    ],
  );
  const [organization, endpoint] = resources;
  assert.equal(organization?.name, "one Hospital");
  assert.deepEqual(organization?.endpoint, [
    { reference: "Endpoint/one-fhir" },
  ]);
  assert.deepEqual(organization?.identifier, [
    { system: "urn:ietf:rfc:3986", value: "https://one.demo.invalid" },
  ]);
  const site = [{ system: "url", value: "https://one.demo.invalid" }];
  assert.deepEqual(organization?.telecom, site);
  assert.deepEqual(endpoint?.contact, site);
  assert.deepEqual(endpoint?.payloadType, [
    {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/endpoint-payload-type",
          code: "none",
        },
      ],
    },
  ]);
  assert.deepEqual(organization?.address, [
    { city: "Bellingham", state: "WA" },
    { city: "Port Angeles, Clallam", state: "WA" },
  ]);
  assert.deepEqual(organization?.extension, [
    {
      url: "http://hl7.org/fhir/StructureDefinition/organization-portal",
      extension: [
        { url: "portalName", valueString: "one Hospital" },
        {
          url: "portalEndpoint",
          valueReference: { reference: "Endpoint/one-fhir" },
        },
      ],
    },
  ]);
  assert.equal(endpoint?.status, "active");
  assert.equal(endpoint?.address, "https://one.demo.invalid/fhir");
  assert.deepEqual(endpoint?.connectionType, {
    system: "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
    code: "hl7-fhir-rest",
  });
  assert.deepEqual(endpoint?.extension, [
    {
      url: "http://hl7.org/fhir/StructureDefinition/endpoint-fhir-version",
      valueCode: "4.0.1",
    },
  ]);
  assert.equal(resources[2]?.address, undefined);
});
