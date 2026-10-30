// The operator's command line. Commands parse their arguments, call
// @abolishus/core and print one JSON object per line, so a person or an agent
// can drive it (docs/PROJECT_BRIEF.md, Architecture). No domain logic lives
// here.

import type { Sql } from "postgres";
import { parseArgs } from "node:util";
import { deploymentCommands } from "./deployment.ts";
import { CliError, UsageError } from "./errors.ts";
import { moderationCommands } from "./moderation.ts";
import { simulationCommands } from "./simulation.ts";
import { tier0KeyCommands } from "./tier0-keys.ts";

export interface CliIo {
  /** One JSON value per call; each becomes a line on stdout. */
  readonly out: (value: unknown) => void;
  /** One JSON value per call; each becomes a line on stderr. */
  readonly err: (value: unknown) => void;
}

type Values = Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;

interface CommandShape {
  readonly usage: string;
  readonly options: NonNullable<Parameters<typeof parseArgs>[0]>["options"];
  readonly positionals: number;
}

/** A command on the operator's database. */
export interface Command extends CommandShape {
  run(sql: Sql, positionals: readonly string[], values: Values, io: CliIo): Promise<void>;
}

/** A command that never touches the database, such as a simulation, so it runs without one. */
export interface OfflineCommand extends CommandShape {
  readonly offline: true;
  run(positionals: readonly string[], values: Values, io: CliIo): Promise<void>;
}

const GROUPS: Readonly<Record<string, Readonly<Record<string, Command | OfflineCommand>>>> = {
  deployment: deploymentCommands,
  moderation: moderationCommands,
  simulation: simulationCommands,
  "tier0-keys": tier0KeyCommands,
};

export function usage(): string {
  const lines = ["usage: admin-cli <group> <command> [arguments]", ""];
  for (const [group, commands] of Object.entries(GROUPS))
    for (const [name, command] of Object.entries(commands))
      lines.push(`  ${group} ${name} ${command.usage}`.trimEnd());
  return lines.join("\n");
}

/**
 * Runs one command and returns its exit code: 0 on success, 1 when core
 * refuses it, 2 for malformed arguments, 3 for any other failure, so a caller
 * can tell a refusal from a broken deployment. `connect` opens the database
 * connection; only a command on the database calls it, so a simulation runs
 * where no database is configured.
 */
export async function run(argv: readonly string[], connect: () => Sql, io: CliIo): Promise<number> {
  const [group, name, ...rest] = argv;
  // Own properties only, so a name such as `constructor` is an unknown command.
  const commands = group !== undefined && Object.hasOwn(GROUPS, group) ? GROUPS[group] : undefined;
  const command =
    commands !== undefined && name !== undefined && Object.hasOwn(commands, name)
      ? commands[name]
      : undefined;
  try {
    if (command === undefined) throw new UsageError("unknown command");
    let parsed;
    try {
      parsed = parseArgs({
        args: [...rest],
        options: command.options ?? {},
        allowPositionals: true,
        strict: true,
        tokens: true,
      });
    } catch {
      throw new UsageError("malformed arguments");
    }
    // parseArgs keeps an option's last value, so `--place A --place B` would
    // file B without a word; an option given twice is a typo to refuse.
    const names = parsed.tokens.flatMap((t) => (t.kind === "option" ? [t.name] : []));
    if (new Set(names).size !== names.length) throw new UsageError("an option is given twice");
    if (parsed.positionals.length !== command.positionals)
      throw new UsageError("wrong number of arguments");
    if ("offline" in command) await command.run(parsed.positionals, parsed.values, io);
    else await command.run(connect(), parsed.positionals, parsed.values, io);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err({ error: "usage", detail: e.message, usage: usage() });
      return 2;
    }
    if (e instanceof CliError) {
      io.err({ ...e.detail, error: e.code });
      return 1;
    }
    // Not the operator's to fix (an unreachable database, a missing grant).
    // Only the error's kind: its message can name the database's address.
    io.err({ error: "internal", kind: e instanceof Error ? e.name : typeof e });
    return 3;
  }
}
