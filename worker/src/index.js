const TEXT = { 'content-type': 'application/json; charset=utf-8' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: TEXT });
}

function fail(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '*';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type,x-admin-token',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  };
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function randHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function parseJson(s, fallback = null) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function tariffs(env) {
  const list = parseJson(env.TARIFFS, []);
  return Array.isArray(list) ? list : [];
}

async function hashKey(env, ip) {
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function kvGet(env, key) {
  const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first();
  return row ? parseJson(row.value, null) : null;
}

async function kvSet(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).bind(key, JSON.stringify(value), now()).run();
}

async function rateLimited(env, ip, limitOverride, prefix = 'rl') {
  const limit = limitOverride || parseInt(env.RATE_LIMIT || '10', 10);
  const windowMs = 3600 * 1000;
  const key = prefix + ':' + (await hashKey(env, ip));
  const state = await kvGet(env, key);
  const ts = Date.now();
  let count = 1;
  let started = ts;
  if (state && typeof state === 'object') {
    if (ts - state.ts < windowMs) {
      count = state.count + 1;
      started = state.ts;
    }
  }
  await kvSet(env, key, { count, ts: started });
  return count <= limit;
}

async function panel(env, method, path, body) {
  let res;
  try {
    res = await fetch(env.PANEL_URL + path, {
      method,
      headers: { authorization: 'Bearer ' + env.PANEL_TOKEN, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { ok: false, error: 'panel unreachable: ' + (e && e.message ? e.message : e) };
  }
  const text = await res.text();
  const data = parseJson(text, null);
  if (!res.ok) return { ok: false, error: 'panel HTTP ' + res.status + ': ' + text.slice(0, 300) };
  if (data && data.ok === false) return { ok: false, error: data.error || data.message || text.slice(0, 300) };
  return { ok: true, data };
}

async function enabledInboundIds(env) {
  const res = await panel(env, 'GET', '/api/inbounds');
  if (!res.ok) throw new Error(res.error);
  const data = res.data;
  const list = Array.isArray(data) ? data : data.inbounds || data.data || [];
  const ids = list.filter((i) => i && i.enabled !== false && i.id).map((i) => i.id);
  if (!ids.length) throw new Error('no enabled inbounds on panel');
  return ids;
}

function cryptoBotBases(env) {
  const bases = [];
  if (env.CRYPTOBOT_API) bases.push(env.CRYPTOBOT_API.replace(/\/+$/, ''));
  const doc = 'https://pay.crypt.bot/api';
  if (!bases.includes(doc)) bases.push(doc);
  return bases;
}

async function cryptoBot(env, method, params = {}) {
  const errors = [];
  for (const base of cryptoBotBases(env)) {
    let res;
    try {
      res = await fetch(base + '/' + method, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'crypto-pay-api-token': env.CRYPTOBOT_TOKEN || '',
          accept: 'application/json',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      errors.push(base + ' unreachable: ' + (e && e.message ? e.message : e));
      continue;
    }
    if (res.status >= 520 && res.status <= 526) {
      const body = await res.text().catch(() => '');
      errors.push(base + ' HTTP ' + res.status + ': ' + body.slice(0, 200));
      continue;
    }
    const text = await res.text();
    const data = parseJson(text, null);
    if (!data) {
      errors.push(base + ': non-JSON HTTP ' + res.status + ': ' + text.slice(0, 160));
      continue;
    }
    if (!data.ok) {
      return { ok: false, error: (data.error && (data.error.message || data.error.code)) || base + ' error' };
    }
    return { ok: true, result: data.result };
  }
  return { ok: false, error: errors.join(' | ') || 'crypto.bot: no endpoint answered' };
}

// The price a buyer actually pays for USDT on the market, not the official
// CBR rate — they diverge by several percent and the invoice has to match what
// an exchange really charges. Several public sources, CBR only as a fallback.
const MARKET_SOURCES = [
  {
    name: 'coingecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=rub',
    pick: (d) => d && d.tether && d.tether.rub,
  },
  {
    name: 'yobit',
    url: 'https://yobit.net/api/3/ticker/usdt_rur',
    pick: (d) => d && d.usdt_rur && d.usdt_rur.last,
  },
];

async function usdtRate(env) {
  const cached = await kvGet(env, 'usdt_rate');
  if (cached && typeof cached === 'object' && Date.now() - cached.ts < 3600 * 1000) return cached;
  const errors = [];
  for (const src of MARKET_SOURCES) {
    try {
      const res = await fetch(src.url, {
        headers: { accept: 'application/json', 'user-agent': 'vpnlab/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text();
      const rate = src.pick(parseJson(text, null));
      if (rate && isFinite(rate) && rate > 0) {
        const out = { rate, source: src.name, ts: Date.now() };
        await kvSet(env, 'usdt_rate', out);
        return out;
      }
      errors.push(src.name + ': http ' + res.status + ' ' + text.slice(0, 100));
    } catch (e) {
      errors.push(src.name + ': ' + (e && e.message ? e.message : e));
    }
  }
  const cbr = await kvGet(env, 'usd_rate');
  if (cbr && typeof cbr === 'object' && Date.now() - cbr.ts < 12 * 3600 * 1000) {
    return { rate: cbr.rate, source: 'cbr', ts: Date.now(), errors };
  }
  try {
    const res = await fetch('https://www.cbr-xml-daily.ru/daily_json.js', { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const rate = data && data.Valute && data.Valute.USD && data.Valute.USD.Value;
    if (rate) {
      await kvSet(env, 'usd_rate', { rate, ts: Date.now() });
      return { rate, source: 'cbr', ts: Date.now(), errors };
    }
  } catch (e) {
    errors.push('cbr: ' + (e && e.message ? e.message : e));
  }
  return { rate: parseFloat(env.USD_FALLBACK || '90'), source: 'fallback', ts: 0, errors };
}

function usdtExact(rub, rate, markup) {
  return Math.max((rub * markup) / rate, 0).toFixed(6);
}

async function usdtAmount(env, rub) {
  const { rate } = await usdtRate(env);
  const markup = parseFloat(env.USDT_MARKUP || '1.05');
  const usdt = Math.ceil(((rub * markup) / rate) * 100) / 100;
  return Math.max(usdt, 1).toFixed(2);
}

function publicOrder(env, o) {
  const out = {
    id: o.id,
    short: o.short,
    status: o.status,
    method: o.method,
    rub: o.rub,
    usdt: o.usdt,
    days: o.days,
    tariff: { id: o.tariff_id, label: o.tariff_label },
    created_at: o.created_at,
  };
  if (o.status === 'pending') out.invoice_url = o.invoice_url;
  if (o.status === 'delivered') {
    out.sub_url = o.sub_url || null;
    out.links = parseJson(o.links, []);
  }
  return out;
}

async function getOrder(env, id) {
  if (!/^[a-f0-9]{16,64}$/.test(id || '')) return null;
  return env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
}

async function markPaid(env, id) {
  await env.DB.prepare("UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now(), id).run();
}

async function markExpired(env, id) {
  await env.DB.prepare("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now(), id).run();
}

async function deliver(env, order) {
  if (order.status === 'delivered' && (order.sub_url || order.links)) return order;
  const stale = now() - (order.updated_at || 0) > 60 ? 1 : 0;
  const claim = await env.DB.prepare(
    "UPDATE orders SET status = 'delivering', updated_at = ? WHERE id = ? AND (status = 'paid' OR (status = 'delivering' AND ?))",
  ).bind(now(), order.id, stale).run();
  const changed = claim && claim.meta && claim.meta.changes;
  if (!changed) return (await getOrder(env, order.id)) || order;
  try {
    const ids = await enabledInboundIds(env);
    const name = 'vl_' + order.short.slice(3).toLowerCase() + order.id.slice(0, 4);
    const res = await panel(env, 'POST', '/api/create', {
      name,
      days: order.days,
      traffic_limit_gb: 0,
      device_limit: 0,
      manual: true,
      channels: [],
      inbound_ids: ids,
    });
    if (!res.ok) throw new Error(res.error);
    const client = res.data.client || res.data;
    const links = (client.inbound_links || []).map((l) => l.link).filter(Boolean);
    const sub = client.sub_url || null;
    if (!links.length && !sub) throw new Error('panel returned no links');
    await env.DB.prepare(
      "UPDATE orders SET status = 'delivered', client_name = ?, sub_url = ?, links = ?, updated_at = ? WHERE id = ?",
    ).bind(name, sub, JSON.stringify(links), now(), order.id).run();
    return await getOrder(env, order.id);
  } catch (e) {
    await env.DB.prepare("UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ? AND status = 'delivering'").bind(now(), order.id).run();
    throw e;
  }
}

async function invoiceInfo(env, order) {
  const params = order.invoice_id ? { invoice_ids: String(order.invoice_id), count: 1 } : { count: 100 };
  const res = await cryptoBot(env, 'getInvoices', params);
  if (!res.ok) return undefined;
  const result = res.result;
  const items = Array.isArray(result) ? result : (result && result.items) || [];
  return items.find((i) => i && (String(i.payload || '') === order.id || String(i.invoice_id) === String(order.invoice_id))) || null;
}

// Crypto Pay signs the raw request body with HMAC-SHA-256 whose key is the
// SHA-256 of the app token; the hex digest arrives in crypto-pay-api-signature.
async function verifyPaySignature(token, rawBody, signature) {
  if (!token || !rawBody || !signature) return false;
  const enc = new TextEncoder();
  const secret = await crypto.subtle.digest('SHA-256', enc.encode(token));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const given = String(signature).trim().toLowerCase();
  if (hex.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function settle(env, order) {
  let current = order;
  if (current.status !== 'pending' || current.method !== 'cryptobot') return current;
  const ttl = parseInt(env.ORDER_TTL || '3600', 10);
  let inv;
  try {
    inv = await invoiceInfo(env, current);
  } catch {
    inv = undefined;
  }
  if (inv && inv.status === 'paid') {
    await markPaid(env, current.id);
  } else if (inv && (inv.status === 'expired' || inv.status === 'cancelled')) {
    await markExpired(env, current.id);
  } else if (inv === null && current.created_at + ttl < now()) {
    await markExpired(env, current.id);
  }
  return (await getOrder(env, current.id)) || current;
}

function clientIp(req) {
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'local';
}

async function createOrder(env, req, body) {
  const tariff = tariffs(env).find((t) => t.id === (body && body.tariff));
  if (!tariff) return fail('Тариф не найден', 404);
  const method = 'cryptobot';
  const ip = clientIp(req);
  if (!(await rateLimited(env, ip))) return fail('Слишком много запросов, попробуйте позже', 429);

  const id = randHex(16);
  const short = 'VL-' + randHex(3).toUpperCase();
  const order = {
    id,
    short,
    tariff_id: tariff.id,
    tariff_label: tariff.label,
    days: tariff.days,
    rub: tariff.rub,
    method,
    status: 'pending',
    usdt: null,
    invoice_id: null,
    invoice_url: null,
    client_name: null,
    sub_url: null,
    links: null,
    created_at: now(),
    updated_at: now(),
  };

  if (method === 'cryptobot') {
    if (!env.CRYPTOBOT_TOKEN) return fail('Оплата временно недоступна', 503);
    order.usdt = await usdtAmount(env, tariff.rub);
    const site = (env.SITE_URL || '').replace(/\/+$/, '');
    const orderUrl = site + '/?o=' + id;
    const inv = await cryptoBot(env, 'createInvoice', {
      currency_type: 'crypto',
      asset: 'USDT',
      amount: order.usdt,
      description: 'VPNLAB ' + tariff.label + ' · заказ ' + short,
      payload: id,
      paid_btn_name: 'callback',
      paid_btn_url: orderUrl,
      hidden_message: 'Заказ ' + short + ' на сайте VPNLAB. Вернитесь на страницу заказа, чтобы получить ключи.',
      expires_in: parseInt(env.ORDER_TTL || '3600', 10),
    });
    if (!inv.ok) return fail('Не удалось создать счёт: ' + inv.error, 502);
    const invoice = inv.result || {};
    order.invoice_id = String(invoice.invoice_id || invoice.id || '');
    order.invoice_url = invoice.bot_invoice_url || invoice.web_app_invoice_url || invoice.mini_app_invoice_url || invoice.pay_url || null;
    if (!order.invoice_url) return fail('Crypto Pay не вернул ссылку на оплату', 502);
  }

  const ipHash = await hashKey(env, ip);
  await env.DB.prepare(
    'INSERT INTO orders (id, short, tariff_id, tariff_label, days, rub, method, status, usdt, invoice_id, invoice_url, client_name, sub_url, links, created_at, updated_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(order.id, order.short, order.tariff_id, order.tariff_label, order.days, order.rub, order.method, order.status, order.usdt, order.invoice_id, order.invoice_url, order.client_name, order.sub_url, order.links, order.created_at, order.updated_at, ipHash)
    .run();

  return json({ ok: true, order: publicOrder(env, order) });
}

async function readOrder(env, id) {
  let order = await getOrder(env, id);
  if (!order) return fail('Заказ не найден', 404);
  order = await settle(env, order);
  if (order.status === 'paid' || (order.status === 'delivering' && now() - (order.updated_at || 0) > 60)) {
    try {
      order = await deliver(env, order);
    } catch {
      /* stays 'paid', the next poll retries */
    }
  }
  return json({ ok: true, order: publicOrder(env, order) });
}

// Free trial: 20 minutes / 1 GB, issued at most TRIAL_MAX times per IP within
// TRIAL_WINDOW_DAYS, and never while a paid subscription delivered to the same
// IP is still running. The panel enforces the exact expiry through expires_at.
const TRIAL_SECONDS = 1200;
const TRIAL_GB = 1;

async function ratesPayload(env) {
  const { rate, source } = await usdtRate(env);
  const markup = parseFloat(env.USDT_MARKUP || '1.05');
  const samples = tariffs(env).map((t) => ({
    id: t.id,
    label: t.label,
    days: t.days,
    rub: t.rub,
    usdt: usdtExact(t.rub, rate, markup),
  }));
  return { rate, source, markup, samples };
}

function publicTrial(row) {
  const t = now();
  return {
    id: row.id,
    status: row.expires_at > t ? 'active' : 'expired',
    expires_at: row.expires_at,
    seconds: Math.max(0, row.expires_at - t),
    traffic_gb: TRIAL_GB,
    sub_url: row.sub_url || null,
    links: parseJson(row.links, []),
  };
}

async function createTrial(env, req) {
  const ip = clientIp(req);
  const ipHash = await hashKey(env, ip);
  const t = now();
  const max = parseInt(env.TRIAL_MAX || '2', 10);
  const windowDays = parseInt(env.TRIAL_WINDOW_DAYS || '30', 10);

  if (!(await rateLimited(env, ip, parseInt(env.TRIAL_RATE_LIMIT || '5', 10), 'rlt'))) {
    return fail('Слишком много попыток, попробуйте позже', 429);
  }

  const active = await env.DB.prepare(
    "SELECT id, short, created_at, days FROM orders WHERE ip_hash = ? AND status = 'delivered' AND created_at + days * 86400 > ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(ipHash, t)
    .first();
  if (active) {
    const until = new Date((active.created_at + active.days * 86400) * 1000).toLocaleDateString('ru-RU');
    return fail('Платная подписка действует до ' + until + ' — бесплатный доступ недоступен, пока она активна', 403);
  }

  const live = await env.DB.prepare(
    "SELECT * FROM trials WHERE ip_hash = ? AND status = 'active' AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(ipHash, t)
    .first();
  if (live) return json({ ok: true, trial: publicTrial(live), reused: true });

  const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM trials WHERE ip_hash = ? AND created_at > ?')
    .bind(ipHash, t - windowDays * 86400)
    .first();
  if (used && used.n >= max) {
    return fail('Бесплатный пробный доступ уже выдавался ' + max + ' раза. Оформите подписку, чтобы пользоваться VPN дальше.', 403);
  }

  const id = randHex(16);
  const name = 'tr_' + randHex(5);
  const expiresAt = t + TRIAL_SECONDS;
  let links = [];
  let sub = null;
  try {
    const ids = await enabledInboundIds(env);
    const res = await panel(env, 'POST', '/api/create', {
      name,
      days: 1,
      expires_at: expiresAt,
      traffic_limit_gb: TRIAL_GB,
      device_limit: 1,
      manual: true,
      channels: [],
      inbound_ids: ids,
    });
    if (!res.ok) throw new Error(res.error);
    const client = res.data.client || res.data;
    links = (client.inbound_links || []).map((l) => l.link).filter(Boolean);
    sub = client.sub_url || null;
    if (!links.length && !sub) throw new Error('panel returned no links');
  } catch (e) {
    return fail('Не удалось выдать пробный доступ: ' + (e && e.message ? e.message : e), 502);
  }

  await env.DB.prepare('INSERT INTO trials (id, ip_hash, client_name, sub_url, links, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, ipHash, name, sub, JSON.stringify(links), t, expiresAt, 'active')
    .run();

  return json({ ok: true, trial: { id, status: 'active', expires_at: expiresAt, seconds: TRIAL_SECONDS, traffic_gb: TRIAL_GB, sub_url: sub, links } });
}

async function readTrial(env, id) {
  if (!/^[a-f0-9]{16,64}$/.test(id || '')) return fail('Пробный доступ не найден', 404);
  const row = await env.DB.prepare('SELECT * FROM trials WHERE id = ?').bind(id).first();
  if (!row) return fail('Пробный доступ не найден', 404);
  if (row.status === 'active' && row.expires_at <= now()) {
    await env.DB.prepare("UPDATE trials SET status = 'expired' WHERE id = ?").bind(id).run();
    row.status = 'expired';
  }
  return json({ ok: true, trial: publicTrial(row) });
}

function adminAuth(req, env) {
  if (!env.ADMIN_TOKEN) return { status: 503, message: 'admin token is not configured' };
  if ((req.headers.get('x-admin-token') || '') !== env.ADMIN_TOKEN) return { status: 401, message: 'unauthorized' };
  return null;
}

async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (!path.startsWith('/api/')) return fail('not found', 404);

  if (req.method === 'GET' && path === '/api/health') {
    return json({
      ok: true,
      tariffs: tariffs(env).length > 0,
      cryptobot: !!env.CRYPTOBOT_TOKEN,
      panel: !!env.PANEL_TOKEN,
      admin: !!env.ADMIN_TOKEN,
    });
  }

  if (req.method === 'GET' && path === '/api/tariffs') {
    return json({ ok: true, tariffs: tariffs(env) });
  }

  if (req.method === 'GET' && path === '/api/rates') {
    return json({ ok: true, ...(await ratesPayload(env)) });
  }

  if (req.method === 'POST' && path === '/api/trial') {
    return createTrial(env, req);
  }

  if (req.method === 'GET' && path.startsWith('/api/trial/')) {
    return readTrial(env, path.slice('/api/trial/'.length));
  }

  if (req.method === 'POST' && path === '/api/orders') {
    const body = await req.json().catch(() => null);
    if (!body) return fail('bad json');
    return createOrder(env, req, body);
  }

  if (req.method === 'GET' && path.startsWith('/api/orders/')) {
    return readOrder(env, path.slice('/api/orders/'.length));
  }

  if (req.method === 'POST' && path === '/api/webhook/cryptobot') {
    const raw = await req.text().catch(() => '');
    const valid = await verifyPaySignature(env.CRYPTOBOT_TOKEN, raw, req.headers.get('crypto-pay-api-signature'));
    if (!valid) return fail('bad signature', 401);
    const body = parseJson(raw, null);
    if (body && body.update_type === 'invoice_paid') {
      const invoice = (body.payload || {}) || {};
      const orderId = invoice.payload;
      if (orderId) {
        const order = await getOrder(env, orderId);
        if (order && order.status === 'pending' && order.method === 'cryptobot') {
          const settled = await settle(env, order);
          if (settled.status === 'paid') {
            try {
              await deliver(env, settled);
            } catch {}
          }
        }
      }
    }
    return json({ ok: true });
  }

  if (path.startsWith('/api/admin/')) {
    const denied = adminAuth(req, env);
    if (denied) return fail(denied.message, denied.status);

    if (req.method === 'GET' && path === '/api/admin/orders') {
      const rows = await env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all();
      const trials = await env.DB.prepare('SELECT * FROM trials ORDER BY created_at DESC LIMIT 100').all();
      return json({ ok: true, orders: rows.results || [], trials: trials.results || [] });
    }

    if (req.method === 'POST' && path === '/api/admin/confirm') {
      const body = await req.json().catch(() => null);
      const order = await getOrder(env, body && body.id);
      if (!order) return fail('Заказ не найден', 404);
      if (order.status === 'pending') await markPaid(env, order.id);
      let current = (await getOrder(env, order.id)) || order;
      if (current.status === 'paid') {
        try {
          current = await deliver(env, current);
        } catch (e) {
          return fail('Ошибка выпуска: ' + (e && e.message ? e.message : e), 502);
        }
      }
      return json({ ok: true, order: publicOrder(env, current) });
    }

    return fail('not found', 404);
  }

  return fail('not found', 404);
}

export default {
  async fetch(req, env) {
    const extra = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: extra });
    let resp;
    try {
      resp = await handle(req, env);
    } catch (e) {
      resp = fail('internal error: ' + (e && e.message ? e.message : e), 500);
    }
    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return new Response(resp.body, { status: resp.status, headers });
  },
};
