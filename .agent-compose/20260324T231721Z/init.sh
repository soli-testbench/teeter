#!/bin/bash
# Bootstrap script for shared global leaderboard verification.
# This project has no npm dependencies — only Node.js stdlib is used.
# No setup required beyond having Node.js available.

set -e

# Verify Node.js is available
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is required but not found in PATH"
  exit 1
fi

echo "INFO: Node.js $(node -v) available"
echo "INFO: No dependencies to install (pure Node.js stdlib)"
echo "INFO: Setup complete"
