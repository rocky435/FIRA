module.exports = {
    apps: [
        // Backend API - Cluster Mode (zero-downtime via `pm2 reload fira-api`)
        {
            name: 'fira-api',
            script: 'index.js',
            instances: 2,
            exec_mode: 'cluster',
            cwd: './server',
            wait_ready: true,
            listen_timeout: 10000,
            // ponytail: PM2 only applies `env_production` when started with
            // `--env production` (as deploy.sh does). Without this block PM2 warns
            // "Environment [production] is not defined in process file" and the
            // intended NODE_ENV/PORT are easy to lose. Both blocks are defined so
            // `pm2 start ecosystem.config.js` and `--env production` behave alike.
            // TZ: booking deadlines, refund windows and the daily 09:00 reminder
            // read "HH:MM" times in the server's local time. EC2 defaults to UTC,
            // which put every one of them 5.5 hours off for Indian bookings.
            env: {
                NODE_ENV: 'production',
                PORT: 5000,
                TZ: 'Asia/Kolkata'
            },
            env_production: {
                NODE_ENV: 'production',
                PORT: 5000,
                TZ: 'Asia/Kolkata'
            },
            watch: false,
            max_memory_restart: '1G',
            error_file: './logs/backend-error.log',
            out_file: './logs/backend-out.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            merge_logs: true,
            autorestart: true,
            max_restarts: 10,
            min_uptime: '10s',
            kill_timeout: 30000
        }

        // ponytail: `fira-admin` (`serve -s` on :3001) removed. The admin is a static
        // build; deploy.sh copies admin/dist to /var/www/fira-admin and nginx serves
        // it directly (docs/nginx-admin.conf) - no Node process to crash or hold
        // memory, and nginx already does the SPA fallback (try_files ... /index.html).

        // ponytail: `fira-client` (Next.js on :3000) removed. The client is deployed
        // to AWS Amplify (see build.sh) — running it here too booted a second, stale
        // copy of the frontend that nothing routed to.

        // ponytail: the `deploy:` block was removed. It held unedited placeholders
        // ('your-ec2-ip-or-domain.com', '/path/to/your/key.pem', 'origin/main') and
        // was never used — deployment happens by running deploy.sh on the box.
    ]
};
