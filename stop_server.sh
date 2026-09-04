#!/usr/bin/env bash
# Stop the vacuum monitoring service.
#
# Serial ports are released and every open CSV is closed cleanly on the way
# out, so this is the right way to stop it rather than kill -9.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pidfile="$here/.vacuum_monitoring.pid"

if [[ ! -f "$pidfile" ]]; then
  echo "No PID file; it does not look like it is running." >&2
  exit 1
fi

pid="$(cat "$pidfile")"
if ! kill -0 "$pid" 2>/dev/null; then
  echo "PID $pid is gone; clearing the stale PID file."
  rm -f "$pidfile"
  exit 0
fi

kill "$pid"
for _ in $(seq 20); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done

if kill -0 "$pid" 2>/dev/null; then
  echo "PID $pid did not stop; sending SIGKILL." >&2
  kill -9 "$pid"
fi

rm -f "$pidfile"
echo "Stopped $pid."
