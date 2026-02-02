const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query, getOne } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Resend API configuration
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Stats Editor <onboarding@resend.dev>';

if (RESEND_API_KEY) {
  console.log('📧 Resend API configured');
} else {
  console.log('⚠️ RESEND_API_KEY not set - emails will be skipped');
}

// Helper to send email via Resend API
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.log('⚠️ Resend not configured, skipping email to:', to);
    return false;
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to],
        subject: subject,
        html: html
      })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      console.log('✅ Email sent to:', to, 'id:', data.id);
      return true;
    } else {
      console.error('❌ Resend error:', data);
      return false;
    }
  } catch (error) {
    console.error('❌ Email send error:', error.message);
    return false;
  }
}

// Generate 6-digit code
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Generate responsive email HTML template
function generateEmailTemplate(title, content) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <!--[if mso]>
  <style type="text/css">
    table { border-collapse: collapse; }
    .content { width: 600px !important; }
  </style>
  <![endif]-->
</head>
<body style="margin: 0; padding: 0; background-color: #0a0e1a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #0a0e1a;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 600px; background: linear-gradient(180deg, #0f1535 0%, #0a0e27 100%); border-radius: 16px; border: 1px solid rgba(0, 180, 255, 0.2); box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5), 0 0 20px rgba(0, 180, 255, 0.1);">
          <!-- Header -->
          <tr>
            <td align="center" style="padding: 30px 40px 20px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding-right: 12px;">
                    <div style="width: 40px; height: 40px; background: linear-gradient(135deg, #00b4ff, #00d4aa); border-radius: 10px; display: flex; align-items: center; justify-content: center;">
                      <span style="font-size: 20px; color: white; font-weight: bold;">S</span>
                    </div>
                  </td>
                  <td>
                    <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">Stats Editor</h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background: rgba(30, 41, 59, 0.5); border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.05);">
                <tr>
                  <td style="padding: 30px;">
                    ${content}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td align="center" style="padding: 0 40px 30px;">
              <p style="margin: 0; color: #64748b; font-size: 12px;">© 2026 Stats Editor. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

// Register new user (requires email verification)
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;

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
      'SELECT id, email_verified FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existingUser && existingUser.email_verified) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const verificationCode = generateVerificationCode();
    const codeExpires = new Date(Date.now() + 3600000); // 1 hour

    let user;
    if (existingUser) {
      // Update existing unverified user
      const result = await query(
        `UPDATE users SET password_hash = $1, email_verification_code = $2, email_verification_expires = $3
         WHERE id = $4 RETURNING id, email, created_at`,
        [passwordHash, verificationCode, codeExpires, existingUser.id]
      );
      user = result.rows[0];
    } else {
      // Create new user
      const result = await query(
        `INSERT INTO users (email, password_hash, email_verified, email_verification_code, email_verification_expires, trial_started_at)
         VALUES ($1, $2, false, $3, $4, NOW())
         RETURNING id, email, created_at`,
        [email.toLowerCase(), passwordHash, verificationCode, codeExpires]
      );
      user = result.rows[0];
    }

    // Log code for debugging
    console.log(`📧 Verification code for ${user.email}: ${verificationCode}`);

    // Send response IMMEDIATELY (don't wait for email)
    res.status(201).json({
      message: 'Verification code sent',
      requiresVerification: true,
      email: user.email
    });

    // Send verification email in background (fire and forget)
    sendEmail(user.email, 'Verify Your Email - Stats Editor', generateEmailTemplate('Verify Your Email', `
      <h2 style="margin: 0 0 16px; color: #00b4ff; font-size: 20px; font-weight: 600;">Verify Your Email</h2>
      <p style="margin: 0 0 20px; color: #e2e8f0; font-size: 15px; line-height: 1.6;">Welcome! Please enter the code below to verify your email address:</p>
      <div style="background: linear-gradient(135deg, #0f172a 0%, #1a1a2e 100%); padding: 24px; border-radius: 10px; text-align: center; margin: 24px 0; border: 1px solid rgba(0, 180, 255, 0.2);">
        <code style="color: #00b4ff; font-size: 36px; letter-spacing: 10px; font-weight: bold; font-family: 'SF Mono', Monaco, 'Courier New', monospace;">${verificationCode}</code>
      </div>
      <p style="margin: 0 0 8px; color: #94a3b8; font-size: 13px;">This code expires in 1 hour.</p>
      <p style="margin: 0; color: #64748b; font-size: 13px;">If you didn't create this account, please ignore this email.</p>
    `)).catch(err => console.error('Background email error:', err));

    return; // Already sent response

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
      'SELECT id, email, password_hash, is_active, email_verified FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password', code: 'INVALID_CREDENTIALS' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is deactivated' });
    }

    // Check if email is verified
    if (!user.email_verified) {
      return res.status(403).json({ error: 'Please verify your email first', code: 'EMAIL_NOT_VERIFIED' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password', code: 'INVALID_CREDENTIALS', canResetPassword: true });
    }

    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
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

// Verify email with code
router.post('/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required' });
    }

    const user = await getOne(
      `SELECT id, email, email_verification_code, email_verification_expires 
       FROM users WHERE email = $1 AND email_verified = false`,
      [email.toLowerCase()]
    );

    if (!user) {
      return res.status(400).json({ error: 'Invalid email or already verified' });
    }

    if (user.email_verification_code !== code) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    if (new Date(user.email_verification_expires) < new Date()) {
      return res.status(400).json({ error: 'Verification code expired. Please request a new one.' });
    }

    // Mark email as verified
    await query(
      `UPDATE users SET email_verified = true, email_verification_code = NULL, email_verification_expires = NULL WHERE id = $1`,
      [user.id]
    );

    const trialDays = parseInt(process.env.TRIAL_DAYS) || 7;

    // Check if subscription already exists
    const existingSub = await getOne(
      'SELECT id FROM subscriptions WHERE user_id = $1',
      [user.id]
    );

    // Create trial subscription only if doesn't exist
    if (!existingSub) {
      await query(
        `INSERT INTO subscriptions (user_id, plan, model_limit, status, payment_provider, expires_at)
         VALUES ($1, 'trial', 10, 'active', 'trial', NOW() + INTERVAL '${trialDays} days')`,
        [user.id]
      );
    }

    // Generate token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    const subscription = await getOne(`
      SELECT plan, model_limit, status, expires_at,
        CASE WHEN expires_at > NOW() AND status = 'active' THEN true ELSE false END as is_active
      FROM subscriptions WHERE user_id = $1 ORDER BY expires_at DESC LIMIT 1
    `, [user.id]);

    // Send welcome email
    sendEmail(user.email, 'Welcome to Stats Editor!', generateEmailTemplate('Welcome', `
      <h2 style="margin: 0 0 16px; color: #00b4ff; font-size: 20px; font-weight: 600;">Welcome!</h2>
      <p style="margin: 0 0 20px; color: #e2e8f0; font-size: 15px; line-height: 1.6;">Your email has been verified and your account is now active.</p>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 20px 0;">
        <tr>
          <td style="padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.1);">
            <span style="color: #94a3b8; font-size: 14px;">Email</span>
          </td>
          <td style="padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.1); text-align: right;">
            <span style="color: #e2e8f0; font-size: 14px; font-weight: 500;">${user.email}</span>
          </td>
        </tr>
        <tr>
          <td style="padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.1);">
            <span style="color: #94a3b8; font-size: 14px;">Trial Period</span>
          </td>
          <td style="padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.1); text-align: right;">
            <span style="color: #10b981; font-size: 14px; font-weight: 500;">${trialDays} days</span>
          </td>
        </tr>
        <tr>
          <td style="padding: 12px 0;">
            <span style="color: #94a3b8; font-size: 14px;">Models Limit</span>
          </td>
          <td style="padding: 12px 0; text-align: right;">
            <span style="color: #00b4ff; font-size: 14px; font-weight: 500;">10 models</span>
          </td>
        </tr>
      </table>
      <p style="margin: 20px 0 0; color: #64748b; font-size: 13px; text-align: center;">Upgrade to Premium for up to 50 models!</p>
    `));

    res.json({
      message: 'Email verified successfully',
      user: { id: user.id, email: user.email },
      token,
      subscription: subscription || null
    });

  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Resend verification code
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await getOne(
      'SELECT id, email FROM users WHERE email = $1 AND email_verified = false',
      [email.toLowerCase()]
    );

    if (!user) {
      return res.json({ message: 'If this email exists and is unverified, a new code has been sent' });
    }

    const verificationCode = generateVerificationCode();
    const codeExpires = new Date(Date.now() + 3600000);

    await query(
      'UPDATE users SET email_verification_code = $1, email_verification_expires = $2 WHERE id = $3',
      [verificationCode, codeExpires, user.id]
    );

    await sendEmail(user.email, 'Verify Your Email - Stats Editor', generateEmailTemplate('Verify Your Email', `
      <h2 style="margin: 0 0 16px; color: #00b4ff; font-size: 20px; font-weight: 600;">Verify Your Email</h2>
      <p style="margin: 0 0 20px; color: #e2e8f0; font-size: 15px; line-height: 1.6;">Here is your new verification code:</p>
      <div style="background: linear-gradient(135deg, #0f172a 0%, #1a1a2e 100%); padding: 24px; border-radius: 10px; text-align: center; margin: 24px 0; border: 1px solid rgba(0, 180, 255, 0.2);">
        <code style="color: #00b4ff; font-size: 36px; letter-spacing: 10px; font-weight: bold; font-family: 'SF Mono', Monaco, 'Courier New', monospace;">${verificationCode}</code>
      </div>
      <p style="margin: 0; color: #94a3b8; font-size: 13px;">This code expires in 1 hour.</p>
    `));

    res.json({ message: 'Verification code sent' });

  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Failed to resend code' });
  }
});

// Forgot password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await getOne('SELECT id, email FROM users WHERE email = $1', [email.toLowerCase()]);

    // Always return success to prevent email enumeration
    if (!user) {
      return res.json({ message: 'If this email exists, a reset code has been sent' });
    }

    // Use 6-digit code instead of long token
    const resetCode = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour

    await query(
      'UPDATE users SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3',
      [resetCode, expiresAt, user.id]
    );

    // Log code for debugging
    console.log(`📧 Reset code for ${user.email}: ${resetCode}`);

    // Send response IMMEDIATELY
    res.json({ message: 'If this email exists, a reset code has been sent' });

    // Send email in background (fire and forget)
    sendEmail(user.email, 'Password Reset - Stats Editor', generateEmailTemplate('Password Reset', `
      <h2 style="margin: 0 0 16px; color: #00b4ff; font-size: 20px; font-weight: 600;">Password Reset</h2>
      <p style="margin: 0 0 12px; color: #e2e8f0; font-size: 15px; line-height: 1.6;">You requested a password reset for your account.</p>
      <p style="margin: 0 0 20px; color: #e2e8f0; font-size: 15px; line-height: 1.6;">Your reset code:</p>
      <div style="background: linear-gradient(135deg, #0f172a 0%, #1a1a2e 100%); padding: 24px; border-radius: 10px; text-align: center; margin: 24px 0; border: 1px solid rgba(0, 180, 255, 0.2);">
        <code style="color: #00b4ff; font-size: 36px; letter-spacing: 10px; font-weight: bold; font-family: 'SF Mono', Monaco, 'Courier New', monospace;">${resetCode}</code>
      </div>
      <p style="margin: 0 0 8px; color: #94a3b8; font-size: 13px;">This code expires in 1 hour.</p>
      <p style="margin: 0; color: #64748b; font-size: 13px;">If you didn't request this, please ignore this email.</p>
    `)).catch(err => console.error('Background email error:', err));

    return; // Already sent response

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// Reset password with code (6-digit)
router.post('/reset-password', async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;

    if (!email || !token || !newPassword) {
      return res.status(400).json({ error: 'Email, code, and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Token is now a 6-digit code stored as plain text
    const user = await getOne(
      'SELECT id FROM users WHERE email = $1 AND password_reset_token = $2 AND password_reset_expires > NOW()',
      [email.toLowerCase(), token.trim()]
    );

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset code' });
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
