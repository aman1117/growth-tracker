#!/usr/bin/env sh
# Runs the backend test suite with cross-package statement coverage and fails when the
# total is below the minimum.
#
# Usage: scripts/test-coverage.sh [minimum-percent]
#   The minimum defaults to $COVERAGE_MIN, then 90.
#   Set TEST_DATABASE_URL to use an existing PostgreSQL server; otherwise each test package
#   starts an embedded PostgreSQL 16 (see internal/testutil).
#
# Writes coverage.out (profile) and coverage.html (report) in backend/.
set -eu

cd "$(dirname "$0")/.."

min="${1:-${COVERAGE_MIN:-90}}"

# Application packages only: entrypoints in cmd/, generated swagger docs and the test
# harness itself are not part of the measured code.
pkgs=$(go list ./internal/... ./pkg/... | grep -v '/internal/testutil$' | paste -sd, -)

# With -coverpkg every package line reports its share of all measured statements, which
# reads like a per-package figure, so it is trimmed; the merged total is reported below.
# The pipe hides go test's exit status (no pipefail in POSIX sh), so it goes via a file.
status_file=$(mktemp)
trap 'rm -f "$status_file"' EXIT
{
  if go test -count=1 -coverpkg="$pkgs" -coverprofile=coverage.out ./internal/... ./pkg/... 2>&1; then
    echo 0 >"$status_file"
  else
    echo "$?" >"$status_file"
  fi
} | sed 's/[[:space:]]*coverage: [0-9.]*% of statements in .*$//'
status=$(cat "$status_file")
if [ "$status" -ne 0 ]; then
  echo "Backend tests failed (exit ${status})." >&2
  exit "$status"
fi

go tool cover -html=coverage.out -o coverage.html

total=$(go tool cover -func=coverage.out | awk '/^total:/ { sub(/%/, "", $3); print $3 }')
echo "Backend statement coverage: ${total}% (minimum ${min}%)"

if awk -v total="$total" -v min="$min" 'BEGIN { exit !(total + 0 < min + 0) }'; then
  echo "Backend coverage ${total}% is below the ${min}% minimum." >&2
  exit 1
fi
