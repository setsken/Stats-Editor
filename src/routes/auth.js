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
function getBrand(product) {
  if (product === 'profile_stats') {
    return {
      name: 'Profile Stats',
      color: '#8b5cf6',
      from: process.env.SMTP_FROM_PS || 'Profile Stats <support@ofstats.pro>',
    };
  }
  return {
    name: 'Stats Editor Pro',
    color: '#00d4ff',
    from: process.env.SMTP_FROM || 'Stats Editor Pro <support@ofstats.pro>',
  };
}

// Helper to send email via Resend HTTP API (bypasses SMTP port blocks)
async function sendEmail(to, subject, html, fromOverride) {
  const apiKey = process.env.SMTP_PASS || process.env.RESEND_API_KEY;
  const from = fromOverride || process.env.SMTP_FROM || 'Stats Editor Pro <support@ofstats.pro>';

  if (!apiKey) {
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
    console.error('Email send error (Resend API):', error.response?.data || error.message);
    return false;
  }
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

    const existingUser = await getOne(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existingUser) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await query(
      `INSERT INTO users (email, password_hash, trial_started_at)
       VALUES ($1, $2, NOW())
       RETURNING id, email, created_at`,
      [email.toLowerCase(), passwordHash]
    );

    const user = result.rows[0];

    const trialDays = parseInt(process.env.TRIAL_DAYS) || 7;
    // Trial is scoped to the product the user registered through, otherwise
    // someone signing up via Profile Stats lands on a Stats Editor-only
    // trial row and the PS popup correctly reports 'No plan'.
    const trialProduct = product === 'profile_stats' ? 'profile_stats' : 'stats_editor';
    await query(
      `INSERT INTO subscriptions (user_id, plan, model_limit, status, payment_provider, expires_at, product)
       VALUES ($1, 'trial', 10, 'active', 'trial', NOW() + INTERVAL '${trialDays} days', $2)`,
      [user.id, trialProduct]
    );

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
    );

    // Send welcome email (non-blocking) — branded per product
    sendEmail(user.email, `Welcome to ${brand.name}!`, `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; padding: 40px; border-radius: 16px;">
        <h1 style="color: ${brand.color}; text-align: center;">${brand.name}</h1>
        <div style="background: #1e293b; padding: 30px; border-radius: 12px; color: #e2e8f0;">
          <h2 style="color: ${brand.color};">Welcome!</h2>
          <p>Your account has been created successfully.</p>
          <p><strong>Email:</strong> ${user.email}</p>
          <p><strong>Trial Period:</strong> ${trialDays} days</p>
        </div>
      </div>
    `, brand.from);

    res.status(201).json({
      message: 'Registration successful',
      user: { id: user.id, email: user.email },
      token,
      trial: { active: true, days: trialDays, modelLimit: 10 }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
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
      'SELECT id, email, password_hash, is_active FROM users WHERE email = $1',
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

    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

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
