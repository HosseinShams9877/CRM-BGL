// ═══════════════════════════════════════════════════════════════
//  BGL CRM — PM2 process file (v2.29.0)
//
//  ALTERNATIVE to systemd (deploy/bgl-crm.service). Use ONE of the
//  two, not both. PM2 is handy when you already manage other Node
//  services with it; systemd is the zero-dependency default.
//
//  START:
//    pm2 start deploy/pm2.config.cjs
//    pm2 save && pm2 startup      # survive reboots
//
//  NOTES
//   • Node >= 20.6 loads .env natively via --env-file, so the app
//     reads the SAME file systemd would. Values already present in
//     the real environment win over the file (dotenv semantics).
//   • HOSTNAME=127.0.0.1: bind loopback only — nginx stays the only
//     entry point (same rationale as the systemd unit).
//   • NODE_ENV=production is passed explicitly because --env-file
//     does not override variables set in `env` here.
//   • script/args split: PM2 labels the process "node" correctly and
//     does not try to watch-reload a standalone build.
// ═══════════════════════════════════════════════════════════════

module.exports = {
  apps: [
    {
      name: 'bgl-crm',
      script: 'node',
      args: '--env-file=.env .next/standalone/server.js',
      cwd: '/opt/bgl-crm',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOSTNAME: '127.0.0.1',
      },
      // Crash policy — systemd-level equivalents
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '512M',
      // Graceful stop: let next-server flush the SQLite WAL
      kill_timeout: 20000,
      // No cluster mode: SQLite allows exactly ONE writer; the app
      // pins connection_limit=1 per process. Multiple instances on
      // the same DB file would deadlock (INSTALL.md §10-1 rule 4).
      instances: 1,
      exec_mode: 'fork',
      out_file: '/opt/bgl-crm/logs/pm2-out.log',
      error_file: '/opt/bgl-crm/logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
