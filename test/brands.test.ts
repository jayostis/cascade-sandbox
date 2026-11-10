import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

const bundle = brandsBundle(
  [
    hospital("one", ["Bellingham, WA", "Port Angeles, Clallam, WA"]),
    hospital("two"),
  ],
  "2026-01-01T00:00:00Z",
);
const entries = bundle.entry ?? [];
const resources = entries.map(({ resource }) => resource);
const [organization, endpoint] = resources;

/**
 * `brandsBundle()` gives the hospitals as a brands bundle, the standard document an app's list of hospitals to connect to
 * is read from. An app tests its hospital search against it with no vendor's list.
 */
describe("Listing the demo hospitals as a brands bundle · brandsBundle()", () => {
  describe("brandsBundle(hospitals, timestamp)", () => {
    it("returns a `collection` Bundle stamped with the timestamp and the brands-bundle profile", () => {
      assert.equal(bundle.type, "collection");
      assert.equal(bundle.timestamp, "2026-01-01T00:00:00Z");
      assert.deepEqual(bundle.meta, {
        lastUpdated: "2026-01-01T00:00:00Z",
        profile: [
          "http://hl7.org/fhir/smart-app-launch/StructureDefinition/user-access-brands-bundle",
        ],
      });
    });

    it("lists an Organization and then its Endpoint for each hospital, in the order given", () => {
      assert.deepEqual(
        resources.map((each) => `${each?.resourceType}/${each?.id}`),
        [
          "Organization/one",
          "Endpoint/one-fhir",
          "Organization/two",
          "Endpoint/two-fhir",
        ],
      );
    });

    it("gives each entry a `fullUrl` its Organization's reference resolves against", () => {
      const bases = new Set<string>();
      for (const { fullUrl, resource } of entries) {
        const tail = `/${resource?.resourceType}/${resource?.id}`;
        assert.ok(fullUrl?.endsWith(tail), `${fullUrl} ends ${tail}`);
        bases.add((fullUrl ?? "").slice(0, -tail.length));
      }
      assert.equal(entries.length, 4);
      assert.equal(bases.size, 1, "every entry shares one base");
    });

    it("names each Organization for its hospital, with the hospital's site as identifier and telecom", () => {
      assert.equal(organization?.name, "one Hospital");
      assert.deepEqual(organization?.identifier, [
        { system: "urn:ietf:rfc:3986", value: "https://one.demo.invalid" },
      ]);
      assert.deepEqual(organization?.telecom, [
        { system: "url", value: "https://one.demo.invalid" },
      ]);
    });

    it("points each Organization to its Endpoint, by `endpoint` and by its portal extension", () => {
      assert.deepEqual(organization?.endpoint, [
        { reference: "Endpoint/one-fhir" },
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
    });

    it("gives each Endpoint the hospital's FHIR base as its address, active, as FHIR 4.0.1 over REST", () => {
      assert.equal(endpoint?.address, "https://one.demo.invalid/fhir");
      assert.equal(endpoint?.status, "active");
      assert.deepEqual(endpoint?.connectionType, {
        system:
          "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
        code: "hl7-fhir-rest",
      });
      assert.deepEqual(endpoint?.extension, [
        {
          url: "http://hl7.org/fhir/StructureDefinition/endpoint-fhir-version",
          valueCode: "4.0.1",
        },
      ]);
      assert.deepEqual(endpoint?.payloadType, [
        {
          coding: [
            {
              system:
                "http://terminology.hl7.org/CodeSystem/endpoint-payload-type",
              code: "none",
            },
          ],
        },
      ]);
      assert.deepEqual(endpoint?.contact, [
        { system: "url", value: "https://one.demo.invalid" },
      ]);
    });

    it("splits each place at its last comma into a city and a state", () => {
      assert.deepEqual(organization?.address, [
        { city: "Bellingham", state: "WA" },
        { city: "Port Angeles, Clallam", state: "WA" },
      ]);
    });

    it("omits `address` for a hospital with no places", () => {
      assert.equal(resources[2]?.address, undefined);
    });
  });
});
