import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const worker = (await import(pathToFileURL(join(HERE, '..', 'src', 'index.js')).href)).default;

function d1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      const call = {
        params: [],
        bind(...args) {
          call.params = args;
          return call;
        },
        first() {
          return stmt.get(...call.params) ?? null;
        },
        all() {
          return { results: stmt.all(...call.params) };
        },
        run() {
          const info = stmt.run(...call.params);
          return { success: true, meta: { changes: Number(info.changes) } };
        },
      };
      return call;
    },
  };
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(HERE, '..', 'migrations', '0001_init.sql'), 'utf8'));
  db.exec(readFileSync(join(HERE, '..', 'migrations', '0002_trials.sql'), 'utf8'));
  return db;
}

const PANEL_URL = 'http://panel.test';
const CRYPTO = 'https://pay.crypt.bot';

let cryptoState = { paid: false, invoices: true, lastPayload: null };
let coingeckoDown = false;

function paySignature(token, raw) {
  const secret = createHash('sha256').update(token).digest();
  return createHmac('sha256', secret).update(raw).digest('hex');
}

function mockFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    const J = (data, status = 200) => new Response(JSON.stringify(data), { status });

    if (u.origin === PANEL_URL) {
      if (u.pathname === '/api/inbounds') {
        return J({ inbounds: [{ id: 'ib_1', enabled: true }, { id: 'ib_2', enabled: false }] });
      }
      if (u.pathname === '/api/create') {
        assert.ok(body.days > 0);
        assert.deepEqual(body.inbound_ids, ['ib_1']);
        if (body.expires_at !== undefined) {
          assert.ok(body.expires_at > Math.floor(Date.now() / 1000), 'expires_at is a future unix timestamp');
        }
        return J({
          client: {
            inbound_links: [{ link: 'vless://a' }, { link: 'vless://b' }],
            sub_url: 'http://panel.test/sub/abc',
          },
        });
      }
      return J({ ok: false, error: 'unknown panel route ' + u.pathname }, 404);
    }

    if (u.origin === CRYPTO) {
      if (u.pathname === '/api/createInvoice') {
        assert.equal(body.asset, 'USDT');
        assert.equal(body.currency_type, 'crypto');
        assert.equal(typeof body.amount, 'string');
        assert.ok(parseFloat(body.amount) >= 1);
        assert.ok(body.payload);
        cryptoState.lastPayload = body.payload;
        return J({ ok: true, result: { invoice_id: 42, bot_invoice_url: 'https://pay.test/inv', payload: body.payload } });
      }
      if (u.pathname === '/api/getInvoices') {
        assert.ok(body.invoice_ids, 'getInvoices is queried by invoice_ids');
        if (!cryptoState.invoices) return J({ ok: true, result: [] });
        return J({ ok: true, result: [{ invoice_id: 42, payload: cryptoState.lastPayload, status: cryptoState.paid ? 'paid' : 'active' }] });
      }
      return J({ ok: false, error: { message: 'unknown crypto route' } }, 404);
    }

    if (u.origin === 'https://api.coingecko.com') {
      if (coingeckoDown) return J({ error: 'rate limited' }, 429);
      return J({ tether: { rub: 95 } });
    }

    if (u.origin === 'https://yobit.net') {
      return J({ usdt_rur: { last: 96 } });
    }

    if (u.origin === 'https://www.cbr-xml-daily.ru') {
      return J({ Valute: { USD: { Value: 90 } } });
    }

    return real(input, init);
  };
  return () => {
    globalThis.fetch = real;
  };
}

function env(db) {
  return {
    DB: d1(db),
    TARIFFS: JSON.stringify([
      { id: 'm1', label: '1 месяц', days: 30, rub: 100, old: 150 },
      { id: 'm3', label: '3 месяца', days: 90, rub: 300, old: 350 },
    ]),
    SITE_URL: 'https://tatarhost.github.io/vpnlab',
    PANEL_URL,
    PANEL_TOKEN: 'panel-secret',
    CRYPTOBOT_TOKEN: 'crypto-secret',
    SBP_PHONE: '+79048269897',
    ADMIN_TOKEN: 'admin-secret',
    ORDER_TTL: '3600',
    RATE_LIMIT: '10',
    USD_FALLBACK: '90',
    USDT_MARKUP: '1.05',
  };
}

function req(path, { method = 'GET', body, headers = {} } = {}) {
  return new Request('https://worker.test' + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('tariffs are served from the TARIFFS var', async () => {
  const restore = mockFetch();
  try {
    const res = await worker.fetch(req('/api/tariffs'), env(freshDb()));
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.tariffs.length, 2);
    assert.equal(data.tariffs[0].days, 30);
  } finally {
    restore();
  }
});

test('admin confirm delivers a pending order and public poll sees it', async () => {
  const restore = mockFetch();
  try {
    const e = env(freshDb());
    const created = await (await worker.fetch(req('/api/orders', { method: 'POST', body: { tariff: 'm3' } }), e)).json();
    assert.equal(created.order.method, 'cryptobot');
    assert.equal(created.order.status, 'pending');
    assert.match(created.order.short, /^VL-[A-F0-9]{6}$/);
    assert.equal(created.order.invoice_url, 'https://pay.test/inv');
    assert.ok(!JSON.stringify(created.order).includes('9048269897'), 'no phone anywhere in the api');

    const denied = await (await worker.fetch(req('/api/admin/confirm', { method: 'POST', body: { id: created.order.id } }), e)).json();
    assert.equal(denied.ok, false);

    const confirmed = await (await worker.fetch(req('/api/admin/confirm', { method: 'POST', body: { id: created.order.id }, headers: { 'x-admin-token': 'admin-secret' } }), e)).json();
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.order.status, 'delivered');
    assert.deepEqual(confirmed.order.links, ['vless://a', 'vless://b']);
    assert.equal(confirmed.order.sub_url, 'http://panel.test/sub/abc');

    const polled = await (await worker.fetch(req('/api/orders/' + created.order.id), e)).json();
    assert.equal(polled.order.status, 'delivered');
    assert.equal(polled.order.links.length, 2);
  } finally {
    restore();
  }
});

test('cryptobot order settles through the verified invoice status and delivers', async () => {
  const restore = mockFetch();
  try {
    cryptoState = { paid: false, invoices: true };
    const e = env(freshDb());
    const created = await (await worker.fetch(req('/api/orders', { method: 'POST', body: { tariff: 'm1', method: 'cryptobot' } }), e)).json();
    assert.equal(created.order.method, 'cryptobot');
    assert.equal(created.order.usdt, '1.11'); // 100 * 1.05 / 95 (market rate) rounded up
    assert.equal(created.order.invoice_url, 'https://pay.test/inv');

    const pending = await (await worker.fetch(req('/api/orders/' + created.order.id), e)).json();
    assert.equal(pending.order.status, 'pending');

    // An unsigned webhook must be rejected, and even a correctly signed one
    // must not mark the order paid while Crypto Pay still reports the invoice
    // as active (the worker re-verifies through the API).
    const hookBody = JSON.stringify({ update_type: 'invoice_paid', payload: { invoice_id: 42, payload: created.order.id, status: 'paid' } });
    const hookUrl = 'https://worker.test/api/webhook/cryptobot';
    const unsigned = await worker.fetch(new Request(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: hookBody }), e);
    assert.equal(unsigned.status, 401);
    const signed = await worker.fetch(new Request(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'crypto-pay-api-signature': paySignature('crypto-secret', hookBody) }, body: hookBody }), e);
    assert.equal(signed.status, 200);
    const afterHook = await (await worker.fetch(req('/api/orders/' + created.order.id), e)).json();
    assert.equal(afterHook.order.status, 'pending');

    cryptoState.paid = true;
    const settled = await (await worker.fetch(req('/api/orders/' + created.order.id), e)).json();
    assert.equal(settled.order.status, 'delivered');
    assert.deepEqual(settled.order.links, ['vless://a', 'vless://b']);
  } finally {
    restore();
  }
});

test('expired invoice expires the order', async () => {
  const restore = mockFetch();
  try {
    cryptoState = { paid: false, invoices: false }; // invoice vanished from the API
    const e = env(freshDb());
    const aged = Math.floor(Date.now() / 1000) - 7200;
    e.DB.prepare(
      'INSERT INTO orders (id, short, tariff_id, tariff_label, days, rub, method, status, usdt, invoice_id, invoice_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind('a1b2c3d4e5f60718', 'VL-ABCDEF', 'm1', '1 месяц', 30, 100, 'cryptobot', 'pending', '1.17', '42', 'https://pay.test/inv', aged, aged).run();
    const res = await (await worker.fetch(req('/api/orders/a1b2c3d4e5f60718'), e)).json();
    assert.equal(res.order.status, 'expired');
  } finally {
    restore();
  }
});

test('rate limit kicks in per ip', async () => {
  const restore = mockFetch();
  try {
    const e = env(freshDb());
    e.RATE_LIMIT = '2';
    let last;
    for (let i = 0; i < 3; i++) {
      last = await worker.fetch(req('/api/orders', { method: 'POST', body: { tariff: 'm1' } }), e);
    }
    assert.equal(last.status, 429);
  } finally {
    restore();
  }
});

test('admin list requires the token', async () => {
  const restore = mockFetch();
  try {
    const e = env(freshDb());
    assert.equal((await worker.fetch(req('/api/admin/orders'), e)).status, 401);
    const ok = await worker.fetch(req('/api/admin/orders', { headers: { 'x-admin-token': 'admin-secret' } }), e);
    assert.equal(ok.status, 200);
    const data = await ok.json();
    assert.deepEqual(data.orders, []);
  } finally {
    restore();
  }
});

test('rates use the market usdt price with 6 decimals', async () => {
  const restore = mockFetch();
  try {
    const res = await worker.fetch(req('/api/rates'), env(freshDb()));
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.rate, 95);
    assert.equal(data.source, 'coingecko');
    assert.equal(data.markup, 1.05);
    const m1 = data.samples.find((s) => s.id === 'm1');
    assert.equal(m1.usdt, '1.105263'); // 100 * 1.05 / 95
    const m3 = data.samples.find((s) => s.id === 'm3');
    assert.equal(m3.usdt, '3.315789'); // 300 * 1.05 / 95
  } finally {
    restore();
  }
});

test('rates fall back to yobit when coingecko is down', async () => {
  const restore = mockFetch();
  try {
    coingeckoDown = true;
    const data = await (await worker.fetch(req('/api/rates'), env(freshDb()))).json();
    assert.equal(data.rate, 96);
    assert.equal(data.source, 'yobit');
  } finally {
    coingeckoDown = false;
    restore();
  }
});

test('trial issues a 20 min / 1 GB client, reuses a live trial, and caps at 2', async () => {
  const restore = mockFetch();
  try {
    const e = env(freshDb());
    const first = await (await worker.fetch(req('/api/trial', { method: 'POST' }), e)).json();
    assert.equal(first.ok, true);
    assert.equal(first.trial.status, 'active');
    assert.equal(first.trial.seconds, 1200);
    assert.equal(first.trial.traffic_gb, 1);
    assert.deepEqual(first.trial.links, ['vless://a', 'vless://b']);
    assert.ok(first.trial.expires_at > Math.floor(Date.now() / 1000) + 1100);

    const again = await (await worker.fetch(req('/api/trial', { method: 'POST' }), e)).json();
    assert.equal(again.ok, true);
    assert.equal(again.reused, true);
    assert.equal(again.trial.id, first.trial.id, 'a live trial is returned, not duplicated');

    // Expire both trials in the DB; a third issue must be rejected.
    e.DB.prepare("UPDATE trials SET status = 'expired', expires_at = ?").bind(Math.floor(Date.now() / 1000) - 10).run();
    const second = await (await worker.fetch(req('/api/trial', { method: 'POST' }), e)).json();
    assert.equal(second.ok, true);
    assert.notEqual(second.trial.id, first.trial.id);
    e.DB.prepare("UPDATE trials SET status = 'expired', expires_at = ?").bind(Math.floor(Date.now() / 1000) - 10).run();
    const third = await worker.fetch(req('/api/trial', { method: 'POST' }), e);
    assert.equal(third.status, 403);
    const thirdBody = await third.json();
    assert.match(thirdBody.error, /дважды|2 раза/);

    const read = await (await worker.fetch(req('/api/trial/' + first.trial.id), e)).json();
    assert.equal(read.trial.status, 'expired');
  } finally {
    restore();
  }
});

test('trial is blocked while a paid subscription from the same ip is live', async () => {
  const restore = mockFetch();
  try {
    const e = env(freshDb());
    const created = await (await worker.fetch(req('/api/orders', { method: 'POST', body: { tariff: 'm1' } }), e)).json();
    await worker.fetch(req('/api/admin/confirm', { method: 'POST', body: { id: created.order.id }, headers: { 'x-admin-token': 'admin-secret' } }), e);

    const blocked = await worker.fetch(req('/api/trial', { method: 'POST' }), e);
    assert.equal(blocked.status, 403);
    const body = await blocked.json();
    assert.match(body.error, /платная подписка/i);
  } finally {
    restore();
  }
});
