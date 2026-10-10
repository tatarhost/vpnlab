// Local-only helper: miniflare's workerd network stack cannot reach the H1
// panel from this machine ("Network connection lost"), while node can. This
// relays http://127.0.0.1:8788 to the panel so `wrangler dev` can still run
// the real issuance path. Not used in production — the deployed Worker talks
// to the panel directly.
//
//   node scripts/panel-relay.mjs
//   npx wrangler dev --config wrangler.toml --var PANEL_URL:http://127.0.0.1:8788
import http from 'node:http';

const TARGET = process.env.PANEL_TARGET || 'http://de13.h1cloud.net:25844';

http
  .createServer((req, res) => {
    const url = new URL(req.url || '/', TARGET);
    const upstream = http.request(
      url,
      { method: req.method, headers: { ...req.headers, host: url.host } },
      (pres) => {
        res.writeHead(pres.statusCode || 502, pres.headers);
        pres.pipe(res);
      },
    );
    upstream.on('error', (e) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'relay: ' + e.message }));
    });
    req.pipe(upstream);
  })
  .listen(8788, '127.0.0.1', () => console.log('panel relay 127.0.0.1:8788 -> ' + TARGET));
