#!/bin/sh
set -eu

MAX_RETRIES=${MAX_RETRIES:-30}
SLEEP_SECONDS=${SLEEP_SECONDS:-2}
RETRIES=0

# One-time marker settings (can be overridden at runtime)
MARKER_DIR=${MARKER_DIR:-/var/lib/heartland}
MARKER_FILE="$MARKER_DIR/.seed_done"
FORCE_RESEED=${FORCE_RESEED:-0}

mkdir -p "$MARKER_DIR"

echo "Waiting for DB and applying Prisma migrations..."
until npx prisma migrate deploy >/dev/null 2>&1; do
  RETRIES=$((RETRIES+1))
  echo "Prisma migrate attempt $RETRIES/$MAX_RETRIES failed — sleeping ${SLEEP_SECONDS}s"
  if [ "$RETRIES" -ge "$MAX_RETRIES" ]; then
    echo "Migrations failed after $MAX_RETRIES attempts" >&2
    # show last error for debugging
    npx prisma migrate deploy || true
    exit 1
  fi
  sleep "$SLEEP_SECONDS"
done

echo "Migrations applied."

if [ "${FORCE_RESEED}" = "1" ]; then
  echo "FORCE_RESEED=1 detected — removing marker to force seeding"
  rm -f "$MARKER_FILE" || true
fi

if [ -f "$MARKER_FILE" ]; then
  echo "Seeder marker found at $MARKER_FILE — skipping seeding."
else
  echo "Running seeder..."
  if node prisma/seed.js; then
    echo "Seeder finished successfully. Creating marker at $MARKER_FILE"
    touch "$MARKER_FILE"
  else
    echo "Seeder failed." >&2
    exit 1
  fi
fi

echo "Starting app..."
exec node src/index.js