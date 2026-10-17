export interface Hospital {
  name: string;
  /** A dark CSS colour: the header and the Allow button carry white text on it. */
  colour?: string;
  fhirBase: string;
  /** The towns a person would search for it by, as `"Bellingham, WA"`. */
  places?: string[];
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

export interface BundleEntry {
  fullUrl?: string;
  /** Absent only on a history entry whose request is a DELETE. */
  resource?: Resource;
  request?: { method: "POST" | "PUT" | "DELETE"; url: string };
  response?: { status: string; lastModified?: string; etag?: string };
}

export interface Bundle {
  resourceType: "Bundle";
  type: string;
  entry?: BundleEntry[];
}

export interface DemoHospitalOptions {
  hospital: Hospital;
  patients: Record<string, Bundle>;
  authorizeUrl?: string;
  autoApprove?: string;
  /** The protocol clock: when codes and tokens expire. */
  now?: () => Date;
  /** The world's date, a FHIR instant: the hospital answers with its records as they stood then. Absent: every record's latest version. */
  asOf?: string;
}

/**
 * Answers `request`, made of the hospital at its own FHIR base, or, given `at`, of the hospital answering at that
 * base instead: discovery, sign-in, token and every link and `fullUrl` are then built from `at`, and `aud` must be it.
 */
export type DemoHospital = (request: Request, at?: string) => Promise<Response>;
