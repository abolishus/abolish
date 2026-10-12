// The operator's command line. Commands parse their arguments, call
// @abolishus/core and print one JSON object per line, so a person or an agent
// can drive it (docs/PROJECT_BRIEF.md, Architecture). No domain logic lives
// here.

import type { Sql } from "postgres";
import { parseArgs } from "node:util";
import { CliError, UsageError } from "./errors.ts";
import { moderationCommands } from "./moderation.ts";

export interface CliIo {
  /** One JSON value per call; each becomes a line on stdout. */
  readonly out: (value: unknown) => void;
  /** One JSON value per call; each becomes a line on stderr. */
  readonly err: (value: unknown) => void;
}

export interface Command {
  readonly usage: string;
  readonly options: NonNullable<Parameters<typeof parseArgs>[0]>["options"];
  readonly positionals: number;
  run(
    sql: Sql,
    positionals: readonly string[],
    values: Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>,
    io: CliIo,
  ): Promise<void>;
}

const GROUPS: Readonly<Record<string, Readonly<Record<string, Command>>>> = {
  moderation: moderationCommands,
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
 * can tell a refusal from a broken deployment.
 */
export async function run(argv: readonly string[], sql: Sql, io: CliIo): Promise<number> {
  const [group, name, ...rest] = argv;
  const command = group === undefined || name === undefined ? undefined : GROUPS[group]?.[name];
  try {
    if (command === undefined) throw new UsageError("unknown command");
    let parsed;
    try {
      parsed = parseArgs({
        args: [...rest],
        options: command.options ?? {},
        allowPositionals: true,
        strict: true,
      });
    } catch {
      throw new UsageError("malformed arguments");
    }
    if (parsed.positionals.length !== command.positionals)
      throw new UsageError("wrong number of arguments");
    await command.run(sql, parsed.positionals, parsed.values, io);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err({ error: "usage", detail: e.message, usage: usage() });
      return 2;
    }
    if (e instanceof CliError) {
      io.err({ error: e.code });
      return 1;
    }
    // Not the operator's to fix (an unreachable database, a missing grant).
    // Only the error's kind: its message can name the database's address.
    io.err({ error: "internal", kind: e instanceof Error ? e.name : typeof e });
    return 3;
  }
}
