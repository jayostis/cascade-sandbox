# cascade-sandbox — Agent Context

Pretend SMART on FHIR hospitals for developing against a hospital with no account and
no network; [`README.md`](README.md) names the parts. A hospital is a function from a
`Request` to a `Response`. Nothing here imports a runtime package: a consumer reaches a
hospital only through a fetch.

## The rules

- **Tests assert meaning, never bytes.** Nothing compares whole files or serialised output.
- **Fewer, better, faster tests.** One test per behaviour, on the smallest input that shows it;
  change the test that already shows a behaviour before adding one. `npm test` runs in seconds.
- **Bad input is a refusal, as a table.** Each input the loader or a hospital refuses, and the
  reason, in one table-driven test, not one test per case.

## Conventions

- Dependencies are pinned exactly.
- Conventional commits: `feat(route): ...`, `fix(loader): ...`; why a change was made goes in
  its message, never in the file.
- No comment that restates a name, a type or another file.
