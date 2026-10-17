/** One result of a story's pair, by the day it was taken. */
export interface StoryResult {
  date: string;
  value: number;
}

/** What a story's data shows of one medication and one test, in the words of an analysis's finding. */
export interface StoryFinding {
  kind: "after start" | "after stop";
  /** A bare RxNorm code. */
  medication: string;
  /** A bare LOINC code. */
  test: string;
  /** The day the medication started or stopped. */
  date: string;
  direction: "up" | "down" | "not enough results";
  unit: string;
  before: StoryResult[];
  after: StoryResult[];
}

/** A pull of a story's record from its hospital as the record stood on a date, saved under a name. */
export interface StoryPull {
  /** The folder the pull is saved as. */
  name: string;
  /** The world's date the hospital answers for, a FHIR instant. */
  asOf: string;
}

/** A synthetic patient whose data holds a planted finding, or none, and the written answer. */
export interface Story {
  /** The patient's id at the hospital. */
  patient: string;
  hospital: string;
  story: string;
  findings: StoryFinding[];
  /** The absolute path of the same record as a C-CDA document, where the person has one. */
  ccdaFile?: string;
  /** The pulls a conformance kit saves of the story, in the order they are made. */
  pulls?: StoryPull[];
}
