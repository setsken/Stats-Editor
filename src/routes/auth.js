const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { query, getOne } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Per-product branding for outbound emails so users see the product they're
// actually using (Profile Stats vs Stats Editor) in From/subject/body.
// `features` powers the welcome email checklist so each product shows
// what the trial actually unlocks instead of a generic blurb.
function getBrand(product) {
  if (product === 'profile_stats') {
    return {
      name: 'Profile Stats',
      tagline: 'Real-time profile analytics on every OnlyFans page',
      color: '#8b5cf6',
      colorSoft: 'rgba(139, 92, 246, 0.15)',
      gradient: 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)',
      from: process.env.SMTP_FROM_PS || 'Profile Stats <support@ofstats.pro>',
      tip: 'Open any OnlyFans profile — the stats badge appears automatically. Click the extension icon to access the Top Models leaderboard, notes and settings.',
      features: [
        { icon: '📊', title: 'Live profile badge',     text: 'Score, fans, posts, likes and growth indicators on every OnlyFans profile.' },
        { icon: '🏆', title: 'Top Models leaderboard', text: 'Ranked feed of the models you have viewed with deep filters by audience and quality.' },
        { icon: '📈', title: 'Fans trend chart',       text: 'Day-by-day fan dynamics for every model so you can spot momentum early.' },
        { icon: '📝', title: 'Notes & tags',           text: 'Private notes per model, grouped under colour-coded tags you control.' },
        { icon: '🤖', title: 'Verdict AI',             text: 'AI-powered profile verdict to help you decide who is worth your time.' },
      ],
    };
  }
  return {
    name: 'Stats Editor Pro',
    tagline: 'Pro analytics & automation for your Stats Editor workflow',
    color: '#00d4ff',
    colorSoft: 'rgba(0, 212, 255, 0.15)',
    gradient: 'linear-gradient(135deg, #00d4ff 0%, #0ea5e9 100%)',
    from: process.env.SMTP_FROM || 'Stats Editor Pro <support@ofstats.pro>',
    tip: 'Open the Stats Editor panel on any model page — pro stats and tools light up automatically. Use the popup to manage your account and preferences.',
    features: [
      { icon: '📈', title: 'Advanced stats',        text: 'Detailed performance breakdowns across all the models you manage.' },
      { icon: '💬', title: 'Mass messaging tools',  text: 'Pro-tier sending flows with templates and audience segmentation.' },
      { icon: '🎯', title: 'Smart targeting',       text: 'Filter fans by spend, activity and tags to focus on the right audience.' },
      { icon: '⚡', title: 'Workflow automation',   text: 'Speed up repetitive tasks with one-click actions in the editor.' },
      { icon: '🔒', title: 'Priority support',      text: 'Get help from the team within hours, not days.' },
    ],
  };
}

// Build a polished HTML welcome email for either product. Kept inline so
// every Resend send is a single self-contained string — no template loader
// to wire up, and the inline styles survive Gmail / Apple Mail rewrites.
function renderWelcomeHtml(brand, email, trialDays) {
  const featureRows = brand.features.map(f => `
    <tr>
      <td style="padding: 10px 0; vertical-align: top; width: 36px;">
        <div style="width: 32px; height: 32px; border-radius: 8px; background: ${brand.colorSoft}; text-align: center; line-height: 32px; font-size: 18px;">${f.icon}</div>
      </td>
      <td style="padding: 10px 0 10px 12px; vertical-align: top; color: #e2e8f0;">
        <div style="font-weight: 700; font-size: 14px; margin-bottom: 2px;">${f.title}</div>
        <div style="font-size: 13px; color: #94a3b8; line-height: 1.5;">${f.text}</div>
      </td>
    </tr>
  `).join('');

  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background: #0b1020; padding: 24px 12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" width="600" style="max-width: 600px; margin: 0 auto; background: #0f172a; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.4);">
      <tr>
        <td style="background: ${brand.gradient}; padding: 36px 32px; text-align: center;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 0 auto;">
            <tr>
              <td style="vertical-align: middle; padding-right: 12px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding: 0 2px;"><div style="width: 8px; height: 18px; background: #ffffff; border-radius: 2px;"></div></td>
                    <td style="padding: 0 2px;"><div style="width: 8px; height: 30px; background: #ffffff; border-radius: 2px;"></div></td>
                    <td style="padding: 0 2px;"><div style="width: 8px; height: 24px; background: #ffffff; border-radius: 2px;"></div></td>
                  </tr>
                  <tr>
                    <td colspan="3" style="padding-top: 3px;"><div style="height: 3px; background: rgba(255,255,255,0.75); border-radius: 2px;"></div></td>
                  </tr>
                </table>
              </td>
              <td style="vertical-align: middle;">
                <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800; letter-spacing: -0.01em; line-height: 1;">${brand.name}</h1>
              </td>
            </tr>
          </table>
          <p style="margin: 12px 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">${brand.tagline}</p>
        </td>
      </tr>
      <tr>
        <td style="padding: 32px;">
          <h2 style="margin: 0 0 8px; color: #ffffff; font-size: 22px; font-weight: 700;">Welcome aboard! 🎉</h2>
          <p style="margin: 0 0 20px; color: #cbd5e1; font-size: 14px; line-height: 1.6;">
            Your account is ready. You have <strong style="color: ${brand.color};">${trialDays} days of full access</strong> to explore everything ${brand.name} offers — no payment required.
          </p>

          <div style="background: #1e293b; border-radius: 12px; padding: 18px 20px; margin: 0 0 24px;">
            <div style="font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700;">Account</div>
            <div style="font-size: 14px; color: #ffffff; margin-top: 4px;"><strong>${email}</strong></div>
          </div>

          <div style="margin-bottom: 8px;">
            <div style="font-size: 11px; color: ${brand.color}; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; margin-bottom: 4px;">What's included</div>
            <h3 style="margin: 0 0 12px; color: #ffffff; font-size: 18px; font-weight: 700;">Everything unlocked during your trial</h3>
          </div>

          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            ${featureRows}
          </table>

          <hr style="border: none; border-top: 1px solid #1e293b; margin: 28px 0;">

          <p style="margin: 0; color: #cbd5e1; font-size: 13px; line-height: 1.6;">
            <strong style="color: #ffffff;">Tip:</strong> ${brand.tip}
          </p>
        </td>
      </tr>
      <tr>
        <td style="background: #0b1020; padding: 18px 32px; text-align: center; border-top: 1px solid #1e293b;">
          <p style="margin: 0; color: #64748b; font-size: 11px;">
            You received this because you signed up for ${brand.name}.<br>
            One Monly account works across all our products — Stats Editor, Profile Stats and more.
          </p>
        </td>
      </tr>
    </table>
  </div>`;
}

// Verification is what stops a 7-day trial being handed to any address that
// merely looks like an email. Set REQUIRE_EMAIL_VERIFICATION=false to fall back
// to the old straight-to-trial behaviour (useful if outbound mail ever breaks).
const VERIFICATION_REQUIRED = process.env.REQUIRE_EMAIL_VERIFICATION !== 'false';
const CODE_TTL_MINUTES = 15;
const MAX_CODE_ATTEMPTS = 8;
const RESEND_COOLDOWN_MS = 60 * 1000;
const TRIAL_MODEL_LIMIT = parseInt(process.env.TRIAL_MODEL_LIMIT) || 10;

function generateVerificationCode() {
  // Six digits from a cryptographic source — Math.random() is predictable.
  return String(crypto.randomInt(100000, 1000000));
}

// Disposable inboxes and undeliverable domains: see services/email-risk.js.
const { assessEmail, canonicalEmail } = require('../services/email-risk');

function renderCodeHtml(brand, code) {
  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background: #0b1020; padding: 24px 12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" width="600" style="max-width: 600px; margin: 0 auto; background: #0f172a; border-radius: 16px; overflow: hidden;">
      <tr><td style="background: ${brand.gradient}; padding: 28px 32px; text-align: center;">
        <div style="color: #ffffff; font-size: 22px; font-weight: 800;">${brand.name}</div>
        <div style="color: rgba(255,255,255,0.85); font-size: 13px; margin-top: 4px;">${brand.tagline}</div>
      </td></tr>
      <tr><td style="padding: 32px;">
        <div style="color: #e2e8f0; font-size: 16px; font-weight: 700; margin-bottom: 8px;">Confirm your email</div>
        <div style="color: #94a3b8; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
          Enter this code in the extension to finish creating your account and start your free trial.
        </div>
        <div style="text-align: center; margin: 0 0 24px;">
          <div style="display: inline-block; background: ${brand.colorSoft}; border: 1px solid ${brand.color}; border-radius: 12px; padding: 16px 28px; color: #ffffff; font-size: 32px; font-weight: 800; letter-spacing: 8px;">${code}</div>
        </div>
        <div style="color: #64748b; font-size: 13px; line-height: 1.6;">
          The code is valid for ${CODE_TTL_MINUTES} minutes. If you did not ask to create an account, just ignore this message.
        </div>
      </td></tr>
    </table>
  </div>`;
}

// Who is on the other end of a request. Requests arrive through Cloudflare
// (api.ofstats.pro) or straight at Railway (the fallback host), so the real
// address is in a different header depending on the route. None of this is
// proof — headers can be forged on the direct route — it is evidence for
// linking accounts, never a reason on its own to refuse anyone.
function clientMeta(req) {
  const cfIp = req.get('cf-connecting-ip');
  const forwarded = (req.get('x-forwarded-for') || '').split(',')[0].trim();
  const ip = (cfIp || forwarded || req.ip || '').slice(0, 64) || null;

  const country = (req.get('cf-ipcountry') || '').slice(0, 8) || null;
  const userAgent = (req.get('user-agent') || '').slice(0, 500) || null;

  // Random id the extension makes once per browser profile and keeps across
  // sign-outs — the one trace that survives switching accounts.
  const rawInstall = (req.body && req.body.installId) || req.get('x-install-id') || '';
  const installId = /^[A-Za-z0-9-]{8,64}$/.test(rawInstall) ? rawInstall : null;

  return { ip, country, userAgent, installId };
}

// Never allowed to break a sign-in: if the write fails, the user still gets in.
async function recordAuthEvent(userId, event, meta) {
  try {
    await query(
      `INSERT INTO auth_events (user_id, event, ip, country, user_agent, install_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, event, meta.ip, meta.country, meta.userAgent, meta.installId]
    );
    await query(
      `UPDATE users
          SET last_ip = COALESCE($1, last_ip),
              last_seen_at = NOW(),
              install_id = COALESCE($2, install_id)
        WHERE id = $3`,
      [meta.ip, meta.installId, userId]
    );
  } catch (err) {
    console.error('Auth event not recorded for user', userId, '-', err.message);
  }
}

// The first values win: a signup retried from another place is still visible
// in auth_events, while these keep where the account was born.
async function recordSignup(userId, meta) {
  try {
    await query(
      `UPDATE users
          SET signup_ip = COALESCE(signup_ip, $1),
              signup_country = COALESCE(signup_country, $2),
              signup_user_agent = COALESCE(signup_user_agent, $3)
        WHERE id = $4`,
      [meta.ip, meta.country, meta.userAgent, userId]
    );
  } catch (err) {
    console.error('Signup details not recorded for user', userId, '-', err.message);
  }
}

// Last outbound-mail failure, so the diagnostic endpoint can report what Resend
// actually said instead of a bare "false".
let lastEmailError = null;

// Helper to send email via Resend HTTP API (bypasses SMTP port blocks)
async function sendEmail(to, subject, html, fromOverride) {
  const apiKey = process.env.SMTP_PASS || process.env.RESEND_API_KEY;
  const from = fromOverride || process.env.SMTP_FROM || 'Stats Editor Pro <support@ofstats.pro>';

  if (!apiKey) {
    lastEmailError = 'No API key: set SMTP_PASS or RESEND_API_KEY';
    console.log('Resend API key not configured, skipping email to:', to);
    return false;
  }

  try {
    const axios = require('axios');
    const response = await axios.post('https://api.resend.com/emails', {
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    console.log('Email sent via Resend API to:', to, '| id:', response.data?.id);
    return true;
  } catch (error) {
    lastEmailError = error.response?.data || error.message || String(error);
    console.error('Email send error (Resend API):', lastEmailError);
    return false;
  }
}

const NO_PLAN = { plan: 'none', status: 'expired', model_limit: 0, isActive: false };

// Has another account already had a trial from this installation? Accounts
// created before trial_used existed only have trial_started_at, so both count.
async function trialAlreadyUsedFrom(installId, userId) {
  if (!installId) return false;
  const prior = await getOne(
    `SELECT u.id
       FROM users u
      WHERE u.id <> $1
        AND (u.trial_used = TRUE OR u.trial_started_at IS NOT NULL)
        AND (u.install_id = $2
             OR EXISTS (SELECT 1 FROM auth_events e WHERE e.user_id = u.id AND e.install_id = $2))
      LIMIT 1`,
    [userId, installId]
  );
  return prior ? prior.id : false;
}

// Starts the trial for a confirmed account and hands back a session.
// trial_used is set here so a second trial can be refused later on.
async function startTrial(userId, email, signupProduct, installId) {
  const priorAccount = await trialAlreadyUsedFrom(installId, userId);
  if (priorAccount) {
    await query(
      'UPDATE users SET flagged_reason = COALESCE(flagged_reason, $1) WHERE id = $2',
      ['Repeat trial from the installation of account #' + priorAccount, userId]
    );
    const token = jwt.sign(
      { userId, email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
    );
    // The popup sends an inactive subscription straight to the plans screen.
    return { token, trialDays: 0, subscription: NO_PLAN, trialDenied: true };
  }

  const trialDays = parseInt(process.env.TRIAL_DAYS) || 7;
  // Trial is scoped to the product the user registered through, otherwise
  // someone signing up via Profile Stats lands on a Stats Editor-only
  // trial row and the PS popup correctly reports 'No plan'.
  const trialProduct = signupProduct === 'profile_stats' ? 'profile_stats' : 'stats_editor';

  await query(
    `INSERT INTO subscriptions (user_id, plan, model_limit, status, payment_provider, expires_at, product)
     VALUES ($1, 'trial', $2, 'active', 'trial', NOW() + INTERVAL '${trialDays} days', $3)`,
    [userId, TRIAL_MODEL_LIMIT, trialProduct]
  );

  await query(
    'UPDATE users SET trial_started_at = NOW(), trial_used = TRUE WHERE id = $1',
    [userId]
  );

  const token = jwt.sign(
    { userId, email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );

  return {
    token,
    trialDays,
    subscription: { plan: 'trial', status: 'active', model_limit: TRIAL_MODEL_LIMIT, product: trialProduct, isActive: true }
  };
}

// The pre-verification behaviour, kept behind REQUIRE_EMAIL_VERIFICATION=false
// as an escape hatch in case outbound mail breaks.
async function completeRegistration(res, { email, passwordHash, signupProduct, brand, existingUserId, meta }) {
  let user;
  if (existingUserId) {
    const updated = await query(
      'UPDATE users SET password_hash = $1, signup_product = $2 WHERE id = $3 RETURNING id, email',
      [passwordHash, signupProduct, existingUserId]
    );
    user = updated.rows[0];
  } else {
    const inserted = await query(
      `INSERT INTO users (email, password_hash, email_verified, signup_product, email_canonical)
       VALUES ($1, $2, TRUE, $3, $4)
       RETURNING id, email`,
      [email, passwordHash, signupProduct, canonicalEmail(email)]
    );
    user = inserted.rows[0];
  }

  if (meta) {
    await recordSignup(user.id, meta);
    await recordAuthEvent(user.id, 'register', meta);
  }

  const { token, trialDays, subscription, trialDenied } =
    await startTrial(user.id, user.email, signupProduct, meta && meta.installId);

  if (!trialDenied) {
    sendEmail(
      user.email,
      `Welcome to ${brand.name} — your ${trialDays}-day trial is live`,
      renderWelcomeHtml(brand, user.email, trialDays),
      brand.from
    );
  }

  return res.status(201).json({
    message: 'Registration successful',
    user: { id: user.id, email: user.email },
    token,
    subscription,
    trial: trialDenied
      ? { active: false }
      : { active: true, days: trialDays, modelLimit: TRIAL_MODEL_LIMIT }
  });
}

// Register new user
router.post('/register', async (req, res) => {
  try {
    const { email, password, product } = req.body;
    const brand = getBrand(product);

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const signupProduct = product === 'profile_stats' ? 'profile_stats' : 'stats_editor';

    const risk = await assessEmail(normalizedEmail);
    if (!risk.ok) {
      console.log('Signup refused for', normalizedEmail, '-', risk.code, risk.reason);
      return res.status(400).json(risk.code === 'DISPOSABLE_EMAIL'
        ? { error: 'Temporary email addresses are not accepted. Please use a permanent one.', code: risk.code }
        : { error: 'That email address does not seem to exist. Please check the spelling.', code: risk.code });
    }

    const emailCanonical = canonicalEmail(normalizedEmail);

    const existingUser = await getOne(
      'SELECT id, email_verified FROM users WHERE email = $1',
      [normalizedEmail]
    );

    // A half-finished signup is not a taken address: let them try again and
    // send a fresh code, instead of locking the address behind "already
    // registered" forever.
    if (existingUser && existingUser.email_verified !== false) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // ivan+2@gmail.com when ivan@gmail.com already has an account: one inbox,
    // so one account. Abandoned unconfirmed signups do not count.
    const twin = await getOne(
      `SELECT id FROM users
        WHERE email_canonical = $1 AND email <> $2 AND email_verified IS NOT FALSE
        LIMIT 1`,
      [emailCanonical, normalizedEmail]
    );
    if (twin) {
      console.log('Signup refused for', normalizedEmail, '- same mailbox as account #' + twin.id);
      return res.status(409).json({ error: 'Email already registered' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    if (!VERIFICATION_REQUIRED) {
      return await completeRegistration(res, {
        email: normalizedEmail, passwordHash, signupProduct, brand,
        existingUserId: existingUser?.id, meta: clientMeta(req)
      });
    }

    const code = generateVerificationCode();
    let user;

    if (existingUser) {
      const updated = await query(
        `UPDATE users
            SET password_hash = $1,
                email_verification_code = $2,
                email_verification_expires = NOW() + INTERVAL '${CODE_TTL_MINUTES} minutes',
                email_verification_attempts = 0,
                email_verification_sent_at = NOW(),
                signup_product = $3
          WHERE id = $4
        RETURNING id, email`,
        [passwordHash, code, signupProduct, existingUser.id]
      );
      user = updated.rows[0];
    } else {
      const inserted = await query(
        `INSERT INTO users (email, password_hash, email_verified, email_verification_code,
                            email_verification_expires, email_verification_sent_at, signup_product,
                            email_canonical)
         VALUES ($1, $2, FALSE, $3, NOW() + INTERVAL '${CODE_TTL_MINUTES} minutes', NOW(), $4, $5)
         RETURNING id, email`,
        [normalizedEmail, passwordHash, code, signupProduct, emailCanonical]
      );
      user = inserted.rows[0];
    }

    const meta = clientMeta(req);
    await recordSignup(user.id, meta);
    await recordAuthEvent(user.id, 'register', meta);

    // Awaited on purpose: if the code cannot be delivered there is no point
    // sending the user to a screen asking for it.
    const sent = await sendEmail(
      user.email,
      `${brand.name} — your verification code`,
      renderCodeHtml(brand, code),
      brand.from
    );

    if (!sent) {
      console.error('Verification code could not be sent to', user.email, '-', lastEmailError);
      return res.status(502).json({
        error: 'We could not send the verification code. Please try again in a minute.',
        code: 'EMAIL_SEND_FAILED'
      });
    }

    res.status(201).json({
      message: 'Verification code sent',
      requiresVerification: true,
      email: user.email
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Diagnostic: is outbound mail working at all? Guarded by ADMIN_TOKEN, and does
// nothing unless that variable is set.
router.post('/email-test', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    return res.status(404).json({ error: 'Not available' });
  }
  if (req.get('x-admin-token') !== adminToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const to = req.body?.to;
  if (!to) return res.status(400).json({ error: 'Provide "to"' });

  lastEmailError = null;
  const brand = getBrand(req.body?.product);
  const ok = await sendEmail(to, `${brand.name} — delivery test`, renderCodeHtml(brand, '123456'), brand.from);

  res.json({
    sent: ok,
    from: brand.from,
    apiKeyConfigured: !!(process.env.SMTP_PASS || process.env.RESEND_API_KEY),
    verificationRequired: VERIFICATION_REQUIRED,
    error: ok ? null : lastEmailError
  });
});

// Confirm the code, start the trial, hand back a session.
router.post('/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await getOne(
      `SELECT id, email, email_verified, email_verification_code, email_verification_expires,
              email_verification_attempts, signup_product
         FROM users WHERE email = $1`,
      [normalizedEmail]
    );

    // Same answer whether the address is unknown or the code is wrong, so this
    // cannot be used to find out which addresses exist.
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired code', code: 'INVALID_CODE' });
    }

    if (user.email_verified) {
      return res.status(400).json({ error: 'This email is already confirmed. Please sign in.', code: 'ALREADY_VERIFIED' });
    }

    if ((user.email_verification_attempts || 0) >= MAX_CODE_ATTEMPTS) {
      return res.status(429).json({
        error: 'Too many incorrect attempts. Request a new code.',
        code: 'TOO_MANY_ATTEMPTS'
      });
    }

    if (!user.email_verification_expires || new Date(user.email_verification_expires) < new Date()) {
      return res.status(400).json({ error: 'The code has expired. Request a new one.', code: 'CODE_EXPIRED' });
    }

    if (!user.email_verification_code || String(code).trim() !== user.email_verification_code) {
      await query(
        'UPDATE users SET email_verification_attempts = COALESCE(email_verification_attempts, 0) + 1 WHERE id = $1',
        [user.id]
      );
      return res.status(400).json({ error: 'Invalid or expired code', code: 'INVALID_CODE' });
    }

    await query(
      `UPDATE users
          SET email_verified = TRUE,
              email_verification_code = NULL,
              email_verification_expires = NULL,
              email_verification_attempts = 0
        WHERE id = $1`,
      [user.id]
    );

    const meta = clientMeta(req);
    await recordAuthEvent(user.id, 'verify', meta);

    const signupProduct = user.signup_product || 'stats_editor';
    const { token, trialDays, subscription, trialDenied } =
      await startTrial(user.id, user.email, signupProduct, meta.installId);
    const brand = getBrand(signupProduct);

    if (!trialDenied) {
      sendEmail(
        user.email,
        `Welcome to ${brand.name} — your ${trialDays}-day trial is live`,
        renderWelcomeHtml(brand, user.email, trialDays),
        brand.from
      );
    }

    res.json({
      message: 'Email verified',
      user: { id: user.id, email: user.email },
      token,
      subscription,
      trial: trialDenied
        ? { active: false }
        : { active: true, days: trialDays, modelLimit: TRIAL_MODEL_LIMIT }
    });

  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Send another code.
router.post('/resend-verification', async (req, res) => {
  // One reply for every case — an unknown address, an already-confirmed one and
  // a genuine resend look identical from outside.
  const generic = { message: 'If that address still needs confirming, a new code is on its way.' };

  try {
    const { email, product } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await getOne(
      'SELECT id, email, email_verified, email_verification_sent_at, signup_product FROM users WHERE email = $1',
      [normalizedEmail]
    );

    if (!user || user.email_verified) return res.json(generic);

    // Quietly ignore rapid repeats rather than becoming a way to mail-bomb
    // somebody else's inbox.
    if (user.email_verification_sent_at &&
        Date.now() - new Date(user.email_verification_sent_at).getTime() < RESEND_COOLDOWN_MS) {
      return res.json(generic);
    }

    const code = generateVerificationCode();
    await query(
      `UPDATE users
          SET email_verification_code = $1,
              email_verification_expires = NOW() + INTERVAL '${CODE_TTL_MINUTES} minutes',
              email_verification_attempts = 0,
              email_verification_sent_at = NOW()
        WHERE id = $2`,
      [code, user.id]
    );

    const brand = getBrand(product || user.signup_product);
    const sent = await sendEmail(
      user.email,
      `${brand.name} — your verification code`,
      renderCodeHtml(brand, code),
      brand.from
    );

    if (!sent) {
      console.error('Resend of verification code failed for', user.email, '-', lastEmailError);
      return res.status(502).json({
        error: 'We could not send the code. Please try again in a minute.',
        code: 'EMAIL_SEND_FAILED'
      });
    }

    res.json(generic);

  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Could not resend the code' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await getOne(
      'SELECT id, email, password_hash, is_active, email_verified FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password', code: 'INVALID_CREDENTIALS' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is deactivated' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password', code: 'INVALID_CREDENTIALS', canResetPassword: true });
    }

    if (VERIFICATION_REQUIRED && user.email_verified === false) {
      return res.status(403).json({
        error: 'Please confirm your email first — we sent you a code.',
        code: 'EMAIL_NOT_VERIFIED',
        requiresVerification: true,
        email: user.email
      });
    }

    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    await recordAuthEvent(user.id, 'login', clientMeta(req));

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
    );

    const subscription = await getOne(`
      SELECT plan, model_limit, status, expires_at,
        CASE WHEN expires_at > NOW() AND status = 'active' THEN true ELSE false END as is_active
      FROM subscriptions WHERE user_id = $1 ORDER BY expires_at DESC LIMIT 1
    `, [user.id]);

    res.json({
      message: 'Login successful',
      user: { id: user.id, email: user.email },
      token,
      subscription: subscription || null
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Refresh token — accepts current token (even recently expired) and issues a new one
router.post('/refresh', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Token required' });
    }

    let decoded;
    try {
      // Try to verify normally first
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        // Allow refresh for tokens expired within the last 30 days (grace period)
        decoded = jwt.decode(token);
        if (!decoded || !decoded.userId) {
          return res.status(401).json({ error: 'Invalid token' });
        }
        const expiredAt = decoded.exp * 1000;
        const gracePeriod = 30 * 24 * 60 * 60 * 1000; // 30 days
        if (Date.now() - expiredAt > gracePeriod) {
          return res.status(401).json({ error: 'Token too old to refresh, please log in again' });
        }
      } else {
        return res.status(401).json({ error: 'Invalid token' });
      }
    }

    // Verify user still exists and is active
    const user = await getOne(
      'SELECT id, email, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'User not found or deactivated' });
    }

    // Issue fresh token
    const newToken = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
    );

    res.json({
      success: true,
      token: newToken,
      user: { id: user.id, email: user.email }
    });

  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// Forgot password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email, product } = req.body;
    const brand = getBrand(product);

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await getOne('SELECT id, email FROM users WHERE email = $1', [email.toLowerCase()]);

    // Always return success to prevent email enumeration
    if (!user) {
      return res.json({ message: 'If this email exists, a reset link has been sent' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour

    await query(
      'UPDATE users SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3',
      [resetTokenHash, expiresAt, user.id]
    );

    // Send reset email (non-blocking) — branded per product
    sendEmail(user.email, `Password Reset - ${brand.name}`, `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; padding: 40px; border-radius: 16px;">
        <h1 style="color: ${brand.color}; text-align: center;">${brand.name}</h1>
        <div style="background: #1e293b; padding: 30px; border-radius: 12px; color: #e2e8f0;">
          <h2 style="color: ${brand.color};">Password Reset</h2>
          <p>You requested a password reset for your account.</p>
          <p>Your reset code:</p>
          <div style="background: #0f172a; padding: 15px; border-radius: 8px; text-align: center; margin: 20px 0;">
            <code style="color: ${brand.color}; font-size: 18px; letter-spacing: 2px;">${resetToken}</code>
          </div>
          <p style="color: #94a3b8; font-size: 14px;">This code expires in 1 hour.</p>
          <p style="color: #94a3b8; font-size: 14px;">If you didn't request this, please ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #334155; margin: 20px 0;">
          <p style="color: #94a3b8; font-size: 13px;">
            <strong style="color: #e2e8f0;">Note:</strong> Your Monly account is shared across all our products.
            Changing your password here will update it everywhere — Stats Editor, Profile Stats and any other Monly product you use.
          </p>
        </div>
      </div>
    `, brand.from);

    res.json({ message: 'If this email exists, a reset link has been sent' });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// Reset password with token
router.post('/reset-password', async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;

    if (!email || !token || !newPassword) {
      return res.status(400).json({ error: 'Email, token, and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const user = await getOne(
      'SELECT id FROM users WHERE email = $1 AND password_reset_token = $2 AND password_reset_expires > NOW()',
      [email.toLowerCase(), tokenHash]
    );

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await query(
      'UPDATE users SET password_hash = $1, password_reset_token = NULL, password_reset_expires = NULL WHERE id = $2',
      [passwordHash, user.id]
    );

    res.json({ message: 'Password reset successful' });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Verify token and get current user
router.get('/verify', authenticateToken, async (req, res) => {
  try {
    const user = await getOne(
      'SELECT id, email, created_at, last_login_at FROM users WHERE id = $1',
      [req.user.id]
    );

    const subscription = await getOne(`
      SELECT plan, model_limit, status, expires_at, starts_at,
        CASE WHEN expires_at > NOW() AND status = 'active' THEN true ELSE false END as is_active
      FROM subscriptions WHERE user_id = $1 ORDER BY expires_at DESC LIMIT 1
    `, [req.user.id]);

    const modelCount = await getOne('SELECT COUNT(*) as count FROM user_models WHERE user_id = $1', [req.user.id]);

    res.json({
      user: { id: user.id, email: user.email, createdAt: user.created_at, lastLoginAt: user.last_login_at },
      subscription: subscription ? {
        plan: subscription.plan,
        modelLimit: subscription.model_limit || 10,
        status: subscription.status,
        isActive: subscription.is_active,
        expiresAt: subscription.expires_at,
        startsAt: subscription.starts_at
      } : null,
      usage: { modelCount: parseInt(modelCount.count) }
    });

  } catch (error) {
    console.error('Verify error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Support email — user sends a bug report from inside the plugin
router.post('/support', authenticateToken, async (req, res) => {
  try {
    const { subject, message, product } = req.body;

    if (!message || message.trim().length < 10) {
      return res.status(400).json({ error: 'Message is too short' });
    }

    // Multi-product split: caller passes product='profile_stats' so we can
    // tag the subject + email header and route oncall accordingly. Anything
    // else (or absent) is treated as Stats Editor for backward compat.
    const productKey = product === 'profile_stats' ? 'profile_stats' : 'stats_editor';
    const productName = productKey === 'profile_stats' ? 'Profile Stats' : 'Of Stats Editor';
    const defaultSubject = productKey === 'profile_stats'
      ? 'Bug Report — Profile Stats'
      : 'Bug Report — Of Stats Editor';

    const userEmail = req.user.email;
    const emailSubject = subject?.trim() || defaultSubject;

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0d1117; color: #c9d1d9; padding: 24px; border-radius: 8px;">
        <div style="border-bottom: 2px solid #00b4ff; padding-bottom: 16px; margin-bottom: 24px;">
          <h2 style="margin: 0; color: #00b4ff; font-size: 18px;">📩 New Support Request — ${productName}</h2>
        </div>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
          <tr>
            <td style="padding: 8px 0; color: #8b949e; width: 120px; font-size: 13px;">Product:</td>
            <td style="padding: 8px 0; color: #e6edf3; font-size: 13px;"><strong>${productName}</strong></td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #8b949e; font-size: 13px;">From (user):</td>
            <td style="padding: 8px 0; color: #e6edf3; font-size: 13px;"><strong>${userEmail}</strong></td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #8b949e; font-size: 13px;">Subject:</td>
            <td style="padding: 8px 0; color: #e6edf3; font-size: 13px;">${emailSubject}</td>
          </tr>
        </table>
        <div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 16px; margin-bottom: 20px;">
          <p style="margin: 0; font-size: 14px; line-height: 1.6; white-space: pre-wrap; color: #e6edf3;">${message.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
        </div>
        <p style="color: #8b949e; font-size: 12px; margin: 0;">Reply to this user at: <a href="mailto:${userEmail}" style="color: #00b4ff;">${userEmail}</a></p>
      </div>`;

    const tagPrefix = productKey === 'profile_stats' ? 'Support · Profile Stats' : 'Support';
    const sent = await sendEmail(
      'support@ofstats.pro',
      `[${tagPrefix}] ${emailSubject} — ${userEmail}`,
      html
    );

    if (sent) {
      res.json({ success: true, message: 'Support request sent' });
    } else {
      // If transporter not configured, log and return success anyway (dev mode)
      console.log('Support email (no SMTP):', { from: userEmail, subject: emailSubject, message });
      res.json({ success: true, message: 'Support request received' });
    }

  } catch (error) {
    console.error('Support email error:', error);
    res.status(500).json({ error: 'Failed to send support request' });
  }
});

// Change password
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const user = await getOne('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const salt = await bcrypt.genSalt(10);
    const newPasswordHash = await bcrypt.hash(newPassword, salt);

    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newPasswordHash, req.user.id]);

    res.json({ message: 'Password changed successfully' });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
