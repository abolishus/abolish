#!/usr/bin/env bash
# Create or update this review's single PR comment (identified by a marker line).
# Usage: upsert-comment.sh <pr-number> <body-file>   (needs GH_TOKEN, GITHUB_REPOSITORY)
set -euo pipefail
pr="$1"
body_file="$2"
marker="$(head -1 "$body_file")"
id="$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$pr/comments" \
  --jq ".[] | select(.user.login == \"github-actions[bot]\") | select(.body | startswith(\"$marker\")) | .id" | head -1)"
if [ -n "$id" ]; then
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$id" -F "body=@$body_file" >/dev/null
else
  gh api -X POST "repos/$GITHUB_REPOSITORY/issues/$pr/comments" -F "body=@$body_file" >/dev/null
fi
