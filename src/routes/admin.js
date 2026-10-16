const express = require('express');
const { query } = require('../config/database');
const { authenticateAdmin } = require('../middleware/auth');

const router = express.Router();

// Everything here sits behind authenticateAdmin: a normal sign-in whose email
// is listed in ADMIN_EMAILS.
router.use(authenticateAdmin);

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

// Accounts grouped by what they share.
//
// Strong traces join accounts into one group:
//   - the same OnlyFans model added to the plugin (the plugin is used for
//     working models, so this is what a trial-cycler cannot avoid)
//   - the same extension installation
// Shared IP addresses are listed as supporting evidence only — an agency
// office or a mobile carrier puts many honest people behind one address.
router.get('/abuse-report', async (req, res) => {
  try {
    const users = (await query(`
      SELECT u.id, u.email, u.created_at, u.is_active, u.email_verified, u.signup_product,
             u.signup_ip, u.signup_country, u.install_id, u.last_ip, u.last_seen_at,
             u.flagged_reason,
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

    const byModel = index(modelRows, 'value');
    const byInstall = index(installRows, 'value');
    const byIp = index(ipRows, 'value');

    const { find, join } = makeGroups(users.map(u => u.id));
    for (const ids of [...byModel.values(), ...byInstall.values()]) {
      const list = [...ids];
      for (let i = 1; i < list.length; i++) join(list[0], list[i]);
    }

    const usersById = new Map(users.map(u => [u.id, u]));
    const groups = new Map();
    for (const u of users) {
      const root = find(u.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(u.id);
    }

    const shared = (byValue, ids) => {
      const out = [];
      for (const [value, owners] of byValue) {
        const inGroup = ids.filter(id => owners.has(id));
        if (inGroup.length >= 2) out.push({ value, accounts: inGroup.length });
      }
      return out.sort((a, b) => b.accounts - a.accounts);
    };

    const clusters = [];
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      const members = ids.map(id => usersById.get(id));
      const paidCount = members.filter(m => m.paid).length;
      const trialCount = members.filter(m => m.had_trial).length;
      const created = members.map(m => new Date(m.created_at).getTime());
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
        sharedIps: shared(byIp, ids),
        members: members.map(m => ({
          id: m.id, email: m.email, createdAt: m.created_at, active: m.is_active,
          verified: m.email_verified, paid: m.paid, hadTrial: m.had_trial,
          models: m.models, country: m.signup_country, flagged: m.flagged_reason
        }))
      });
    }

    clusters.sort((a, b) =>
      (b.suspicious - a.suspicious) || (b.accounts - a.accounts) || (b.trials - a.trials));

    // IPs carrying several accounts, whether or not anything stronger links them.
    const busyIps = [...byIp.entries()]
      .filter(([, owners]) => owners.size >= 3)
      .map(([ip, owners]) => ({ ip, accounts: owners.size, userIds: [...owners] }))
      .sort((a, b) => b.accounts - a.accounts);

    const summary = {
      users: users.length,
      verified: users.filter(u => u.email_verified).length,
      paying: users.filter(u => u.paid).length,
      trialOnly: users.filter(u => u.had_trial && !u.paid).length,
      banned: users.filter(u => !u.is_active).length,
      flagged: users.filter(u => u.flagged_reason).length,
      linkedGroups: clusters.length,
      suspiciousGroups: clusters.filter(c => c.suspicious).length,
      accountsInSuspiciousGroups: clusters.filter(c => c.suspicious).reduce((n, c) => n + c.accounts, 0),
      withInstallId: users.filter(u => u.install_id).length
    };

    res.json({ summary, clusters, busyIps, generatedAt: new Date().toISOString() });
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
