#!/bin/bash
# v2.58.1 (audit F6): run from THIS script's directory (robust to being
# invoked from elsewhere) and FAIL FAST — `set -e` stops on the first
# failing critical step (deps / generate / migrate / seed / build), so
# "Setup Complete" is only ever printed after a fully successful run.
# v2.58.4 (external audit F01/F11): the npm-ci→npm-install fallback and the
# DB-heal WARN are GONE — a release package with a lockfile installs
# reproducibly or stops, and a heal failure stops the install (the DB heal
# is now WAL-safe and fail-closed; a failure means real trouble).
set -e
cd "$(dirname "$0")"
echo "========================================"
echo "  BGL CRM v2.58.11 - Linux/Mac Setup"
echo "  (full guide: INSTALL.md)"
echo "========================================"
echo ""

# v2.58.1 (audit F6): Node version floor 20.9 — Next.js 16's own engines
# floor (the old 20.6 check predated the Next 16 upgrade).
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Install Node.js 22 LTS from https://nodejs.org"
  exit 1
fi
node -e 'const v=process.versions.node.split(".").map(Number);if(v[0]<20||(v[0]===20&&v[1]<9)){console.error("[ERROR] Node.js 20.9 or newer is required. Found "+process.versions.node);process.exit(1)}' || {
  echo "[ERROR] Install the 22 LTS build from https://nodejs.org, then open a NEW terminal."
  exit 1
}

echo "[1/7] Checking for .env ..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  Created .env from .env.example"
else
  echo "  .env already exists — leaving untouched."
fi

# v2.47.0 — honest BGL_HMAC_SECRET handling (fills an EMPTY value,
# APPENDS the line when an old .env lacks it, never lies about state).
node scripts/setup-env.mjs || echo "[WARN] Could not update BGL_HMAC_SECRET."
echo ""

echo "[2/7] Installing dependencies..."
# v2.58.4 (external audit F11): a RELEASE package always ships its lockfile —
# `npm ci` is the only path (EXACTLY the committed dependency tree). The old
# `|| npm install` fallback silently mutated the tree on any ci failure
# (integrity mismatch, network error, EPERM) — unreproducible installs.
# A lockfile-less download is a development checkout, not this package.
if [ ! -f package-lock.json ]; then
  echo "[ERROR] package-lock.json is missing — this release package is not complete."
  echo "         Re-download the ZIP; do not run npm install (unreproducible tree)."
  exit 1
fi
npm ci

echo "[3/7] Generating Prisma client..."
npx prisma generate

echo "[4/7] Healing legacy database path (v2.46 and older)..."
# v2.58.4 (external audit F01): the heal is WAL-safe (VACUUM INTO snapshot)
# and fail-closed — a failure leaves everything untouched but the install
# MUST stop (the old bare-copy script lost WAL-committed rows with exit 0,
# and the old WARN let the install continue over a broken DB state).
node scripts/setup-db-heal.mjs
echo ""

echo "[5/8] Checking migration checksum drift (independent audit 2.58.10, P1-4)..."
# v2.58.11: `prisma migrate status` can FALSELY report "up to date" while
# applied checksums have drifted from the shipped files — and nothing used
# to stop the install before `migrate deploy` walked over that state. The
# drift tool is now a GATE: exit 0 = clean (fresh installs included),
# exit 2 = drift detected, exit 1 = operational error. ANY non-zero stops
# the install — nothing is written in report mode, so stopping is free.
if ! node scripts/fix-migration-drift.mjs; then
  echo ""
  echo "[STOP] migration checksum drift detected — the upgrade did NOT proceed."
  echo "       Required, reversible sequence (UPGRADING-v25811.md §drift):"
  echo "       1. keep the report above (nothing has been written yet);"
  echo "       2. node scripts/fix-migration-drift.mjs --confirm"
  echo "          (backs the DB up FIRST via VACUUM INTO, then re-aligns"
  echo "           ONLY the drifted checksums, then re-reads to prove it);"
  echo "       3. re-run this setup."
  echo "       Rollback: replace the DB file with the .pre-drift-fix-*.db backup."
  exit 1
fi

echo "[6/8] Applying database migrations..."
npx prisma migrate deploy
echo "  (on failure: fix the error above, or restore a backup with"
echo "   node scripts/restore-backup.mjs --latest, then re-run setup.sh)"

echo "[7/8] Seeding initial data (only what is missing)..."
# v2.58.1 (audit F6): the seed is ESSENTIAL (admin account + the company
# rows the FKs depend on) — failure now FAILS the setup instead of a WARN
# followed by "Setup Complete". Idempotent upserts make re-runs safe.
# NOTE: since v2.58.1 the seed never overwrites company profiles/bank data
# edited in Settings (create-only upserts — see prisma/seed.ts).
npm run db:seed

echo "[8/8] Building project..."
npm run build

echo ""
echo "========================================"
echo "  Setup Complete!"
echo "========================================"
echo ""
echo "  Start dev server:    npm run dev"
echo "  Start production:    npm start"
echo "  Stop server:         npm run stop"
echo "  Open browser:        http://localhost:3000"
echo "  Health check:        http://localhost:3000/api/health"
echo ""
echo "  Login: the one-time passwords for this package are in"
echo "  FIRST-LOGIN.txt at the package root (random, unique to"
echo "  THIS package). Change them from Settings after first"
echo "  login, then DELETE that file."
echo ""
echo "  Lost a password?  node scripts/reset-admin-password.mjs"
echo "  (prints a new random password once; also --username X"
echo "  for other accounts.)"
echo ""
echo "  Backup (DB + files): npm run backup:snapshot"
echo "  or POST /api/backup {\"action\":\"package\"} as admin"
echo "  Restore:             node scripts/restore-backup.mjs --latest"
echo ""
echo "  Want a FRESH database instead? Delete prisma/dev.db,"
echo "  then run:  npm run db:push   +   npm run db:seed"
echo "  (a random admin password is then printed once)."
echo ""
