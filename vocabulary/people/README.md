# People

The hand-written test people, one folder each. A folder's `person.json` is the person: who they are, the one place
their name, birth date, gender and pod subject are written, and the only file [`person.schema.json`](person.schema.json)
describes. Under `sources/<source>/` is what each hospital or other source holds of them, its own Patient with its own
IDs and spelling: `fhir.json`, a FHIR R4 Bundle as the source serves it, and `ccda/<day>.xml`, a C-CDA document named by
the day of its `effectiveTime`. A story's written answer is `expected/story.json`. A person a conformance kit follows
names the kit in `kit`, and the kit stays under [`conformance/`](../conformance).

Every source must agree with `person.json` on name, birth date and gender, except where `person.json` declares the
difference and the match grade a matcher is expected to give it. [`tests/test_people.py`](../tests/test_people.py)
checks each folder, each source and each kit's download and `people.ttl` row against it.

Community layouts are by format (Synthea's `output/fhir/`, Coherent's `fhir/ csv/ dicom/`) or by resource (HL7's
examples), but what is under test here is one person across sources, so everything about a person is kept and reviewed
together.

## Notices

Every person here is synthetic and was written by hand; the NDC `99999-0861-01` in Tamsin Vale's records is invented. Their records carry SNOMED CT concept identifiers and terms chosen by hand, in codings only.

> This material includes SNOMED Clinical Terms® (SNOMED CT®) concept identifiers and terms. SNOMED and SNOMED CT are
> registered trademarks of SNOMED International.

> This material contains content from LOINC (http://loinc.org). LOINC is copyright © Regenstrief Institute, Inc. and
> the Logical Observation Identifiers Names and Codes (LOINC) Committee and is available at no cost under the license at
> http://loinc.org/license. LOINC® is a registered United States trademark of Regenstrief Institute, Inc.

RxNorm codes (U.S. National Library of Medicine) and CVX codes (CDC) are released without restriction.
