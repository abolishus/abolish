// The deployment record ([[deployment]]; P2-32 part 2a): built from the
// deploy script's two chain files and the owner's off-chain inputs by core,
// and printed as its hex encoding and deployment hash, or as each service's
// Railway variables (part 2b), so no address, pin or panel key is copied by
// hand (T-34, T-37, T-71). Offline: it reads three files and no chain.

import { readFile } from "node:fs/promises";
import {
  buildDeploymentRecord,
  DeploymentRecordRefused,
  deploymentVariables,
} from "@abolishus/core";
import type { OfflineCommand } from "./cli.ts";
import { CliError, UsageError } from "./errors.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function json(path: string, source: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new CliError("unreadable", { source });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliError("malformed", { source, path: "." });
  }
}

const FILES = {
  l1: { type: "string" },
  l2: { type: "string" },
  inputs: { type: "string" },
} as const;

async function files(values: Readonly<Record<string, unknown>>) {
  const [l1, l2, inputs] = [values["l1"], values["l2"], values["inputs"]];
  if (typeof l1 !== "string" || typeof l2 !== "string" || typeof inputs !== "string")
    throw new UsageError("--l1, --l2 and --inputs are required");
  return [await json(l1, "l1"), await json(l2, "l2"), await json(inputs, "inputs")] as const;
}

function refused<T>(build: () => T): T {
  try {
    return build();
  } catch (e) {
    if (!(e instanceof DeploymentRecordRefused)) throw e;
    const { code, ...detail } = e.error;
    throw new CliError(code, detail);
  }
}

export const deploymentCommands: Readonly<Record<string, OfflineCommand>> = {
  record: {
    usage: "--l1 <L1 chain file> --l2 <L2 chain file> --inputs <inputs file>",
    options: FILES,
    positionals: 0,
    offline: true,
    async run(_, values, io) {
      const read = await files(values);
      const built = refused(() => buildDeploymentRecord(...read));
      io.out({
        version: built.record.version,
        record: hex(built.encoding),
        deploymentHash: hex(built.hash),
      });
    },
  },
  variables: {
    usage:
      "--l1 <L1 chain file> --l2 <L2 chain file> --inputs <inputs file> --coordinator <api URL>",
    options: { ...FILES, coordinator: { type: "string" } },
    positionals: 0,
    offline: true,
    async run(_, values, io) {
      const coordinator = values["coordinator"];
      if (typeof coordinator !== "string") throw new UsageError("--coordinator is required");
      const read = await files(values);
      const { built, services } = refused(() => deploymentVariables(...read, coordinator));
      io.out({ deploymentHash: hex(built.hash), services });
    },
  },
};
