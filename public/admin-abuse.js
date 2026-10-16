// Admin view for /api/admin/abuse-report. Kept in a separate file because the
// server's Content-Security-Policy (helmet) does not allow inline scripts.
(function () {
  'use strict';

  var TOKEN_KEY = 'ofStatsAdminToken';
  var report = null;

  var TAG_STYLE = {
    disposable: 'bad', twin: 'bad', group: 'warn', burst: 'warn', sharedIp: 'info', noModels: 'dim'
  };

  function $(id) { return document.getElementById(id); }

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }
  function setToken(t) {
    try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  // Every value from the server goes in through textContent — emails are
  // user-supplied and must never be parsed as markup.
  function el(tag, opts, children) {
    var node = document.createElement(tag);
    opts = opts || {};
    if (opts.className) node.className = opts.className;
    if (opts.text !== undefined && opts.text !== null) node.textContent = String(opts.text);
    if (opts.attrs) Object.keys(opts.attrs).forEach(function (k) { node.setAttribute(k, opts.attrs[k]); });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  async function api(path, options) {
    options = options || {};
    var headers = { 'Content-Type': 'application/json' };
    var token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    var res = await fetch('/api' + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if ((res.status === 401 || res.status === 403) && path.indexOf('/admin/') === 0) {
      setToken(null);
      showLogin(data.error === 'Admin access required'
        ? 'У этого аккаунта нет прав администратора (нужен email в ADMIN_EMAILS).'
        : 'Сессия закончилась, войдите снова.');
    }
    return { ok: res.ok, status: res.status, data: data };
  }

  function showLogin(message) {
    $('loginView').classList.remove('hidden');
    $('reportView').classList.add('hidden');
    $('loginError').textContent = message || '';
  }

  function showReport() {
    $('loginView').classList.add('hidden');
    $('reportView').classList.remove('hidden');
  }

  async function login(e) {
    e.preventDefault();
    $('loginError').textContent = '';
    var r = await api('/auth/login', {
      method: 'POST',
      body: { email: $('email').value.trim(), password: $('password').value }
    });
    if (!r.ok || !r.data.token) {
      $('loginError').textContent = r.data.error || 'Не удалось войти';
      return;
    }
    setToken(r.data.token);
    $('password').value = '';
    await load();
  }

  async function load() {
    $('generated').textContent = 'Загрузка…';
    var r = await api('/admin/abuse-report');
    if (!r.ok) {
      if (r.status !== 401 && r.status !== 403) showLogin(r.data.error || 'Не удалось загрузить отчёт');
      return;
    }
    report = r.data;
    showReport();
    render();
  }

  // ---- ban / unban ---------------------------------------------------------
  async function act(kind, ids, reason, msgEl) {
    if (!ids.length) { msgEl.textContent = 'Никто не отмечен'; return; }
    if (kind === 'ban' && !confirm('Заблокировать ' + ids.length + ' аккаунт(а/ов)? Их сессии перестанут работать сразу.')) return;
    msgEl.textContent = '';
    var r = await api('/admin/users/' + kind, { method: 'POST', body: { userIds: ids, reason: reason } });
    if (!r.ok) {
      var extra = r.data.protected ? ' — ' + r.data.protected.map(function (p) { return p.email; }).join(', ') : '';
      msgEl.textContent = (r.data.error || 'Ошибка') + extra;
      return;
    }
    await load();
  }

  function checkedIds(root) {
    return Array.prototype.map.call(root.querySelectorAll('input[type=checkbox][data-id]:checked'),
      function (c) { return parseInt(c.getAttribute('data-id'), 10); });
  }

  // ---- pieces --------------------------------------------------------------
  function renderTiles(s) {
    var tiles = [
      ['Всего аккаунтов', s.users],
      ['Платят', s.paying],
      ['Только триал', s.trialOnly],
      ['Временная почта', s.disposable, s.disposableActive > 0],
      ['Тот же ящик', s.twins, s.twins > 0],
      ['Без моделей (не платят)', s.noModels],
      ['Подозрительных групп', s.suspiciousGroups, s.suspiciousGroups > 0],
      ['Заблокировано', s.banned],
      ['С ID установки', s.withInstallId]
    ];
    var box = $('tiles');
    box.textContent = '';
    tiles.forEach(function (t) {
      box.appendChild(el('div', { className: 'tile' + (t[2] ? ' bad' : '') }, [
        el('div', { className: 'n', text: t[1] }),
        el('div', { className: 'l', text: t[0] })
      ]));
    });
  }

  function tagBadges(tags) {
    return tags.map(function (t) {
      return el('span', {
        className: 'badge ' + (TAG_STYLE[t.key] || 'dim'),
        text: t.label,
        attrs: t.detail ? { title: t.detail } : {}
      });
    });
  }

  function statusText(a) {
    if (!a.active) return 'заблокирован';
    if (a.flagged) return 'помечен';
    if (!a.verified) return 'не подтвердил почту';
    return 'активен';
  }

  function accountRow(a, withTags) {
    var cb = el('input', { attrs: { type: 'checkbox', 'data-id': a.id } });
    if (a.paid) cb.title = 'Платящий клиент';
    var cells = [
      el('td', {}, [cb]),
      el('td', { text: a.id }),
      el('td', { text: a.email }),
      el('td', { text: fmtDate(a.createdAt) }),
      el('td', { text: fmtDate(a.lastSeen) }),
      el('td', { text: a.paid ? 'да' : '—' }),
      el('td', { text: a.models }),
      el('td', { text: a.product === 'profile_stats' ? 'PS' : 'SE' })
    ];
    if (withTags) cells.push(el('td', { className: 'tags' }, tagBadges(a.tags)));
    cells.push(el('td', { text: statusText(a), attrs: a.flagged ? { title: a.flagged } : {} }));
    var cls = (a.active ? '' : 'banned') + (a.paid ? ' paid' : '');
    return el('tr', { className: cls.trim() }, cells);
  }

  function accountTable(rows, withTags) {
    var heads = ['', 'ID', 'Email', 'Создан', 'Последний вход', 'Оплата', 'Моделей', 'Плагин'];
    if (withTags) heads.push('Признаки');
    heads.push('Статус');
    var table = el('table');
    table.appendChild(el('thead', {}, [el('tr', {}, heads.map(function (h) { return el('th', { text: h }); }))]));
    var tbody = el('tbody');
    rows.forEach(function (a) { tbody.appendChild(accountRow(a, withTags)); });
    table.appendChild(tbody);
    return table;
  }

  function renderAccounts() {
    var onlyUnpaid = $('onlyUnpaid').checked;
    var onlyTagged = $('onlyTagged').checked;
    var hideBanned = $('hideBanned').checked;

    var rows = report.accounts.filter(function (a) {
      if (onlyUnpaid && a.paid) return false;
      if (hideBanned && !a.active) return false;
      // "No models" alone is not suspicious enough to surface by itself.
      if (onlyTagged && !a.tags.some(function (t) { return t.key !== 'noModels'; })) return false;
      return true;
    });

    var holder = $('accountsTable');
    var table = rows.length
      ? accountTable(rows, true)
      : el('div', { className: 'sub', text: 'Под эти фильтры никто не подходит.', attrs: { style: 'margin:0' } });
    holder.replaceWith(table);
    table.id = 'accountsTable';
  }

  function traceLine(label, items) {
    if (!items || !items.length) return null;
    var line = el('div', { className: 'traces' });
    line.appendChild(document.createTextNode(label + ': '));
    items.forEach(function (it, i) {
      if (i) line.appendChild(document.createTextNode(', '));
      line.appendChild(el('b', { text: it.value }));
      line.appendChild(document.createTextNode(' (' + it.accounts + ')'));
    });
    return line;
  }

  function renderGroup(group) {
    var box = el('div', { className: 'panel group' + (group.suspicious ? ' suspicious' : '') });

    box.appendChild(el('div', { className: 'ghead' }, [
      el('strong', { text: group.accounts + ' аккаунт(а/ов)' }),
      el('span', { className: 'badge warn', text: 'триалов: ' + group.trials }),
      el('span', { className: 'badge ' + (group.paid ? 'good' : 'bad'), text: 'оплат: ' + group.paid }),
      group.suspicious ? el('span', { className: 'badge bad', text: 'похоже на перебор триалов' }) : null,
      el('span', { className: 'sub', text: fmtDate(group.firstSeen) + ' — ' + fmtDate(group.lastSeen), attrs: { style: 'margin:0' } })
    ]));

    [traceLine('Общие модели', group.sharedModels),
     traceLine('Один почтовый ящик', group.sharedMailboxes),
     traceLine('Общая установка расширения', group.sharedInstalls),
     traceLine('Общие IP', group.sharedIps)].forEach(function (l) { if (l) box.appendChild(l); });

    box.appendChild(el('div', { className: 'scroll' }, [accountTable(group.members, false)]));

    var msg = el('span', { className: 'sub', attrs: { style: 'margin:0' } });
    var markUnpaid = el('button', { text: 'Отметить неплатящих' });
    var ban = el('button', { className: 'danger', text: 'Заблокировать отмеченных' });
    var unban = el('button', { text: 'Разблокировать отмеченных' });

    markUnpaid.addEventListener('click', function () {
      group.members.forEach(function (m) {
        var c = box.querySelector('input[data-id="' + m.id + '"]');
        if (c) c.checked = !m.paid;
      });
    });
    var reason = 'Перебор триалов (группа из ' + group.accounts + ')';
    ban.addEventListener('click', function () { act('ban', checkedIds(box), reason, msg); });
    unban.addEventListener('click', function () { act('unban', checkedIds(box), null, msg); });

    box.appendChild(el('div', { className: 'actions' }, [markUnpaid, ban, unban, msg]));
    return box;
  }

  function renderGroups() {
    var onlySuspicious = $('onlySuspicious').checked;
    var groups = $('groups');
    groups.textContent = '';
    var list = report.clusters.filter(function (c) { return !onlySuspicious || c.suspicious; });
    if (!list.length) {
      groups.appendChild(el('div', { className: 'panel sub', text: onlySuspicious
        ? 'Подозрительных групп нет.'
        : 'Связанных аккаунтов не найдено.' }));
    }
    list.forEach(function (c) { groups.appendChild(renderGroup(c)); });
  }

  function renderIps() {
    var ips = $('ips');
    ips.textContent = '';
    if (!report.busyIps.length) {
      ips.appendChild(el('div', { className: 'sub', text: 'Нет.', attrs: { style: 'margin:0' } }));
      return;
    }
    var t = el('table');
    t.appendChild(el('thead', {}, [el('tr', {}, ['IP', 'Аккаунтов', 'Кто'].map(function (h) { return el('th', { text: h }); }))]));
    var tb = el('tbody');
    report.busyIps.forEach(function (row) {
      tb.appendChild(el('tr', {}, [
        el('td', { text: row.ip }),
        el('td', { text: row.accounts }),
        el('td', { className: 'tags', text: row.users.map(function (u) { return '#' + u.id + ' ' + u.email; }).join(', ') })
      ]));
    });
    t.appendChild(tb);
    ips.appendChild(el('div', { className: 'scroll' }, [t]));
  }

  function render() {
    if (!report) return;
    $('generated').textContent = 'Отчёт на ' + fmtDate(report.generatedAt);
    renderTiles(report.summary);
    renderAccounts();
    renderGroups();
    renderIps();
  }

  // ---- wiring --------------------------------------------------------------
  $('loginForm').addEventListener('submit', login);
  $('reload').addEventListener('click', load);
  ['onlyUnpaid', 'onlyTagged', 'hideBanned'].forEach(function (id) { $(id).addEventListener('change', renderAccounts); });
  $('onlySuspicious').addEventListener('change', renderGroups);

  $('selectDisposable').addEventListener('click', function () {
    var table = $('accountsTable');
    report.accounts.forEach(function (a) {
      var c = table.querySelector('input[data-id="' + a.id + '"]');
      if (c) c.checked = !a.paid && a.active && a.tags.some(function (t) { return t.key === 'disposable'; });
    });
  });
  $('clearSelection').addEventListener('click', function () {
    Array.prototype.forEach.call($('accountsTable').querySelectorAll('input[type=checkbox]'), function (c) { c.checked = false; });
  });
  $('banSelected').addEventListener('click', function () {
    act('ban', checkedIds($('accountsTable')), 'Заблокирован из отчёта', $('accountsMsg'));
  });
  $('unbanSelected').addEventListener('click', function () {
    act('unban', checkedIds($('accountsTable')), null, $('accountsMsg'));
  });

  if (getToken()) load(); else showLogin();
})();
