// Admin view for /api/admin/abuse-report. Kept in a separate file because the
// server's Content-Security-Policy (helmet) does not allow inline scripts.
(function () {
  'use strict';

  var TOKEN_KEY = 'ofStatsAdminToken';
  var report = null;

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
    if (res.status === 401 || res.status === 403) {
      if (path.indexOf('/admin/') === 0) {
        setToken(null);
        showLogin(data.error === 'Admin access required'
          ? 'У этого аккаунта нет прав администратора (нужен email в ADMIN_EMAILS).'
          : 'Сессия закончилась, войдите снова.');
      }
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
    var r = await api('/admin/abuse-report');
    if (!r.ok) {
      if (r.status !== 401 && r.status !== 403) showLogin(r.data.error || 'Не удалось загрузить отчёт');
      return;
    }
    report = r.data;
    showReport();
    render();
  }

  function renderTiles(s) {
    var tiles = [
      ['Всего аккаунтов', s.users],
      ['Платят', s.paying],
      ['Только триал', s.trialOnly],
      ['Подозрительных групп', s.suspiciousGroups],
      ['Аккаунтов в них', s.accountsInSuspiciousGroups],
      ['Заблокировано', s.banned],
      ['С ID установки', s.withInstallId]
    ];
    var box = $('tiles');
    box.textContent = '';
    tiles.forEach(function (t) {
      box.appendChild(el('div', { className: 'tile' }, [
        el('div', { className: 'n', text: t[1] }),
        el('div', { className: 'l', text: t[0] })
      ]));
    });
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

    var head = el('div', { className: 'ghead' }, [
      el('strong', { text: group.accounts + ' аккаунт(а/ов)' }),
      el('span', { className: 'badge warn', text: 'триалов: ' + group.trials }),
      el('span', { className: 'badge ' + (group.paid ? 'good' : 'bad'), text: 'оплат: ' + group.paid }),
      group.suspicious ? el('span', { className: 'badge bad', text: 'похоже на перебор триалов' }) : null,
      el('span', { className: 'sub', text: fmtDate(group.firstSeen) + ' — ' + fmtDate(group.lastSeen), attrs: { style: 'margin:0' } })
    ]);
    box.appendChild(head);

    [traceLine('Общие модели', group.sharedModels),
     traceLine('Общая установка расширения', group.sharedInstalls),
     traceLine('Общие IP', group.sharedIps)].forEach(function (l) { if (l) box.appendChild(l); });

    var table = el('table');
    var thead = el('tr', {}, ['', 'ID', 'Email', 'Создан', 'Триал', 'Оплата', 'Моделей', 'Страна', 'Статус']
      .map(function (h) { return el('th', { text: h }); }));
    table.appendChild(el('thead', {}, [thead]));

    var tbody = el('tbody');
    group.members.forEach(function (m) {
      var cb = el('input', { attrs: { type: 'checkbox', 'data-id': m.id } });
      if (m.paid) cb.title = 'Платящий клиент';
      var status = !m.active ? 'заблокирован' : (m.flagged ? 'помечен' : 'активен');
      var row = el('tr', { className: m.active ? '' : 'banned' }, [
        el('td', {}, [cb]),
        el('td', { text: m.id }),
        el('td', { text: m.email }),
        el('td', { text: fmtDate(m.createdAt) }),
        el('td', { text: m.hadTrial ? 'да' : '—' }),
        el('td', { text: m.paid ? 'да' : '—' }),
        el('td', { text: m.models }),
        el('td', { text: m.country || '—' }),
        el('td', { text: status, attrs: m.flagged ? { title: m.flagged } : {} })
      ]);
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    box.appendChild(el('div', { className: 'scroll' }, [table]));

    var banBtn = el('button', { className: 'danger', text: 'Заблокировать отмеченных' });
    var unbanBtn = el('button', { text: 'Разблокировать отмеченных' });
    var selectAll = el('button', { text: 'Отметить неплатящих' });
    var msg = el('span', { className: 'sub', attrs: { style: 'margin:0' } });

    function selected() {
      return Array.prototype.map.call(box.querySelectorAll('input[type=checkbox]:checked'),
        function (c) { return parseInt(c.getAttribute('data-id'), 10); });
    }

    selectAll.addEventListener('click', function () {
      group.members.forEach(function (m) {
        var c = box.querySelector('input[data-id="' + m.id + '"]');
        if (c) c.checked = !m.paid;
      });
    });

    async function act(kind) {
      var ids = selected();
      if (!ids.length) { msg.textContent = 'Никто не отмечен'; return; }
      if (kind === 'ban' && !confirm('Заблокировать ' + ids.length + ' аккаунт(а/ов)? Их сессии перестанут работать сразу.')) return;
      banBtn.disabled = unbanBtn.disabled = true;
      var r = await api('/admin/users/' + kind, {
        method: 'POST',
        body: { userIds: ids, reason: 'Перебор триалов (группа из ' + group.accounts + ')' }
      });
      banBtn.disabled = unbanBtn.disabled = false;
      if (!r.ok) {
        var extra = r.data.protected ? ' — ' + r.data.protected.map(function (p) { return p.email; }).join(', ') : '';
        msg.textContent = (r.data.error || 'Ошибка') + extra;
        return;
      }
      await load();
    }
    banBtn.addEventListener('click', function () { act('ban'); });
    unbanBtn.addEventListener('click', function () { act('unban'); });

    box.appendChild(el('div', { className: 'actions' }, [selectAll, banBtn, unbanBtn, msg]));
    return box;
  }

  function render() {
    if (!report) return;
    renderTiles(report.summary);
    $('generated').textContent = 'Отчёт на ' + fmtDate(report.generatedAt);

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

    var ips = $('ips');
    ips.textContent = '';
    if (!report.busyIps.length) {
      ips.appendChild(el('div', { className: 'sub', text: 'Нет. IP начнут собираться после обновления сервера.', attrs: { style: 'margin:0' } }));
    } else {
      var t = el('table');
      t.appendChild(el('thead', {}, [el('tr', {}, ['IP', 'Аккаунтов', 'ID аккаунтов'].map(function (h) { return el('th', { text: h }); }))]));
      var tb = el('tbody');
      report.busyIps.forEach(function (row) {
        tb.appendChild(el('tr', {}, [
          el('td', { text: row.ip }), el('td', { text: row.accounts }), el('td', { text: row.userIds.join(', ') })
        ]));
      });
      t.appendChild(tb);
      ips.appendChild(el('div', { className: 'scroll' }, [t]));
    }
  }

  $('loginForm').addEventListener('submit', login);
  $('reload').addEventListener('click', load);
  $('onlySuspicious').addEventListener('change', render);

  if (getToken()) load(); else showLogin();
})();
