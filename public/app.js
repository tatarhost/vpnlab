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

  const STATUS = {
    pending: { label: 'ожидает оплаты', cls: '' },
    paid: { label: 'оплачен, выпускаем…', cls: 'ok' },
    delivering: { label: 'выпускаем доступ…', cls: 'ok' },
    delivered: { label: 'готово', cls: 'ok' },
    expired: { label: 'истёк', cls: 'bad' },
  };

  let order = null;
  let pollTimer = null;

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
      btn.textContent = 'скопировано';
      setTimeout(() => { btn.textContent = old; }, 1400);
    }
  }

  function copyRow(text, label) {
    return `<div class="copy-row"><code title="${esc(label)}">${esc(text)}</code><button class="copy-btn" data-copy="${esc(text)}" type="button">копировать</button></div>`;
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
            <button class="btn" data-t="${esc(t.id)}" data-m="cryptobot" type="button">CryptoBot</button>
            <button class="btn ghost" data-t="${esc(t.id)}" data-m="sbp" type="button">СБП</button>
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
    try {
      const data = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ tariff: tariffId, method }),
      });
      showOrder(data.order);
    } catch (e) {
      tariffsEl.insertAdjacentHTML('afterend', `<p class="err" id="buy-error">${esc(e.message)}</p>`);
      setTimeout(() => document.getElementById('buy-error')?.remove(), 5000);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
      if (btn) btn.blur();
    }
  }

  // ---- order ----

  function showOrder(next) {
    order = next;
    try {
      history.replaceState(null, '', '?o=' + order.id);
    } catch {}
    viewCatalog.hidden = true;
    viewOrder.hidden = false;
    renderOrder();
    schedulePoll();
    window.scrollTo({ top: 0 });
  }

  function showCatalog() {
    clearTimeout(pollTimer);
    order = null;
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

    if (o.status === 'delivered') {
      oBody.innerHTML = renderDelivered(o);
      return;
    }
    if (o.status === 'expired') {
      oBody.innerHTML = `
        <div class="panel">
          <p>Счёт больше не действует. Оплатить его нельзя — создайте новый заказ.</p>
          <div class="pay-actions"><button class="btn ghost" id="to-catalog" type="button">Выбрать тариф</button></div>
        </div>`;
      document.getElementById('to-catalog').addEventListener('click', showCatalog);
      return;
    }
    if (o.method === 'sbp') {
      oBody.innerHTML = renderSbp(o);
      return;
    }
    oBody.innerHTML = renderCrypto(o);
    document.getElementById('open-crypto')?.addEventListener('click', () => {
      if (o.invoice_url) window.open(o.invoice_url, '_blank', 'noopener');
    });
    document.getElementById('refresh-status')?.addEventListener('click', poll);
  }

  function renderCrypto(o) {
    return `
      <div class="panel">
        <div class="pay-amount">${esc(o.usdt)} USDT <small>≈ ${money(o.rub)}</small></div>
        <p class="pay-note">Оплата в USDT через CryptoBot. После оплаты страница сама обновится и покажет ключи.</p>
        <div class="pay-actions">
          <button class="btn" id="open-crypto" type="button" ${o.invoice_url ? '' : 'disabled'}>Открыть счет CryptoBot</button>
          <button class="btn ghost" id="refresh-status" type="button">Проверить статус</button>
        </div>
        <div class="status-line"><span class="spinner" aria-hidden="true"></span> статус обновляется автоматически</div>
      </div>`;
  }

  function renderSbp(o) {
    const sbp = o.sbp || {};
    return `
      <div class="panel">
        <div class="pay-amount">${money(o.rub)}</div>
        <p class="pay-note">Отсканируйте QR камерой приложения банка. Номер получателя на сайте не отображается.</p>
        ${sbp.qr_svg ? `<div class="qr">${sbp.qr_svg}</div>` : ''}
        <p class="pay-note">Сумма: <b>${money(o.rub)}</b> · комментарий к переводу:</p>
        ${copyRow(sbp.comment || o.short, 'комментарий')}
        <div class="pay-actions">
          <button class="btn ghost" id="refresh-status" type="button">Проверить статус</button>
        </div>
        <div class="status-line"><span class="spinner" aria-hidden="true"></span> подтверждение платежа обычно занимает пару минут</div>
      </div>`;
  }

  function renderDelivered(o) {
    const links = Array.isArray(o.links) ? o.links : [];
    return `
      <div class="panel">
        <h2 class="deliver-title">Доступ выдан</h2>
        <p class="pay-note">Подписка активна ${esc(o.days)} дней. Сохраните ссылки — по ним всегда можно получить ключи снова.</p>
        ${o.sub_url ? `<p class="pay-note" style="margin-top:14px">Подписка (sub):</p>${copyRow(o.sub_url, 'ссылка подписки')}` : ''}
        ${links.length ? `<p class="pay-note" style="margin-top:14px">Прямые ссылки для клиента:</p>${links.map((l) => copyRow(l, 'ссылка vless')).join('')}` : ''}
        <div class="pay-actions"><button class="btn ghost" id="to-catalog" type="button">К тарифам</button></div>
      </div>`;
  }

  // ---- wiring ----

  document.getElementById('o-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (btn) copyText(btn.dataset.copy, btn);
  });

  backBtn.addEventListener('click', showCatalog);

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

  const orderId = new URLSearchParams(location.search).get('o');
  if (orderId) {
    api('/api/orders/' + encodeURIComponent(orderId))
      .then((data) => showOrder(data.order))
      .catch((e) => {
        viewCatalog.insertAdjacentHTML('afterbegin', `<p class="err" style="margin-bottom:16px">${esc(e.message)}</p>`);
      });
  }
})();
