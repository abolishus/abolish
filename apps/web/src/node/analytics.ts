// PostHog, reached only from our server. Browsers report to /ingest on our
// own origin (src/node/serve.ts), so no page loads PostHog's code or talks to
// its host, and PostHog sees our server's address, never a visitor's.
//
// T-67: each event gets a fresh random distinct ID and no person profile, so
// nothing in PostHog follows a visitor from one page to the next or joins
// them to an account; GeoIP is off; pages are templates (src/analytics.ts).
// Events are sent in batches without their own timestamps, so PostHog places
// them at the batch's arrival rather than at the moment of each request.

import type { ClientError, Page } from "../analytics.ts";

export interface Analytics {
  /** A page was served with `status`. */
  pageview(page: Page, status: number): void;
  /** Our own code failed: in a browser (`client`) or in this server. */
  exception(source: "client" | "server", error: ClientError): void;
  /** Sends what is queued and stops. */
  close(): Promise<void>;
}

export interface AnalyticsOptions {
  /** PostHog's ingestion origin, such as `https://eu.i.posthog.com`. */
  readonly host: string;
  /** The project API key (public: it can only send events). */
  readonly key: string;
  /** Default: the platform's. */
  readonly fetch?: typeof fetch;
  /** Errors, by kind only. */
  readonly log: (line: { readonly error: string }) => void;
  /** Default 10 s. */
  readonly flushIntervalMs?: number;
  /** Events held at most; past it, new ones are dropped until a flush (T-52). Default 1000. */
  readonly maxQueue?: number;
}

/** One event in PostHog's batch format. */
export interface PostHogEvent {
  readonly event: string;
  readonly distinct_id: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

const BATCH_TIMEOUT_MS = 10_000;

/** Analytics that send nothing, for a deployment without PostHog. */
export const noAnalytics: Analytics = {
  pageview: () => {},
  exception: () => {},
  close: async () => {},
};

export function createAnalytics({
  host,
  key,
  fetch: send = fetch,
  log,
  flushIntervalMs = 10_000,
  maxQueue = 1000,
}: AnalyticsOptions): Analytics {
  const origin = new URL(host);
  if (origin.protocol !== "https:" || origin.origin !== host)
    throw new RangeError("host must be a bare https origin");
  const endpoint = new URL("/batch/", origin).href;
  let queue: PostHogEvent[] = [];
  let sending = Promise.resolve();

  function push(event: string, properties: Record<string, unknown>) {
    if (queue.length >= maxQueue) return;
    queue.push({
      event,
      distinct_id: crypto.randomUUID(),
      properties: {
        ...properties,
        $process_person_profile: false,
        $geoip_disable: true,
        $lib: "abolish-web",
      },
    });
  }

  async function post(batch: PostHogEvent[]) {
    try {
      const response = await send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: key, batch }),
        redirect: "error",
        signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (!response.ok) log({ error: `analytics: HTTP ${response.status}` });
    } catch (error) {
      // Best effort: a lost batch is not retried.
      log({ error: `analytics: ${error instanceof Error ? error.name : typeof error}` });
    }
  }

  function flush(): Promise<void> {
    if (queue.length > 0) {
      const batch = queue;
      queue = [];
      sending = sending.then(() => post(batch));
    }
    return sending;
  }

  const timer = setInterval(() => void flush(), flushIntervalMs);
  timer.unref();

  return {
    pageview(page, status) {
      push("$pageview", { $current_url: page, $pathname: page, status });
    },
    exception(source, { page, name, frames }) {
      push("$exception", {
        source,
        $current_url: page,
        $exception_list: [
          {
            type: name,
            mechanism: { handled: false, synthetic: false },
            stacktrace: {
              type: "raw",
              frames: frames.map((frame) => {
                // Every frame matched FRAME (src/analytics.ts), which ends in `:line:column`.
                const [, filename, line, column] = /^(.*):([0-9]+):([0-9]+)$/.exec(frame)!;
                return {
                  filename,
                  lineno: Number(line),
                  colno: Number(column),
                  platform: "web:javascript",
                };
              }),
            },
          },
        ],
      });
    },
    close() {
      clearInterval(timer);
      return flush();
    },
  };
}
