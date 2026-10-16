import type { Bundle, Hospital, Resource } from "./index.js";
import { hospitalId } from "./route.js";

const PROFILES = "http://hl7.org/fhir/smart-app-launch/StructureDefinition/";
const BUNDLE_PROFILE = `${PROFILES}user-access-brands-bundle`;
const PORTAL = "http://hl7.org/fhir/StructureDefinition/organization-portal";
const FHIR_VERSION =
  "http://hl7.org/fhir/StructureDefinition/endpoint-fhir-version";
const CONNECTION_TYPES =
  "http://terminology.hl7.org/CodeSystem/endpoint-connection-type";
const PAYLOAD_TYPES =
  "http://terminology.hl7.org/CodeSystem/endpoint-payload-type";

/** A place written `"Bellingham, WA"`, as an Organization's address: split at the last `", "`. */
function addressOf(place: string): { city: string; state?: string } {
  const at = place.lastIndexOf(", ");
  return at < 0
    ? { city: place }
    : { city: place.slice(0, at), state: place.slice(at + 2) };
}

function organizationOf(hospital: Hospital, id: string): Resource {
  const endpoint = `Endpoint/${id}-fhir`;
  return {
    resourceType: "Organization",
    id,
    meta: { profile: [`${PROFILES}user-access-brand`] },
    extension: [
      {
        url: PORTAL,
        extension: [
          { url: "portalName", valueString: hospital.name },
          { url: "portalEndpoint", valueReference: { reference: endpoint } },
        ],
      },
    ],
    identifier: [
      { system: "urn:ietf:rfc:3986", value: `https://${id}.demo.invalid` },
    ],
    name: hospital.name,
    telecom: [{ system: "url", value: `https://${id}.demo.invalid` }],
    ...(hospital.places?.length
      ? { address: hospital.places.map(addressOf) }
      : {}),
    endpoint: [{ reference: endpoint }],
  };
}

function endpointOf(hospital: Hospital, id: string): Resource {
  return {
    resourceType: "Endpoint",
    id: `${id}-fhir`,
    meta: { profile: [`${PROFILES}user-access-endpoint`] },
    extension: [{ url: FHIR_VERSION, valueCode: "4.0.1" }],
    status: "active",
    contact: [{ system: "url", value: `https://${id}.demo.invalid` }],
    connectionType: { system: CONNECTION_TYPES, code: "hl7-fhir-rest" },
    payloadType: [{ coding: [{ system: PAYLOAD_TYPES, code: "none" }] }],
    address: hospital.fhirBase,
  };
}

/**
 * The hospitals as a SMART User-access Brands Bundle: per hospital an Organization and its Endpoint, so a directory
 * of them is the standard document any app that reads one can read.
 */
export function brandsBundle(
  hospitals: readonly Hospital[],
  timestamp: string,
): Bundle & { timestamp: string; meta: Record<string, unknown> } {
  return {
    resourceType: "Bundle",
    meta: { lastUpdated: timestamp, profile: [BUNDLE_PROFILE] },
    type: "collection",
    timestamp,
    entry: hospitals.flatMap((hospital) => {
      const id = hospitalId({ hospital, patients: {} });
      return [
        { resource: organizationOf(hospital, id) },
        { resource: endpointOf(hospital, id) },
      ];
    }),
  };
}
