#!/bin/sh
mkdir -p /data

# Start Node API in the background with automatic restarts.
# A fixed 2-second delay between restarts prevents tight loops.
# The API process is non-critical — if it crashes, the frontend
# continues serving (with localStorage fallback for the leaderboard).
(
  while true; do
    echo "INFO: Starting Node API..." >&2
    node /app/api/server.js
    echo "WARN: Node API exited with status $?; restarting in 2s..." >&2
    sleep 2
  done
) &

# Run nginx in the foreground as PID 1's child.
nginx -g 'daemon off;'
