// A named session advisory lock for a run that must not overlap another
// process's: the anchoring run (P4-3 part 4b-2b) and the archive run (part
// 4b-1). Each sends or posts for minutes at a time, longer than any
// transaction should stay open, so the lock is a session's, held on one
// reserved connection while the work goes through the pool's others.

import type { Sql } from "postgres";

/**
 * Runs `work` while a reserved connection holds the session lock `name`, or
 * returns `undefined` without running it if another session holds it. The
 * lock is keyed by the name and the connection's schema, since what it
 * guards is that schema's tables: a deployment has one, and every process
 * writing it must resolve the same schema first on its search path. The
 * work goes through the pool's other connections, so the pool needs at
 * least two.
 *
 * A session lock is lost silently if its connection drops, and holds nothing
 * behind a transaction-mode pooler, so it keeps runs apart only on a direct
 * connection; callers keep whatever a second run could break safe without it.
 */
export async function withSessionLock<T>(
  client: Sql,
  name: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  if (!(client.options.max >= 2))
    throw new RangeError(`the ${name} lock needs a pool of at least two connections`);
  const key = (sql: Sql) => sql`hashtextextended(${name} || ':' || current_schema(), 0)`;
  const conn = await client.reserve();
  try {
    const [row] = await conn`SELECT pg_try_advisory_lock(${key(conn)}) AS held`;
    // NULL when no schema on the search path exists: refused rather than
    // read as held elsewhere, which would make every run quietly do nothing.
    if (typeof row?.["held"] !== "boolean") throw new Error(`the ${name} lock has no schema`);
    if (!row["held"]) return undefined;
    const unlock = () => conn`SELECT pg_advisory_unlock(${key(conn)})`;
    let result: T;
    try {
      result = await work();
    } catch (e) {
      // A connection lost mid-run took the lock with it; the work's own error says more.
      await unlock().catch(() => {});
      throw e;
    }
    await unlock();
    return result;
  } finally {
    conn.release();
  }
}
