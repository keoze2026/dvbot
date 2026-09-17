// PM2 process file. Start with:  pm2 start ecosystem.config.js
//
// The file name matters: PM2 only treats *.config.js (or .json/.yml) as a
// process file. `pm2 start ecosystem.js` would try to *run* ecosystem.js as
// the app itself.
//
// Secrets stay in .env - index.ts loads it via dotenv on boot - so nothing
// sensitive lives in here and this file is safe to commit.
module.exports = {
  apps: [
    {
      name: "dvnet-bot",
      script: "dist/index.js",
      cwd: __dirname,

      // Long polling holds one getUpdates connection to Telegram. Two copies
      // of the bot would fight over it, so this must stay a single fork.
      instances: 1,
      exec_mode: "fork",

      // Restart on crash, with backoff so a bad .env or a Telegram outage does
      // not turn into a tight restart loop. The bot's own /stop only pauses
      // request handling; it never exits, so PM2 never restarts it for that.
      autorestart: true,
      exp_backoff_restart_delay: 1000, // 1s, 2s, 4s ... capped by PM2 at 15s
      max_restarts: 50,
      min_uptime: "10s",
      max_memory_restart: "300M",

      // Give bot.stop() time to finish the in-flight getUpdates call on
      // `pm2 restart` / `pm2 stop` before PM2 sends SIGKILL.
      kill_timeout: 10_000,

      watch: false,

      // Timestamp every log line; keep one file per stream.
      time: true,
      merge_logs: true,
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",

      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
