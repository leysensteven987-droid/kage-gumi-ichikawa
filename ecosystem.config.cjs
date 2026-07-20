// PM2 process file for the box.
//
// Serves the built kawaii-bento UI + recipe API on one port (5273). Expose it via a
// Cloudflare Tunnel ingress:  ichikawa.kage-gumi.com  ->  localhost:5273
//
// Before `pm2 start ecosystem.config.cjs`, build the UI once (and after each update):
//   npm ci && npm run build
module.exports = {
  apps: [
    {
      name: "kage-gumi-ichikawa",
      script: "server/index.js",
      cwd: __dirname,
      env: {
        ICHIKAWA_PORT: 5273,
      },
      autorestart: true,
    },
  ],
};
