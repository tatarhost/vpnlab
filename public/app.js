(() => {
  'use strict';

  const API = (document.querySelector('meta[name="vpnlab-api"]')?.content || '').replace(/\/+$/, '');
  const viewCatalog = document.getElementById('view-catalog');
  const viewOrder = document.getElementById('view-order');
  const tariffsEl = document.getElementById('tariffs');
  const backBtn = document.getElementById('back');
  const oStatus = document.getElementById('o-status');
  const oTitle = document.getElementById('o-title');
  const oSub = document.getElementById('o-sub');
  const oBody = document.getElementById('o-body');
  const trialBtn = document.getElementById('trial-btn');
  const calcRub = document.getElementById('calc-rub');
  const calcUsdt = document.getElementById('calc-usdt');
  const calcNote = document.getElementById('calc-note');
  const ratesBody = document.querySelector('#rates-table tbody');
  const usdtHint = document.getElementById('usdt-hint');

  const STATUS = {
    pending: { label: 'ожидает оплаты', cls: 'wait' },
    paid: { label: 'оплачен, выпускаем…', cls: 'ok' },
    delivering: { label: 'выпускаем доступ…', cls: 'ok' },
    delivered: { label: 'готово', cls: 'ok' },
    expired: { label: 'истёк', cls: 'bad' },
  };

  let order = null;
  let trial = null;
  let rates = null;
  let pollTimer = null;
  let tickTimer = null;
  let renderSig = '';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (rub) => esc(rub) + ' ₽';

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      headers: { 'content-type': 'application/json' },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (btn) {
      const old = btn.textContent;
      btn.textContent = '✓ скопировано';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1400);
    }
  }

  function copyRow(text, label) {
    return `<div class="copy-row"><code title="${esc(label)}">${esc(text)}</code><button class="copy-btn" data-copy="${esc(text)}" type="button">копировать</button></div>`;
  }

  // ---- payment status animation: loader spins, then draws a checkmark or a
  // cross. The element lives in the order header so polls never replay it.

  const ANIM = {
    spin: '',
    check: '<svg class="anim-svg" viewBox="0 0 52 52" aria-hidden="true"><circle class="anim-circle" cx="26" cy="26" r="24"/><path class="anim-check" fill="none" d="M15 27l8 8 15-15"/></svg>',
    cross: '<svg class="anim-svg" viewBox="0 0 52 52" aria-hidden="true"><circle class="anim-circle" cx="26" cy="26" r="24"/><path class="anim-x" fill="none" d="M18 18l16 16M34 18L18 34"/></svg>',
  };
  const STATUS_ANIM = { pending: 'spin', paid: 'spin', delivering: 'spin', delivered: 'check', expired: 'cross' };

  function setAnim(state) {
    const el = document.getElementById('o-anim');
    if (!el || el.dataset.state === state) return;
    el.dataset.state = state;
    el.hidden = false;
    el.innerHTML = ANIM[state] || '';
  }

  function resetAnim() {
    const el = document.getElementById('o-anim');
    if (el) {
      el.dataset.state = '';
      el.hidden = true;
      el.innerHTML = '';
    }
  }

  function flashError(msg) {
    const banner = document.getElementById('trial-banner');
    const host = banner ? banner.parentElement : tariffsEl.parentElement;
    const el = document.createElement('p');
    el.className = 'err';
    el.id = 'buy-error';
    el.textContent = msg;
    document.getElementById('buy-error')?.remove();
    host.insertBefore(el, banner ? banner.nextSibling : null);
    setTimeout(() => el.remove(), 6000);
  }

  // ---- catalog ----

  async function loadTariffs() {
    try {
      const data = await api('/api/tariffs');
      const list = data.tariffs || [];
      if (!list.length) throw new Error('тарифы временно недоступны');
      tariffsEl.innerHTML = list
        .map(
          (t) => `
        <article class="card">
          <div class="card-top">
            <span class="card-label">${esc(t.label)}</span>
            ${t.old ? `<span class="card-old">${money(t.old)}</span>` : ''}
          </div>
          <div class="card-price">${money(t.rub)}</div>
          <div class="card-note">безлимитный трафик · ${esc(t.days)} дней</div>
          <div class="card-buy">
            <button class="btn" data-t="${esc(t.id)}" data-m="cryptobot" type="button">Оплатить CryptoBot</button>
          </div>
        </article>`,
        )
        .join('');
      tariffsEl.querySelectorAll('button[data-t]').forEach((b) => {
        b.addEventListener('click', () => buy(b.dataset.t, b.dataset.m, b));
      });
    } catch (e) {
      tariffsEl.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
  }

  async function buy(tariffId, method, btn) {
    const buttons = tariffsEl.querySelectorAll('button[data-t]');
    buttons.forEach((b) => { b.disabled = true; });
    if (btn) btn.classList.add('loading');
    try {
      const data = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ tariff: tariffId, method }),
      });
      showOrder(data.order);
    } catch (e) {
      flashError(e.message);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
      if (btn) { btn.classList.remove('loading'); btn.blur(); }
    }
  }

  // ---- free trial ----

  async function startTrial() {
    if (trialBtn.classList.contains('loading')) return;
    trialBtn.classList.add('loading');
    trialBtn.disabled = true;
    try {
      const data = await api('/api/trial', { method: 'POST' });
      showTrial(data.trial);
    } catch (e) {
      flashError(e.message);
    } finally {
      trialBtn.classList.remove('loading');
      trialBtn.disabled = false;
    }
  }

  function fmtCountdown(s) {
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return String(m).padStart(2, '0') + '<span class="colon">:</span>' + String(ss).padStart(2, '0');
  }

  function showTrial(t) {
    trial = t;
    order = null;
    renderSig = '';
    clearTimeout(pollTimer);
    try { history.replaceState(null, '', '?t=' + t.id); } catch {}
    viewCatalog.hidden = true;
    viewOrder.hidden = false;
    resetAnim();
    renderTrial();
    startTicking();
    window.scrollTo({ top: 0 });
  }

  function startTicking() {
    clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      if (!trial) return;
      const left = Math.max(0, trial.expires_at - Math.floor(Date.now() / 1000));
      const el = document.getElementById('trial-countdown');
      if (el) el.innerHTML = fmtCountdown(left);
      if (left <= 0) {
        clearInterval(tickTimer);
        trial.status = 'expired';
        renderTrial();
      }
    }, 500);
  }

  function renderTrial() {
    const t = trial;
    const left = Math.max(0, t.expires_at - Math.floor(Date.now() / 1000));
    oStatus.textContent = t.status === 'active' ? 'пробный доступ' : 'пробный доступ истёк';
    oStatus.className = 'badge ' + (t.status === 'active' ? 'ok' : 'bad');
    oTitle.textContent = 'VPN на 20 минут · 1 ГБ';
    oSub.textContent = 'бесплатно · без оплаты';
    setAnim(t.status === 'active' ? 'check' : 'cross');

    if (t.status !== 'active') {
      oBody.innerHTML = `
        <div class="panel rise">
          <p>Пробный доступ закончился. Оформите подписку, чтобы пользоваться VPN дальше.</p>
          <div class="pay-actions"><button class="btn" id="to-catalog" type="button">Выбрать тариф</button></div>
        </div>`;
      document.getElementById('to-catalog').addEventListener('click', showCatalog);
      return;
    }

    const links = Array.isArray(t.links) ? t.links : [];
    oBody.innerHTML = `
      <div class="panel rise">
        <div class="countdown" id="trial-countdown">${fmtCountdown(left)}</div>
        <div class="trial-meta">
          <span class="trial-chip">1 ГБ трафика</span>
          <span class="trial-chip">1 устройство</span>
          <span class="trial-chip">VLESS + Reality</span>
        </div>
        <p class="pay-note">Подключайтесь по ссылке-подписке или напрямую ключами — как вам удобно.
        Пробный доступ выдаётся максимум 2 раза и недоступен, пока активна платная подписка.</p>
        ${t.sub_url ? `<p class="pay-note" style="margin-top:14px">Подписка (sub):</p>${copyRow(t.sub_url, 'ссылка подписки')}` : ''}
        ${links.length ? `<p class="pay-note" style="margin-top:14px">Прямые ссылки для клиента:</p>${links.map((l) => copyRow(l, 'ссылка vless')).join('')}` : ''}
        <div class="pay-actions"><button class="btn ghost" id="to-catalog" type="button">К тарифам</button></div>
      </div>`;
    document.getElementById('to-catalog').addEventListener('click', showCatalog);
  }

  // ---- order ----

  function showOrder(next) {
    order = next;
    trial = null;
    clearInterval(tickTimer);
    renderSig = '';
    try {
      history.replaceState(null, '', '?o=' + order.id);
    } catch {}
    viewCatalog.hidden = true;
    viewOrder.hidden = false;
    resetAnim();
    renderOrder();
    schedulePoll();
    window.scrollTo({ top: 0 });
  }

  function showCatalog() {
    clearTimeout(pollTimer);
    clearInterval(tickTimer);
    order = null;
    trial = null;
    try {
      history.replaceState(null, '', './');
    } catch {}
    viewOrder.hidden = true;
    viewCatalog.hidden = false;
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!order) return;
    if (['pending', 'paid', 'delivering'].includes(order.status)) {
      pollTimer = setTimeout(poll, 4000);
    }
  }

  async function poll() {
    if (!order) return;
    try {
      const data = await api('/api/orders/' + order.id);
      order = data.order;
      renderOrder();
    } catch {
      /* keep the last known state and try again */
    }
    schedulePoll();
  }

  function renderOrder() {
    const o = order;
    const st = STATUS[o.status] || { label: o.status, cls: '' };
    oStatus.textContent = st.label;
    oStatus.className = 'badge ' + st.cls;
    oTitle.textContent = o.tariff.label + ' · ' + money(o.rub);
    oSub.textContent = 'заказ ' + o.short;
    setAnim(STATUS_ANIM[o.status] || 'spin');

    // The poll rewrites only when something actually changed, so entrance
    // animations do not replay every four seconds.
    const sig = [o.status, o.method, (o.links || []).length, o.invoice_url ? 1 : 0, o.usdt || ''].join('|');
    if (sig === renderSig) return;
    renderSig = sig;

    if (o.status === 'delivered') {
      oBody.innerHTML = renderDelivered(o);
      return;
    }
    if (o.status === 'expired') {
      oBody.innerHTML = `
        <div class="panel rise">
          <p>Счёт больше не действует. Оплатить его нельзя — создайте новый заказ.</p>
          <div class="pay-actions"><button class="btn ghost" id="to-catalog" type="button">Выбрать тариф</button></div>
        </div>`;
      document.getElementById('to-catalog').addEventListener('click', showCatalog);
      return;
    }
    oBody.innerHTML = renderCrypto(o);
    document.getElementById('open-crypto')?.addEventListener('click', () => {
      if (o.invoice_url) window.open(o.invoice_url, '_blank', 'noopener');
    });
    document.getElementById('refresh-status')?.addEventListener('click', poll);
    document.getElementById('to-catalog')?.addEventListener('click', showCatalog);
  }

  function renderCrypto(o) {
    return `
      <div class="panel rise">
        <div class="pay-amount">${esc(o.usdt)} USDT <small>≈ ${money(o.rub)}</small></div>
        <p class="pay-note">Оплата в USDT через CryptoBot. После оплаты страница сама обновится и покажет ключи — можно просто подождать.</p>
        <div class="pay-actions">
          <button class="btn" id="open-crypto" type="button" ${o.invoice_url ? '' : 'disabled'}>Открыть счёт CryptoBot</button>
          <button class="btn ghost" id="refresh-status" type="button">Проверить статус</button>
        </div>
        <div class="status-line"><span class="spinner" aria-hidden="true"></span> статус обновляется автоматически</div>
      </div>`;
  }

  function renderDelivered(o) {
    const links = Array.isArray(o.links) ? o.links : [];
    return `
      <div class="panel rise">
        <h2 class="deliver-title">Доступ выдан</h2>
        <p class="pay-note">Подписка активна ${esc(o.days)} дней. Сохраните ссылки — по ним всегда можно получить ключи снова.</p>
        ${o.sub_url ? `<p class="pay-note" style="margin-top:14px">Подписка (sub):</p>${copyRow(o.sub_url, 'ссылка подписки')}` : ''}
        ${links.length ? `<p class="pay-note" style="margin-top:14px">Прямые ссылки для клиента:</p>${links.map((l) => copyRow(l, 'ссылка vless')).join('')}` : ''}
        <div class="pay-actions"><button class="btn ghost" id="to-catalog" type="button">К тарифам</button></div>
      </div>`;
  }

  // ---- rates / calculator / tabs ----

  async function loadRates() {
    try {
      const data = await api('/api/rates');
      rates = data;
      const samples = data.samples || [];
      ratesBody.innerHTML = samples
        .map((s) => `<tr><td>${esc(s.label)}</td><td>${money(s.rub)}</td><td>${esc(s.usdt)} USDT</td></tr>`)
        .join('');
      const first = samples.find((s) => s.id === 'm1') || samples[0];
      if (first && usdtHint) usdtHint.textContent = '≈ ' + first.usdt + ' USDT';
      updateCalc();
    } catch {
      /* the calculator keeps its placeholder */
    }
  }

  function updateCalc() {
    if (!rates) return;
    const rub = Math.max(1, parseFloat(calcRub.value) || 0);
    const markup = rates.markup || 1.05;
    const rate = rates.rate || 90;
    calcUsdt.textContent = ((rub * markup) / rate).toFixed(6);
    calcNote.textContent = 'рыночный курс USDT ≈ ' + rate + ' ₽' + (rates.source === 'cbr' ? ' (курс ЦБ, запасной)' : '');
  }

  calcRub.addEventListener('input', updateCalc);

  // ---- wiring ----

  document.getElementById('o-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (btn) copyText(btn.dataset.copy, btn);
  });

  backBtn.addEventListener('click', showCatalog);
  trialBtn.addEventListener('click', startTrial);

  const themeToggle = document.getElementById('theme-toggle');
  const themeLabel = document.getElementById('theme-label');
  function syncThemeLabel() {
    themeLabel.textContent = document.documentElement.dataset.theme === 'light' ? 'светлая' : 'тёмная';
  }
  themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('vpnlab.theme', next); } catch {}
    syncThemeLabel();
  });
  syncThemeLabel();

  loadTariffs();
  loadRates();

  const params = new URLSearchParams(location.search);
  const trialId = params.get('t');
  const orderId = params.get('o');
  if (trialId) {
    api('/api/trial/' + encodeURIComponent(trialId))
      .then((data) => showTrial(data.trial))
      .catch((e) => {
        viewCatalog.insertAdjacentHTML('afterbegin', `<p class="err" style="margin-bottom:16px">${esc(e.message)}</p>`);
      });
  } else if (orderId) {
    api('/api/orders/' + encodeURIComponent(orderId))
      .then((data) => showOrder(data.order))
      .catch((e) => {
        viewCatalog.insertAdjacentHTML('afterbegin', `<p class="err" style="margin-bottom:16px">${esc(e.message)}</p>`);
      });
  }
})();
