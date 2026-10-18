import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeElectionDefinition, panelId } from "@abolishus/crypto";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { cli } from "../src/cli.ts";
import { ConfigError } from "../src/config.ts";
import { IDENTITY_KEY_FILE, seatFromEnv, STORE_DIR } from "../src/env-seat.ts";
import { LocalCoordinator, serveCoordinator } from "../src/local.ts";
import { L2_CHAIN_ID, panelOf, stubFor, TRUSTEE_REGISTRY } from "./fixture.ts";

// A seat from its environment and one volume (docs/runbooks/trustee-node.md,
// Staging on Railway): the key is written once, owner-only, and never
// replaced; the key file and the store are the volume's, never configured,
// and a key whose store is gone never starts again; neither the key nor the
// configuration is quoted in a refusal (T-14, T-37, T-65).

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const { panel, secrets } = panelOf(3, 2);
const keyOf = (seat: number) => `${hex(secrets[seat - 1] as Uint8Array)}\n`;

function configFor(seat: number, change: Record<string, unknown> = {}): string {
  return JSON.stringify({
    panel: { threshold: 2, keys: panel.keys.map(hex) },
    panelId: hex(panelId(panel)),
    l2ChainId: L2_CHAIN_ID.toString(),
    trusteeRegistry: hex(TRUSTEE_REGISTRY),
    seat,
    coordinator: "https://coordinator.example/",
    ...change,
  });
}

let root: string;
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "trustee-node-env-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

/** A fresh, empty volume. */
async function volume(): Promise<string> {
  const data = join(root, `data-${n++}`);
  await mkdir(data, { mode: 0o700 });
  return data;
}

async function refusal(run: Promise<unknown>): Promise<string> {
  const e = await run.then(
    () => expect.unreachable("accepted"),
    (e: unknown) => e,
  );
  expect(e).toBeInstanceOf(ConfigError);
  const message = (e as Error).message;
  for (const s of secrets) expect(message).not.toContain(hex(s));
  return message;
}

describe("seatFromEnv", () => {
  test("writes the key once, owner-only, as keygen does, and points run at the volume", async () => {
    const data = await volume();
    const text = await seatFromEnv({ config: configFor(1), identityKey: keyOf(1) }, data);
    const keyFile = join(data, IDENTITY_KEY_FILE);
    expect(JSON.parse(text)).toMatchObject({
      seat: 1,
      identityKeyFile: keyFile,
      store: join(data, STORE_DIR),
    });
    expect(await readFile(keyFile, "utf8")).toBe(keyOf(1));
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    // Again with the same key, as every later deployment: nothing changes.
    expect(await seatFromEnv({ config: configFor(1), identityKey: keyOf(1) }, data)).toBe(text);
    expect(await readFile(keyFile, "utf8")).toBe(keyOf(1));
    expect((await readdir(data)).sort()).toEqual([IDENTITY_KEY_FILE, STORE_DIR]);
  });

  test("takes the key without its trailing newline", async () => {
    const data = await volume();
    await seatFromEnv({ config: configFor(2), identityKey: keyOf(2).trim() }, data);
    expect(await readFile(join(data, IDENTITY_KEY_FILE), "utf8")).toBe(keyOf(2));
  });

  test("runs from the key on the volume once the variable is removed", async () => {
    const data = await volume();
    await seatFromEnv({ config: configFor(1), identityKey: keyOf(1) }, data);
    await seatFromEnv({ config: configFor(1), identityKey: undefined }, data);
    await seatFromEnv({ config: configFor(1), identityKey: "" }, data);
    expect(await readFile(join(data, IDENTITY_KEY_FILE), "utf8")).toBe(keyOf(1));
  });

  test("refuses a key other than the one on the volume, and never replaces it", async () => {
    const data = await volume();
    await seatFromEnv({ config: configFor(1), identityKey: keyOf(1) }, data);
    // Another seat's configuration and key, both consistent, on seat 1's volume.
    expect(await refusal(seatFromEnv({ config: configFor(2), identityKey: keyOf(2) }, data))).toBe(
      "TRUSTEE_IDENTITY_KEY: not the key already on the volume, which is never replaced",
    );
    expect(await readFile(join(data, IDENTITY_KEY_FILE), "utf8")).toBe(keyOf(1));
    expect((await readdir(data)).sort()).toEqual([IDENTITY_KEY_FILE, STORE_DIR]);
  });

  test("refuses a key on the volume without its store, with the variable set or not", async () => {
    const data = await volume();
    await seatFromEnv({ config: configFor(1), identityKey: keyOf(1) }, data);
    await rm(join(data, STORE_DIR), { recursive: true });
    for (const identityKey of [keyOf(1), undefined])
      expect(await refusal(seatFromEnv({ config: configFor(1), identityKey }, data))).toBe(
        "store: missing beside the key on the volume; it is never started again",
      );
    expect(await readdir(data)).toEqual([IDENTITY_KEY_FILE]);
  });

  test("refuses a key that isn't the configured seat's before writing anything", async () => {
    const data = await volume();
    expect(await refusal(seatFromEnv({ config: configFor(1), identityKey: keyOf(2) }, data))).toBe(
      "TRUSTEE_IDENTITY_KEY: not the key of the configured seat",
    );
    expect(await readdir(data)).toEqual([]);
  });

  test("refuses a malformed key, or none at all, without quoting it", async () => {
    const data = await volume();
    for (const key of [keyOf(1).toUpperCase(), `0x${keyOf(1)}`, keyOf(1).slice(2), `${keyOf(1)}\n`])
      expect(await refusal(seatFromEnv({ config: configFor(1), identityKey: key }, data))).toBe(
        "TRUSTEE_IDENTITY_KEY: expected 64 hex digits",
      );
    expect(
      await refusal(seatFromEnv({ config: configFor(1), identityKey: "00".repeat(32) }, data)),
    ).toBe("TRUSTEE_IDENTITY_KEY: not a P-256 secret key");
    expect(await refusal(seatFromEnv({ config: configFor(1), identityKey: undefined }, data))).toBe(
      "TRUSTEE_IDENTITY_KEY: not set, and no key on the volume",
    );
    expect(await readdir(data)).toEqual([]);
  });

  test("refuses a configuration naming its own key file or store, or none, or not an object", async () => {
    const data = await volume();
    for (const change of [{ identityKeyFile: "/tmp/key" }, { store: "/tmp/store" }])
      expect(
        await refusal(seatFromEnv({ config: configFor(1, change), identityKey: keyOf(1) }, data)),
      ).toBe("TRUSTEE_CONFIG: identityKeyFile and store are the volume's");
    expect(await refusal(seatFromEnv({ config: undefined, identityKey: keyOf(1) }, data))).toBe(
      "TRUSTEE_CONFIG: not set",
    );
    expect(await refusal(seatFromEnv({ config: "{", identityKey: keyOf(1) }, data))).toBe(
      "TRUSTEE_CONFIG: not JSON",
    );
    expect(await refusal(seatFromEnv({ config: "[]", identityKey: keyOf(1) }, data))).toBe(
      "TRUSTEE_CONFIG: not a JSON object",
    );
    // run's own checks apply before anything is written.
    expect(
      await refusal(seatFromEnv({ config: configFor(4), identityKey: keyOf(1) }, data)),
    ).toMatch(/^config: seat/);
    expect(await readdir(data)).toEqual([]);
  });

  test("refuses a volume that isn't there rather than starting from an empty store", async () => {
    expect(
      await refusal(
        seatFromEnv({ config: configFor(1), identityKey: keyOf(1) }, join(root, "absent")),
      ),
    ).toBe("data: ENOENT");
    const file = join(root, "a-file");
    await writeFile(file, "");
    expect(await refusal(seatFromEnv({ config: configFor(1), identityKey: keyOf(1) }, file))).toBe(
      "data: not a directory",
    );
  });

  test("writes the key beside a store a crash left made but empty", async () => {
    const data = await volume();
    await mkdir(join(data, STORE_DIR), { mode: 0o700 });
    await seatFromEnv({ config: configFor(1), identityKey: keyOf(1) }, data);
    expect(await readFile(join(data, IDENTITY_KEY_FILE), "utf8")).toBe(keyOf(1));
  });

  test("removes the pending key file a crash left before linking it", async () => {
    const data = await volume();
    await writeFile(join(data, `.${IDENTITY_KEY_FILE}.tmp`), keyOf(2).slice(0, 10), {
      mode: 0o600,
    });
    await seatFromEnv({ config: configFor(1), identityKey: keyOf(1) }, data);
    expect((await readdir(data)).sort()).toEqual([IDENTITY_KEY_FILE, STORE_DIR]);
    expect(await readFile(join(data, IDENTITY_KEY_FILE), "utf8")).toBe(keyOf(1));
  });
});

describe("run-env", () => {
  test("runs the seat from its environment and volume, removing the key from the environment", async () => {
    const stub = encodeElectionDefinition(stubFor(panel));
    const coordinator = new LocalCoordinator({
      stub,
      panel,
      l2ChainId: L2_CHAIN_ID,
      trusteeRegistry: TRUSTEE_REGISTRY,
      roundMs: 60_000,
      now: () => 0,
    });
    const { url, server } = await serveCoordinator(coordinator);
    const data = await volume();
    process.env["TRUSTEE_CONFIG"] = configFor(1, { coordinator: url, pollSeconds: 3600 });
    process.env["TRUSTEE_IDENTITY_KEY"] = keyOf(1);
    try {
      const stop = new AbortController();
      const out: unknown[] = [];
      const err: unknown[] = [];
      const code = await cli(["run-env", "--data", data], {
        out: (v) => {
          out.push(v);
          if ((v as { event?: string }).event === "refused") stop.abort();
        },
        err: (v) => err.push(v),
        signal: stop.signal,
      });
      expect(code).toBe(0);
      expect(err).toEqual([]);
      expect(out).toMatchObject([
        { event: "started", seat: 1 },
        { event: "refused", round: 1, code: "stub-electorate" },
      ]);
      expect(process.env["TRUSTEE_IDENTITY_KEY"]).toBeUndefined();
      expect(process.env["TRUSTEE_CONFIG"]).toBeUndefined();
      expect((await readdir(data)).sort()).toEqual([IDENTITY_KEY_FILE, STORE_DIR]);
      expect((await stat(join(data, STORE_DIR))).mode & 0o777).toBe(0o700);
    } finally {
      delete process.env["TRUSTEE_CONFIG"];
      delete process.env["TRUSTEE_IDENTITY_KEY"];
      server.close();
    }
  }, 60_000);

  test("exits 2 on a refusal, printing nothing secret, and needs --data", async () => {
    const data = await volume();
    process.env["TRUSTEE_CONFIG"] = configFor(1);
    process.env["TRUSTEE_IDENTITY_KEY"] = keyOf(2);
    try {
      for (const argv of [["run-env", "--data", data], ["run-env"]]) {
        process.env["TRUSTEE_CONFIG"] = configFor(1);
        process.env["TRUSTEE_IDENTITY_KEY"] = keyOf(2);
        const out: unknown[] = [];
        const err: unknown[] = [];
        const code = await cli(argv, {
          out: (v) => out.push(v),
          err: (v) => err.push(v),
          signal: new AbortController().signal,
        });
        expect(code).toBe(2);
        expect(out).toEqual([]);
        expect(err).toHaveLength(1);
        for (const s of secrets) expect(JSON.stringify(err)).not.toContain(hex(s));
      }
      expect(await readdir(data)).toEqual([]);
    } finally {
      delete process.env["TRUSTEE_CONFIG"];
      delete process.env["TRUSTEE_IDENTITY_KEY"];
    }
  });
});
