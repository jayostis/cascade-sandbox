import type { Hospital, Resource } from "./types.js";

/**
 * A name's words, lower-cased, without accents and in alphabetical order, so a pod's name (`rowan-ellery-marsh`) and
 * a patient's (`Marsh`, `Rowan Ellery`) are the same whichever way round they are written.
 */
export function nameWords(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

export function namesOf(
  patient: Resource | undefined,
  id: string,
): { family: string; given: string } {
  const name = (
    patient as { name?: { given?: string[]; family?: string }[] } | undefined
  )?.name?.[0];
  return name
    ? { family: name.family ?? "", given: (name.given ?? []).join(" ") }
    : { family: id, given: "" };
}

const LONG_DAY = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "long",
  timeZone: "UTC",
});

/** An instant's UTC day in words: `1 February 2024`. */
export function inWords(instant: string): string {
  return LONG_DAY.format(Date.parse(instant));
}

export function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function scopeInWords(scope: string): string | undefined {
  if (scope === "launch/patient") return "Know which patient you are";
  const read = /^patient\/(\*|[A-Za-z]+)\.(read|rs)$/.exec(scope)?.[1];
  if (read === undefined) return undefined;
  return read === "*"
    ? "Read your whole health record"
    : `Read your ${read} records`;
}

const STYLE = `
* { box-sizing: border-box; }
body { margin: 0; background: #eef1f4; color: #1f2a33; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header { background: var(--hospital); color: #fff; padding: 14px 16px; }
header div { max-width: 460px; margin: 0 auto; display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 1.1rem; }
header span { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 6px; background: #fff; color: var(--hospital); font-size: 1.4rem; line-height: 1; }
header p { margin: 0; }
header small { display: block; font-weight: 400; font-size: 0.8rem; opacity: 0.85; }
main { max-width: 460px; margin: 24px auto; padding: 24px; background: #fff; border-radius: 10px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12); }
h1 { margin: 0 0 8px; font-size: 1.4rem; }
h2 { margin: 20px 0 8px; font-size: 1rem; }
fieldset { margin: 16px 0 0; padding: 0; border: 0; }
legend { padding: 0; margin-bottom: 8px; font-weight: 600; }
.choice { display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin-bottom: 8px; border: 1px solid #ccd3da; border-radius: 8px; cursor: pointer; }
.choice:has(input:checked) { border-color: var(--hospital); background: #f4f8fb; }
.choice input { accent-color: var(--hospital); margin: 0; }
.scopes { margin: 0; padding: 0; list-style: none; }
.scopes li { padding: 8px 0; border-top: 1px solid #e3e7eb; }
.scopes code { display: block; color: #66727d; font-size: 0.75rem; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
button { flex: 1 1 140px; padding: 12px; border-radius: 8px; border: 1px solid #9aa6b1; background: #fff; color: #1f2a33; font: inherit; font-weight: 600; cursor: pointer; }
button.allow { border-color: var(--hospital); background: var(--hospital); color: #fff; }
button:focus-visible { outline: 3px solid #f2b705; outline-offset: 2px; }
footer { max-width: 460px; margin: 0 auto 24px; padding: 0 16px; color: #56636e; font-size: 0.85rem; text-align: center; }
@media (max-width: 500px) {
  main { margin: 0; border-radius: 0; box-shadow: none; padding: 20px 16px; }
  footer { margin-top: 16px; }
}
`;

export function page(hospital: Hospital, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escape(hospital.name)} (demo)</title>
    <style>${STYLE}</style>
  </head>
  <body style="--hospital: ${escape(hospital.colour ?? "#3d4f5c")}">
    <header><div><span aria-hidden="true">+</span><p>${escape(hospital.name)}<small>Patient portal</small></p></div></header>
    <main>
      ${body}
    </main>
    <footer>A demo hospital for testing apps: there is no password, and every patient here is made up.</footer>
  </body>
</html>
`;
}
