// Rate Limiting Middleware for Auth Routes
// Protects against brute-force attacks

const rateLimit = require('express-rate-limit');

// Constants
const RATE_LIMIT = {
  AUTH_WINDOW_MS: 15 * 60 * 1000,  // 15 minutes
  AUTH_MAX_REQUESTS: 10,           // 10 requests per window
  GENERAL_WINDOW_MS: 60 * 1000,    // 1 minute
  GENERAL_MAX_REQUESTS: 100        // 100 requests per minute
};

// Rate limiter for authentication routes (login, register, forgot-password)
const authLimiter = rateLimit({
  windowMs: RATE_LIMIT.AUTH_WINDOW_MS,
  max: RATE_LIMIT.AUTH_MAX_REQUESTS,
  message: {
    error: 'Too many attempts. Please try again in 15 minutes.',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfter: RATE_LIMIT.AUTH_WINDOW_MS / 1000
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  keyGenerator: (req) => {
    // Use IP + email (if provided) for more precise limiting
    const email = req.body?.email?.toLowerCase() || '';
    return `${req.ip}-${email}`;
  }
});

// Stricter limiter for password reset (prevents email enumeration attacks)
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 requests per hour
  message: {
    error: 'Too many password reset attempts. Please try again later.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// General API rate limiter
const generalLimiter = rateLimit({
  windowMs: RATE_LIMIT.GENERAL_WINDOW_MS,
  max: RATE_LIMIT.GENERAL_MAX_REQUESTS,
  message: {
    error: 'Too many requests. Please slow down.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = {
  authLimiter,
  passwordResetLimiter,
  generalLimiter,
  RATE_LIMIT
};
