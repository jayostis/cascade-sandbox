# Contributing to cascade-sandbox

Thank you for helping. This repository holds pretend SMART on FHIR hospitals, for developing against a hospital with no
account and no network. A hospital is a function from a `Request` to a `Response`, and nothing here imports a runtime
package. [`README.md`](README.md) names the parts, [`rulings.md`](rulings.md) records each choice a hospital makes
against FHIR and SMART, and [`CLAUDE.md`](CLAUDE.md) holds the rules a change here follows; read it before you add a
test.

Report a security problem privately, by email to contact@cascadeprotocol.org, never in a public issue. The hospitals are pretend and protect nothing, so a weakness in them is not one.

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

- **`check`**: `npm run lint`, `npm test`, and the check that the tests read as a specification (see "Commits and pull
  requests").
- **`node-22`**: the tests on Node 22, the oldest Node supported.
- **`people`**: the people against the vocabulary, as in "Run the checks".
- **`pack`**: packs the package.
- **`contract`**: the runtime's own tests of the rulings a sandbox change could break, run against your sandbox. See
  "A change that spans two repositories".
- **`validate-data`**: the HL7 validator, when the data changed. It is not a gate, but a failure in it is a real finding.

## Commits and pull requests

Use conventional commits: `feat(route): ...`, `fix(loader): ...`. Do not put a closing keyword (`closes`, `fixes`,
`resolves`) before an issue the pull request does not finish: GitHub closes it whatever the rest of the sentence says.
How to write a test, what to pin and where a reason goes are in [`CLAUDE.md`](CLAUDE.md).

Every test's group must be a heading of [`test/spec.json`](test/spec.json), word for word. `npm test` does not check
this; the `check` job in CI does, and a new test under an unlisted heading turns it red.

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
after your checks have run, re-run yours with `gh run rerun`.

## Licence

Apache-2.0. The generated people are synthetic, from Synthea, and carry their own notices in
[`people/NOTICE.md`](people/NOTICE.md).
