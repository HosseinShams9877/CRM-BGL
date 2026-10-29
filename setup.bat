@echo off
REM v2.58.1 (audit F6): cd to THIS script's directory so the setup runs
REM from the project root even when launched from another folder (paths
REM with spaces are quoted throughout).
cd /d "%~dp0"
echo ========================================
echo   BGL CRM v2.58.11 - Windows Setup
rem   (full guide: WINDOWS.md / INSTALL.md)
echo ========================================
echo.

REM Check Node.js presence
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js 22 LTS from https://nodejs.org
    pause
    exit /b 1
)

REM Check Node version - 20.9 minimum (Next.js 16's own engines floor,
REM v2.58.1 audit F6: the old 20.6 check predated the Next 16 upgrade),
REM 22 LTS recommended
node -e "const v=process.versions.node.split('.').map(Number);if(v[0]<20||(v[0]===20&&v[1]<9)){console.error('[ERROR] Node.js 20.9 or newer is required. Found '+process.versions.node);console.error('Please install the 22 LTS build from https://nodejs.org and open a NEW terminal.');process.exit(1)}"
if %errorlevel% neq 0 (
    pause
    exit /b 1
)

echo [1/7] Checking for .env ...
if not exist ".env" (
    copy ".env.example" ".env" >nul
    echo   Created .env from .env.example
) else (
    echo   .env already exists - leaving untouched.
)
echo.

REM v2.47.0 — honest BGL_HMAC_SECRET handling (fills an EMPTY value,
REM APPENDS the line when an old .env lacks it, never lies about state).
node scripts\setup-env.mjs
if errorlevel 1 echo [WARN] Could not update BGL_HMAC_SECRET - set it manually before production use.
echo.

echo [2/7] Installing dependencies ...
REM v2.58.4 (external audit F11): a RELEASE package always ships its
REM lockfile — `npm ci` is the ONLY path (EXACTLY the committed dependency
REM tree, reproducible installs). The old `|| call npm install` fallback
REM silently mutated the tree on ANY ci failure (lockfile mismatch, npm
REM integrity error, network hiccup, EPERM) — unreproducible installs.
REM A lockfile-less download is a development checkout, not this package.
if not exist "package-lock.json" (
    echo [ERROR] package-lock.json is missing - this release package is not complete.
    echo         Re-download the ZIP; do not run npm install ^(unreproducible tree^).
    pause
    exit /b 1
)
call npm ci
if %errorlevel% neq 0 (
    echo [ERROR] npm ci failed.
    echo         The dependency tree was NOT modified. If you see EPERM or long
    echo         freezes, your antivirus is scanning node_modules - exclude the
    echo         project folder and re-run setup.bat.
    pause
    exit /b 1
)

echo [3/7] Generating Prisma client...
REM v2.58.1 (audit F6): `call` is REQUIRED — npx is npx.cmd, and a batch
REM script invoking another .cmd WITHOUT call transfers control and NEVER
REM RETURNS (steps 4-7 silently never ran on plain Windows cmd).
call npx prisma generate
if %errorlevel% neq 0 (
    echo [ERROR] Prisma generate failed.
    pause
    exit /b 1
)

echo [4/7] Healing legacy database path (v2.46 and older)...
REM v2.58.4 (external audit F01): the heal is WAL-safe (VACUUM INTO
REM consistent snapshot) and fail-closed — nothing is deleted, the old
REM path is retired into prisma\legacy-doubled-<ts>\. A failure leaves
REM all files untouched but the install MUST STOP: the old bare-copy
REM script lost WAL-committed rows while exiting 0, and the old WARN let
REM the install continue over a broken database state.
node scripts\setup-db-heal.mjs
if %errorlevel% neq 0 (
    echo [ERROR] DB heal failed - the install stops here.
    echo         Nothing was deleted; your data is intact. Close the app if it
    echo         is running and re-run setup.bat.
    pause
    exit /b 1
)
echo.

echo [5/8] Checking migration checksum drift (independent audit 2.58.10, P1-4)...
REM v2.58.11: `prisma migrate status` can FALSELY report "up to date"
REM while applied checksums have drifted from the shipped files — the
REM drift tool is now a GATE BEFORE migrate deploy. Exit 0 = clean
REM (fresh installs included^), exit 2 = drift, exit 1 = operational
REM error; ANY non-zero stops the install. Report mode writes NOTHING,
REM so stopping is free and fully reversible.
node scripts\fix-migration-drift.mjs
if %errorlevel% neq 0 (
    echo.
    echo [STOP] Migration checksum drift detected - the upgrade did NOT proceed.
    echo        Nothing has been written yet. Required, reversible sequence
    echo        ^(UPGRADING-v25811.md section "drift"^):
    echo        1. keep the report above;
    echo        2. node scripts\fix-migration-drift.mjs --confirm
    echo           ^(backs the DB up FIRST via VACUUM INTO, then re-aligns ONLY
    echo            the drifted checksums, then re-reads to prove it^);
    echo        3. re-run this setup.
    echo        Rollback: replace the DB file with the .pre-drift-fix-*.db backup.
    pause
    exit /b 1
)

echo [6/8] Applying database migrations...
call npx prisma migrate deploy
if %errorlevel% neq 0 (
    echo [ERROR] Database migration failed.
    echo         Fix the error above (or restore a backup with
    echo         node scripts\restore-backup.mjs --latest^) and re-run setup.bat.
    pause
    exit /b 1
)

echo [7/8] Seeding initial data (only what is missing)...
REM v2.58.1 (audit F6): the seed is ESSENTIAL (admin account + company rows
REM the FKs depend on^) — a failed seed must fail the setup, not print
REM "Setup Complete". Idempotent upserts make re-runs safe.
REM NOTE: since v2.58.1 the seed never overwrites company profiles/bank
REM data edited in Settings (create-only upserts — see prisma/seed.ts).
call npm run db:seed
if %errorlevel% neq 0 (
    echo [ERROR] Database seed failed.
    pause
    exit /b 1
)

echo [8/8] Building project...
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Setup Complete!
echo ========================================
echo.
echo   Start dev server:    npm run dev
echo   Start production:    npm start
echo   Stop server:         npm run stop
echo   Open browser:        http://localhost:3000
echo   Health check:        http://localhost:3000/api/health
echo.
echo   Login: FIRST-LOGIN.txt was just created at the package root
echo   by the seed step (fresh install only - random, unique to
echo   THIS machine; the release package itself never carries a
echo   password file). Change the password from Settings after
echo   first login, then DELETE that file.
echo.
echo   Lost a password?  node scripts\reset-admin-password.mjs
echo   (prints a new random password once; also --username X
echo   for other accounts.)
echo.
echo   Backup:    POST /api/backup {"action":"snapshot"} as admin,
echo   or  node scripts\backup-cron.mjs   (cron-friendly)
echo   Restore:   node scripts\restore-backup.mjs --latest
echo.
echo   Want a FRESH database instead? Delete prisma\dev.db,
echo   then run:  npm run db:push   +   npm run db:seed
echo   (a random admin password is then printed once).
echo.
pause
