// The relay's process (Dockerfile): its configuration from `RELAY_CONFIG`,
// and every `COUNT_INTERVAL_MS` one line of each resource's counts, the only
// thing it logs of the requests it carries (docs/spec/sealed-delivery.md,
// The relay; T-13).
import { ConfigError, parseRelayConfig } from "./config.ts";
import { serveRelay } from "./relay.ts";

const COUNT_INTERVAL_MS = 60_000;

const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);

let config;
try {
  config = parseRelayConfig(process.env["RELAY_CONFIG"]);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  process.stderr.write(`${JSON.stringify({ error: e.message })}\n`);
  process.exit(2);
}
const relay = await serveRelay(config, { log: out });
out({ event: "relay-listening", resources: config.resources.length });
const timer = setInterval(
  () => out({ event: "relay-counts", counts: relay.takeCounts() }),
  COUNT_INTERVAL_MS,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    clearInterval(timer);
    void relay.close();
  });
