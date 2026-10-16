const { query } = require('../config/database');

// Sign-in traces — IP address, country and browser — are kept for a limited
// time. The privacy policies of both extensions promise 90 days; change the
// number there too if TRACE_RETENTION_DAYS is ever set to something else.
//
// The installation id is not purged: the one-trial-per-installation rule
// depends on it, and the policies say it is kept while the account exists.
const RETENTION_DAYS = parseInt(process.env.TRACE_RETENTION_DAYS) || 90;
const RUN_EVERY_MS = 24 * 60 * 60 * 1000;

async function purgeOldTraces() {
  try {
    const events = await query(
      'DELETE FROM auth_events WHERE created_at < NOW() - make_interval(days => $1::int)',
      [RETENTION_DAYS]
    );

    // Signup details are as old as the account.
    const signups = await query(
      `UPDATE users
          SET signup_ip = NULL, signup_country = NULL, signup_user_agent = NULL
        WHERE created_at < NOW() - make_interval(days => $1::int)
          AND (signup_ip IS NOT NULL OR signup_country IS NOT NULL OR signup_user_agent IS NOT NULL)`,
      [RETENTION_DAYS]
    );

    // The last address is as old as the last sign-in that wrote it.
    const lastSeen = await query(
      `UPDATE users
          SET last_ip = NULL
        WHERE last_ip IS NOT NULL
          AND (last_seen_at IS NULL OR last_seen_at < NOW() - make_interval(days => $1::int))`,
      [RETENTION_DAYS]
    );

    console.log(
      `Trace retention (${RETENTION_DAYS} days): removed ${events.rowCount} sign-in events, ` +
      `cleared ${signups.rowCount} signup and ${lastSeen.rowCount} last-seen addresses`
    );
  } catch (err) {
    console.error('Trace retention run failed:', err.message);
  }
}

// A minute after start (so the migration has finished), then daily.
function startRetention() {
  setTimeout(purgeOldTraces, 60 * 1000).unref();
  setInterval(purgeOldTraces, RUN_EVERY_MS).unref();
}

module.exports = { purgeOldTraces, startRetention, RETENTION_DAYS };
