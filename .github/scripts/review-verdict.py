"""Turn a review's structured output into a PR comment and a pass/fail exit code.

Fails closed: missing or malformed output, verdict "fail", or any blocking
finding fails the check. Inputs (env):
  REVIEW_NAME    claude-review | crypto-review
  REVIEW_JSON    structured_output from anthropics/claude-code-action
  REVIEW_OUTCOME conclusion from the action step
  OUT_FILE       path for the rendered Markdown comment body
The review content is model output derived from untrusted PR content: it is
only ever rendered as Markdown, never executed or interpolated into a shell.
"""

import json
import os
import sys

name = os.environ["REVIEW_NAME"]
raw = os.environ.get("REVIEW_JSON", "")
outcome = os.environ.get("REVIEW_OUTCOME", "")
out_file = os.environ["OUT_FILE"]
marker = f"<!-- abolish:{name} -->"


def write(body: str) -> None:
    with open(out_file, "w", encoding="utf-8") as f:
        f.write(f"{marker}\n{body}\n")


def fail(reason: str) -> None:
    write(f"## {name}: ❌ failed\n\n{reason}")
    print(f"::error::{name}: {reason}")
    sys.exit(1)


if outcome != "success":
    fail(f"the review run did not complete (conclusion: `{outcome or 'unknown'}`). Re-run the check.")
try:
    review = json.loads(raw)
except json.JSONDecodeError:
    fail("the review produced no valid structured output.")
if not isinstance(review, dict) or review.get("verdict") not in ("pass", "fail"):
    fail("the review output has no valid verdict.")

findings = review.get("findings") or []
if not isinstance(findings, list):
    fail("the review output has a malformed findings list.")
blocking = [f for f in findings if isinstance(f, dict) and f.get("severity") == "blocking"]
other = [f for f in findings if isinstance(f, dict) and f.get("severity") != "blocking"]
passed = review["verdict"] == "pass" and not blocking


def line(f: dict) -> str:
    where = f"`{f.get('file', '?')}:{f.get('line', '?')}`"
    threat = f" — threat: {f['threat']}" if f.get("threat") else ""
    detail = str(f.get("detail", "")).strip().replace("\n", "\n  ")
    return f"- **{f.get('title', 'finding')}** {where}{threat}\n  {detail}"


parts = [f"## {name}: {'✅ pass' if passed else '❌ blocking findings'}", "", str(review.get("summary", "")).strip()]
if blocking:
    parts += ["", f"### 🔴 Blocking ({len(blocking)})", *map(line, blocking)]
if other:
    parts += ["", f"### 🟡 Non-blocking ({len(other)})", *map(line, other)]
write("\n".join(parts))
print("\n".join(parts))
if not passed:
    sys.exit(1)
