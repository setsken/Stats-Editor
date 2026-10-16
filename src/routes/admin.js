const express = require('express');
const { query } = require('../config/database');
const { authenticateAdmin } = require('../middleware/auth');
const {
  canonicalEmail, emailDomain, isListedDisposable, lookupMx, disposableMxMatch
} = require('../services/email-risk');

const router = express.Router();

// Everything here sits behind authenticateAdmin: a normal sign-in whose email
// is listed in ADMIN_EMAILS.
router.use(authenticateAdmin);

// Registrations closer together than this are shown as a burst.
const BURST_MINUTES = 10;

// Small union-find, used to merge accounts that share a strong trace into one
// group — most likely one person.
function makeGroups(ids) {
  const parent = new Map(ids.map(id => [id, id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const join = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, join };
}

// Map a trace value -> set of user ids that carry it.
function index(rows, key) {
  const byValue = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!value) continue;
    if (!byValue.has(value)) byValue.set(value, new Set());
    byValue.get(value).add(row.user_id);
  }
  return byValue;
}

// Is this domain a throwaway inbox? Same two layers as registration: the list,
// then the mail servers. A failed lookup is "unknown", never "disposable".
async function classifyDomains(domains) {
  const verdicts = new Map();
  const queue = [...domains];
  async function worker() {
    while (queue.length) {
      const domain = queue.shift();
      if (isListedDisposable(domain)) {
        verdicts.set(domain, { disposable: true, detail: 'домен в списке временных' });
        continue;
      }
      const mx = await lookupMx(domain);
      const hit = mx.status === 'ok' ? mx.hosts.map(disposableMxMatch).find(Boolean) : null;
      if (hit) verdicts.set(domain, { disposable: true, detail: 'почтовый сервер сети ' + hit });
      else if (mx.status === 'none') verdicts.set(domain, { disposable: true, detail: 'у домена нет почтового сервера' });
      else verdicts.set(domain, { disposable: false });
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  return verdicts;
}

// Accounts, what they share, and what looks wrong about each of them.
//
// Strong traces join accounts into one group — most likely one person:
//   - the same OnlyFans model added to the plugin
//   - the same extension installation
//   - the same mailbox under another spelling (ivan+2@gmail.com, i.van@gmail.com)
// Shared IP addresses are supporting evidence only: an agency office or a
// mobile carrier puts many honest people behind one address.
router.get('/abuse-report', async (req, res) => {
  try {
    const users = (await query(`
      SELECT u.id, u.email, u.email_canonical, u.created_at, u.is_active, u.email_verified,
             u.signup_product, u.signup_ip, u.signup_country, u.install_id, u.last_ip,
             u.last_seen_at, u.last_login_at, u.flagged_reason,
             (u.trial_used OR u.trial_started_at IS NOT NULL) AS had_trial,
             EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'completed') AS paid,
             (SELECT COUNT(*) FROM user_models m WHERE m.user_id = u.id)::int AS models
        FROM users u
       ORDER BY u.created_at
    `)).rows;

    // Deleted models count too: removing a model before opening the next
    // account does not make it a different person.
    const modelRows = (await query(`
      SELECT DISTINCT user_id, LOWER(model_username) AS value FROM user_models
    `)).rows;

    const installRows = (await query(`
      SELECT DISTINCT user_id, install_id AS value FROM auth_events WHERE install_id IS NOT NULL
      UNION
      SELECT id AS user_id, install_id AS value FROM users WHERE install_id IS NOT NULL
    `)).rows;

    const ipRows = (await query(`
      SELECT DISTINCT user_id, ip AS value FROM auth_events WHERE ip IS NOT NULL
      UNION
      SELECT id AS user_id, signup_ip AS value FROM users WHERE signup_ip IS NOT NULL
    `)).rows;

    const canonicalRows = users.map(u => ({
      user_id: u.id,
      value: u.email_canonical || canonicalEmail(u.email)
    }));

    const byModel = index(modelRows, 'value');
    const byInstall = index(installRows, 'value');
    const byIp = index(ipRows, 'value');
    const byCanonical = index(canonicalRows, 'value');

    const usersById = new Map(users.map(u => [u.id, u]));

    // ---- groups from strong traces
    const { find, join } = makeGroups(users.map(u => u.id));
    for (const ids of [...byModel.values(), ...byInstall.values(), ...byCanonical.values()]) {
      const list = [...ids];
      for (let i = 1; i < list.length; i++) join(list[0], list[i]);
    }

    const groupsByRoot = new Map();
    for (const u of users) {
      const root = find(u.id);
      if (!groupsByRoot.has(root)) groupsByRoot.set(root, []);
      groupsByRoot.get(root).push(u.id);
    }

    const shared = (byValue, ids) => {
      const out = [];
      for (const [value, owners] of byValue) {
        const inGroup = ids.filter(id => owners.has(id));
        if (inGroup.length >= 2) out.push({ value, accounts: inGroup.length });
      }
      return out.sort((a, b) => b.accounts - a.accounts);
    };

    // ---- throwaway inboxes among existing accounts
    const verdicts = await classifyDomains(new Set(users.map(u => emailDomain(u.email)).filter(Boolean)));

    // ---- per-account findings
    const tagsById = new Map(users.map(u => [u.id, []]));
    const tag = (id, key, label, detail) => tagsById.get(id).push({ key, label, detail: detail || null });

    for (const u of users) {
      const verdict = verdicts.get(emailDomain(u.email));
      if (verdict && verdict.disposable) tag(u.id, 'disposable', 'временная почта', verdict.detail);
      if (u.models === 0) tag(u.id, 'noModels', 'нет моделей');
    }

    for (const owners of byCanonical.values()) {
      if (owners.size < 2) continue;
      for (const id of owners) {
        const others = [...owners].filter(o => o !== id).map(o => '#' + o);
        tag(id, 'twin', 'тот же ящик', 'что и ' + others.join(', '));
      }
    }

    for (const owners of byIp.values()) {
      if (owners.size < 2) continue;
      for (const id of owners) {
        const others = [...owners].filter(o => o !== id).map(o => '#' + o);
        tag(id, 'sharedIp', 'общий IP', 'с ' + others.join(', '));
      }
    }

    for (let i = 1; i < users.length; i++) {
      const gapMin = (new Date(users[i].created_at) - new Date(users[i - 1].created_at)) / 60000;
      if (gapMin <= BURST_MINUTES) {
        tag(users[i].id, 'burst', 'всплеск регистраций',
          Math.max(0, Math.round(gapMin)) + ' мин после #' + users[i - 1].id);
      }
    }

    // ---- groups for display
    const clusters = [];
    for (const ids of groupsByRoot.values()) {
      if (ids.length < 2) continue;
      const members = ids.map(id => usersById.get(id));
      const paidCount = members.filter(m => m.paid).length;
      const trialCount = members.filter(m => m.had_trial).length;
      const created = members.map(m => new Date(m.created_at).getTime());
      for (const id of ids) tag(id, 'group', 'в группе', ids.length + ' акк.');
      clusters.push({
        accounts: members.length,
        trials: trialCount,
        paid: paidCount,
        // Several free trials and not a cent between them is the pattern.
        suspicious: paidCount === 0 && trialCount >= 2,
        firstSeen: new Date(Math.min(...created)).toISOString(),
        lastSeen: new Date(Math.max(...created)).toISOString(),
        sharedModels: shared(byModel, ids),
        sharedInstalls: shared(byInstall, ids),
        sharedMailboxes: shared(byCanonical, ids),
        sharedIps: shared(byIp, ids),
        memberIds: ids
      });
    }
    clusters.sort((a, b) =>
      (b.suspicious - a.suspicious) || (b.accounts - a.accounts) || (b.trials - a.trials));

    // ---- one row per account, worst first
    const WEIGHT = { disposable: 4, twin: 3, group: 2, burst: 1, sharedIp: 1, noModels: 0.5 };
    const accounts = users.map(u => {
      const tags = tagsById.get(u.id);
      const score = u.paid ? 0 : tags.reduce((s, t) => s + (WEIGHT[t.key] || 0), 0);
      return {
        id: u.id,
        email: u.email,
        createdAt: u.created_at,
        lastSeen: u.last_seen_at || u.last_login_at,
        active: u.is_active,
        verified: u.email_verified,
        paid: u.paid,
        hadTrial: u.had_trial,
        models: u.models,
        product: u.signup_product,
        country: u.signup_country,
        flagged: u.flagged_reason,
        tags,
        score
      };
    }).sort((a, b) => (b.score - a.score) || (new Date(b.createdAt) - new Date(a.createdAt)));

    const accountsById = new Map(accounts.map(a => [a.id, a]));
    for (const c of clusters) {
      c.members = c.memberIds.map(id => accountsById.get(id));
      delete c.memberIds;
    }

    // IPs carrying several accounts, with who they are.
    const busyIps = [...byIp.entries()]
      .filter(([, owners]) => owners.size >= 3)
      .map(([ip, owners]) => ({
        ip,
        accounts: owners.size,
        users: [...owners].map(id => ({ id, email: usersById.get(id)?.email || '?' }))
      }))
      .sort((a, b) => b.accounts - a.accounts);

    const has = (a, key) => a.tags.some(t => t.key === key);
    const summary = {
      users: users.length,
      verified: users.filter(u => u.email_verified).length,
      paying: users.filter(u => u.paid).length,
      trialOnly: users.filter(u => u.had_trial && !u.paid).length,
      banned: users.filter(u => !u.is_active).length,
      flagged: users.filter(u => u.flagged_reason).length,
      disposable: accounts.filter(a => has(a, 'disposable')).length,
      disposableActive: accounts.filter(a => has(a, 'disposable') && a.active && !a.paid).length,
      twins: accounts.filter(a => has(a, 'twin')).length,
      noModels: accounts.filter(a => !a.paid && has(a, 'noModels')).length,
      linkedGroups: clusters.length,
      suspiciousGroups: clusters.filter(c => c.suspicious).length,
      accountsInSuspiciousGroups: clusters.filter(c => c.suspicious).reduce((n, c) => n + c.accounts, 0),
      withInstallId: users.filter(u => u.install_id).length
    };

    res.json({ summary, accounts, clusters, busyIps, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Abuse report error:', error);
    res.status(500).json({ error: 'Could not build the report' });
  }
});

// Ban or unban accounts. A ban takes effect on the very next request:
// authenticateToken checks is_active every time, so existing sessions stop too.
async function setActive(req, res, active) {
  try {
    const ids = (Array.isArray(req.body?.userIds) ? req.body.userIds : [])
      .map(n => parseInt(n, 10))
      .filter(n => Number.isInteger(n) && n > 0);
    if (!ids.length) return res.status(400).json({ error: 'Provide userIds' });

    if (!active) {
      // Never lock out an administrator or a paying customer by accident.
      const adminEmails = (process.env.ADMIN_EMAILS || '')
        .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
      const protectedRows = (await query(`
        SELECT u.id, u.email,
               EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'completed') AS paid
          FROM users u WHERE u.id = ANY($1)
      `, [ids])).rows.filter(r => adminEmails.includes(r.email.toLowerCase()) || (r.paid && !req.body?.force));

      if (protectedRows.length) {
        return res.status(409).json({
          error: 'Some accounts are administrators or paying customers. Send force: true to ban paying customers anyway.',
          protected: protectedRows.map(r => ({ id: r.id, email: r.email, paid: r.paid }))
        });
      }
    }

    const reason = active ? null : String(req.body?.reason || 'Banned from the abuse report').slice(0, 500);
    const result = await query(
      'UPDATE users SET is_active = $1, flagged_reason = $2 WHERE id = ANY($3) RETURNING id, email',
      [active, reason, ids]
    );

    console.log(`Admin ${req.user.email} ${active ? 'unbanned' : 'banned'}:`, result.rows.map(r => r.email).join(', '));
    res.json({ updated: result.rows });
  } catch (error) {
    console.error('Ban/unban error:', error);
    res.status(500).json({ error: 'Could not update the accounts' });
  }
}

router.post('/users/ban', (req, res) => setActive(req, res, false));
router.post('/users/unban', (req, res) => setActive(req, res, true));

module.exports = router;
