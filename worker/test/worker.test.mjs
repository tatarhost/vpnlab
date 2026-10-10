import test from 'node:test';
import assert from 'node:assert/strict';
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
  return db;
}

const PANEL_URL = 'http://panel.test';
const CRYPTO = 'https://api.crypto.bot';

let cryptoState = { paid: false, invoices: true };

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
      if (u.pathname === '/api/newInvoice') {
        assert.equal(body.currency, 'USDT');
        assert.ok(body.amount >= 1);
        return J({ ok: true, result: { invoice_id: 42, bot_invoice_url: 'https://pay.test/inv' } });
      }
      if (u.pathname === '/api/getInvoices') {
        if (!cryptoState.invoices) return J({ ok: true, result: { items: [] } });
        return J({ ok: true, result: { items: [{ order_id: body.order_ids, status: cryptoState.paid ? 'paid' : 'active' }] } });
      }
      return J({ ok: false, error: { message: 'unknown crypto route' } }, 404);
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

test('sbp order never leaks the phone and admin confirm delivers links', async () => {
  const restore = mockFetch();
  try {
    const e = env(freshDb());
    const created = await (await worker.fetch(req('/api/orders', { method: 'POST', body: { tariff: 'm3', method: 'sbp' } }), e)).json();
    assert.equal(created.ok, true);
    assert.equal(created.order.method, 'sbp');
    assert.equal(created.order.status, 'pending');
    assert.match(created.order.short, /^VL-[A-F0-9]{6}$/);
    assert.ok(created.order.sbp.qr_svg.includes('<svg'));
    assert.equal(created.order.sbp.comment, created.order.short);
    assert.ok(!created.order.sbp.qr_svg.includes('9048269897'), 'qr svg must not contain the phone');

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
    assert.equal(created.order.usdt, '1.17'); // 100 * 1.05 / 90 rounded up
    assert.equal(created.order.invoice_url, 'https://pay.test/inv');

    const pending = await (await worker.fetch(req('/api/orders/' + created.order.id), e)).json();
    assert.equal(pending.order.status, 'pending');

    // A forged webhook with no matching paid invoice must not mark the order paid.
    const forged = await worker.fetch(req('/api/webhook/cryptobot', { method: 'POST', body: { update_type: 'invoice_paid', payload: { order_id: created.order.id } } }), e);
    assert.equal(forged.status, 200);
    const afterForged = await (await worker.fetch(req('/api/orders/' + created.order.id), e)).json();
    assert.equal(afterForged.order.status, 'pending');

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
      last = await worker.fetch(req('/api/orders', { method: 'POST', body: { tariff: 'm1', method: 'sbp' } }), e);
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

test('qr svg renders a scannable-looking matrix for the phone payload', async () => {
  const { qrcode } = await import(pathToFileURL(join(HERE, '..', 'src', 'qrcode.mjs')).href);
  const qr = qrcode(0, 'M');
  qr.addData('+79048269897');
  qr.make();
  const count = qr.getModuleCount();
  assert.ok(count >= 21, 'qr has at least version 1 size');
  assert.equal(qr.isDark(0, 0), true, 'finder pattern corner is dark');
  assert.equal(qr.isDark(0, 7), false, 'quiet separator around finder is light');
});
