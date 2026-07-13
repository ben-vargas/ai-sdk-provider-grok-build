#!/usr/bin/env bash

set -uo pipefail

echo "Building project..."
npm run build || exit 1

examples=(
  basic-generate-text
  streaming
  tool-activity
  session-continuity
  abort-signal
  error-handling
  usage-and-cost
  provider-options
)

failed=()
for example in "${examples[@]}"; do
  echo
  echo "========================================="
  echo "Running: ${example}.ts"
  echo "========================================="
  if ! npx tsx "examples/${example}.ts"; then
    failed+=("${example}")
  fi
done

echo
if ((${#failed[@]} > 0)); then
  echo "Failed examples: ${failed[*]}" >&2
  exit 1
fi

echo "All examples completed."
