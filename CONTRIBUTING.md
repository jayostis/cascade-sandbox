# Contributing to cascade-sandbox

Thank you for helping. This repository holds pretend SMART on FHIR hospitals, for developing against a hospital with no
account and no network. A hospital is a function from a `Request` to a `Response`, and nothing here imports a runtime
package. [`README.md`](README.md) names the parts, [`rulings.md`](rulings.md) records each choice a hospital makes
against FHIR and SMART, and [`CLAUDE.md`](CLAUDE.md) holds the rules a change here follows; read it before you add a
test.

Please follow the organisation's code of conduct and security policy. Report a security problem privately, as that
policy says, never in a public issue. The hospitals are pretend and protect nothing, so a weakness in them is not one.

## Set up

You need Node.js 22 or newer and git.

```sh
git clone git@github.com:<you>/cascade-sandbox.git
cd cascade-sandbox
npm ci
```

`npm ci` also compiles the TypeScript.

## Run the checks

These are the commands CI runs.

```sh
npm run lint
npm test
```

`npm run format` fixes what the formatting check in `npm run lint` finds. `npm test` runs in seconds, so run all of it.

A third check reads the people the demo hospitals serve against the vocabulary. It needs a checkout of
[cascade-vocabulary](https://github.com/jayostis/cascade-vocabulary) at the commit [`vocabulary.json`](vocabulary.json)
pins:

```sh
npm run people -- --check ../cascade-vocabulary
```

`npm run validate:data` checks every version of every record against FHIR R4 and US Core with the HL7 validator. It runs
in Docker and needs a network, so it is slow; CI runs it when a pull request touches the hospitals, the people, the
vocabulary, the source or the validator.

## What a pull request must pass

CI runs on every pull request, and a red check is a reason not to merge.

- **`check`**: `npm run lint` and `npm test`.
- **`people`**: the people against the vocabulary, as above.
- **`contract`**: the runtime's own tests of the rulings a sandbox change could break, run against your sandbox. See
  "A change that spans two repositories".
- **`validate-data`**: the HL7 validator, when the data changed. It is not a gate, but a failure in it is a real finding.

## Commits and pull requests

Use conventional commits: `feat(route): ...`, `fix(loader): ...`. The commit message says why a change was made; no file
does. Pin dependencies exactly. A new behaviour gets one test on the smallest input that shows it, asserting meaning and
never bytes. Do not put a closing keyword (`closes`, `fixes`, `resolves`) before an issue the pull request does not
finish: GitHub closes it whatever the rest of the sentence says.

A choice the hospital makes against FHIR or SMART goes in [`rulings.md`](rulings.md), with the text it follows and the
test that pins it.

## A change that spans two repositories

The `contract` check runs [cascade-runtime-js](https://github.com/jayostis/cascade-runtime-js)'s tests over your branch.
Nothing pins one repository to the other: with no counterpart named, it uses the runtime's `main`. A change the runtime
must follow is two pull requests, one here and one there. Name the runtime's in this one's description, on a line of
its own, with the full URL:

```
Depends-On: https://github.com/jayostis/cascade-runtime-js/pull/123
```

The check then runs that pull request's runtime. Editing the description re-runs it; if the named pull request changes
after your checks have run, re-run yours with `gh run rerun`. A contributor without write access to the runtime asks a
maintainer to open the counterpart.

## Licence

Apache-2.0. The generated people are synthetic, from Synthea, and carry their own notices in
[`people/NOTICE.md`](people/NOTICE.md).
