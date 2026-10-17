import { parseArgs } from "node:util";
import { HospitalDataError } from "../history.js";
import { hospitalId } from "../route.js";
import { loadHospitals } from "./index.js";
import { serveDemo } from "./serve.js";

const USAGE = "usage: npm run serve -- [--port <n>] [--as-of <instant>]";

const isMisuse = (error: unknown) =>
  error instanceof TypeError &&
  String((error as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS_");

const parse = () =>
  parseArgs({
    options: { port: { type: "string" }, "as-of": { type: "string" } },
  });

function portOf(text: string | undefined): number | undefined {
  if (text === undefined) return 0;
  const port = Number(text);
  return /^\d+$/.test(text) && port <= 65535 ? port : undefined;
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse();
  } catch (error) {
    if (!isMisuse(error)) throw error;
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const port = portOf(args.values.port);
  if (port === undefined) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const hospitals = await loadHospitals();
  const listener = await serveDemo(hospitals, {
    port,
    ...(args.values["as-of"] === undefined
      ? {}
      : { asOf: args.values["as-of"] }),
  });
  const { origin } = listener;
  console.log(`Listening at ${origin}`);
  for (const each of hospitals) {
    const id = hospitalId(each);
    const path = new URL(each.hospital.fhirBase).pathname.replace(/\/$/, "");
    console.log(`${each.hospital.name}: ${origin}/${id}${path}`);
  }
  console.log(
    `Move the world's date: curl -d asOf=2024-02-01T00:00:00Z ${origin}/world-date (asOf= for every version)`,
  );
}

main().catch((error: unknown) => {
  console.error(
    error instanceof HospitalDataError
      ? error.message
      : error instanceof Error &&
          (error as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? `${USAGE}\nThat port is in use: give another, or none for one the system picks.`
        : error instanceof Error
          ? (error.stack ?? error.message)
          : String(error),
  );
  process.exitCode = 1;
});
