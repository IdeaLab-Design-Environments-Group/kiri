#!/usr/bin/env bash

set -euo pipefail

threshold=1000
commit_message="emre forgets to commit"

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "Not inside a Git repository."
  exit 1
fi

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

if [[ -z "$(git status --porcelain)" ]]; then
  echo "No changes to commit."
  exit 0
fi

diff_total=$(
  git diff --numstat \
  | awk '{ added += $1; removed += $2 } END { print added + removed + 0 }'
)

if [[ "$diff_total" -lt "$threshold" ]]; then
  echo "Current diff total: $diff_total lines. Threshold is $threshold. No commit created."
  exit 0
fi

git add -A
git commit -m "$commit_message"

echo "Committed changes after $diff_total diff lines with message: $commit_message"
