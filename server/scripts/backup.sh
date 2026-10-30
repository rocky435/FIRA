#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# FIRA Database Backup Script
#
# Usage:
#   Manual:   ./backup.sh
#   Via cron: 0 2 * * * /home/ubuntu/Fira/server/scripts/backup.sh >> /home/ubuntu/backups/backup.log 2>&1
#
# Environment (all optional):
#   MONGODB_URI     — connection string; read from server/.env when not set,
#                     so a changed DB password is picked up automatically
#   BACKUP_DIR      — defaults to ~/backups/fira
#   RETENTION_DAYS  — defaults to 14
#   BACKUP_PING_URL — pinged after a good backup (e.g. a free healthchecks.io
#                     check), so a backup that stops running raises an alert
#
# The script:
#   1. Runs mongodump (gzipped) into a temp dir, then renames it to the date,
#      so a failed run never leaves a half-written backup behind
#   2. Removes backups older than RETENTION_DAYS (only after a good backup)
#   3. Exits non-zero on failure
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/fira}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DATE=$(date +%Y-%m-%d)
TARGET="${BACKUP_DIR}/${DATE}"
TMP="${BACKUP_DIR}/.partial-${DATE}"

if [ -z "${MONGODB_URI:-}" ] && [ -f "${ENV_FILE}" ]; then
  MONGODB_URI=$(grep -E '^MONGODB_URI=' "${ENV_FILE}" | tail -1 | cut -d= -f2- \
    | sed -e 's/\r$//' -e 's/^["'\'']//' -e 's/["'\'']$//')
fi

if [ -z "${MONGODB_URI:-}" ]; then
  echo "[ERROR] MONGODB_URI is not set and not found in ${ENV_FILE}. Aborting." >&2
  exit 1
fi

echo "[$(date -Iseconds)] Starting backup → ${TARGET}"

mkdir -p "${BACKUP_DIR}"
rm -rf "${TMP}"
trap 'rm -rf "${TMP}"' EXIT

mongodump --uri="${MONGODB_URI}" --gzip --out="${TMP}" --quiet

rm -rf "${TARGET}"
mv "${TMP}" "${TARGET}"

echo "[$(date -Iseconds)] Backup complete ($(du -sh "${TARGET}" | cut -f1)). Pruning backups older than ${RETENTION_DAYS} days..."

find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +"${RETENTION_DAYS}" -exec rm -rf {} +

if [ -n "${BACKUP_PING_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 "${BACKUP_PING_URL}" > /dev/null || echo "[WARN] Could not ping ${BACKUP_PING_URL}" >&2
fi

echo "[$(date -Iseconds)] Done."
