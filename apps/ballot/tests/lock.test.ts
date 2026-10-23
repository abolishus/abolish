import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { electionLock, electionLockName } from "../src/lock.ts";

// One exclusive lock per election across the origin's tabs ([[delivery]],
// Client rule 2): the name each tab asks for, and what is asked of Web Locks.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

/** The `request` calls a lock made, and a manager that grants each at once. */
function manager() {
  const requests: { name: string; options: LockOptions }[] = [];
  const locks: Pick<LockManager, "request"> = {
    request: ((name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => {
      requests.push({ name, options });
      return Promise.resolve().then(() => callback(null));
    }) as LockManager["request"],
  };
  return { locks, requests };
}

describe("the election's lock", () => {
  test("is named by the whole election ID, so two elections never share one (fast-check)", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        (a, b) => {
          const name = electionLockName(a);
          expect(name).toMatch(/^abolish\/ballot\/election\/[0-9a-f]{64}$/);
          expect(name === electionLockName(b)).toBe(a.every((byte, i) => byte === b[i]));
        },
      ),
      { numRuns },
    );
    expect(electionLockName(Uint8Array.of(0x00, 0x0f, 0xab))).toBe(
      "abolish/ballot/election/000fab",
    );
  });

  test("asks Web Locks for the election's name, exclusively, and answers what the run answers", async () => {
    const { locks, requests } = manager();
    const lock = electionLock(locks);
    if (lock === undefined) throw new Error("no lock");
    const id = new Uint8Array(32).fill(7);
    await expect(lock(id, () => Promise.resolve("ran"))).resolves.toBe("ran");
    expect(requests).toEqual([{ name: electionLockName(id), options: { mode: "exclusive" } }]);
  });

  test("passes on a run's rejection, so the lock goes with it", async () => {
    const { locks } = manager();
    const lock = electionLock(locks);
    if (lock === undefined) throw new Error("no lock");
    await expect(
      lock(new Uint8Array(32), () => Promise.reject(new Error("stopped"))),
    ).rejects.toThrow("stopped");
  });

  test("is none where the browser has no Web Locks", () => {
    expect(electionLock(undefined)).toBeUndefined();
  });
});
