// Every third-party GitHub Action must be pinned to a full commit SHA, with the
// human-readable tag in a trailing comment. Tags and branches are mutable; a
// compromised upstream could otherwise run arbitrary code with our secrets.

export interface PinViolation {
  readonly file: string;
  readonly line: number;
  readonly uses: string;
  readonly reason: string;
}

const USES = /^\s*(?:-\s+)?uses:\s*(['"]?)([^'"#\s]+)\1\s*(#.*)?$/;
const SHA_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@]+)?@[0-9a-f]{40}$/;
const DOCKER_DIGEST = /^docker:\/\/[^@]+@sha256:[0-9a-f]{64}$/;

export function findUnpinned(file: string, source: string): PinViolation[] {
  const out: PinViolation[] = [];
  source.split("\n").forEach((text, i) => {
    const m = USES.exec(text);
    if (m === null) return;
    const uses = m[2] ?? "";
    const comment = m[3];
    if (uses.startsWith("./")) return;
    if (uses.startsWith("docker://")) {
      if (!DOCKER_DIGEST.test(uses)) {
        out.push({
          file,
          line: i + 1,
          uses,
          reason: "docker image must be pinned by sha256 digest",
        });
      }
      return;
    }
    if (!SHA_REF.test(uses)) {
      out.push({
        file,
        line: i + 1,
        uses,
        reason: "action must be pinned to a 40-character commit SHA",
      });
    } else if (comment === undefined || !/#\s*v?\d/.test(comment)) {
      out.push({
        file,
        line: i + 1,
        uses,
        reason: "pinned action needs a trailing '# vX.Y.Z' comment",
      });
    }
  });
  return out;
}
