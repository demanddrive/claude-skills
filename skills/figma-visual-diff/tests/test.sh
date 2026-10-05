#!/usr/bin/env bash
# Offline regression tests for figma-visual-diff's comparison logic (pairing, matching,
# triage). No browser, no network.
#
#   ./tests/test.sh          # exits 0 if all checks pass, 1 otherwise
set -uo pipefail
cd "$(dirname "$0")/.."
node --test tests/*.test.js
