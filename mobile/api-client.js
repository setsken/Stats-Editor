// ==================== MOBILE API CLIENT ====================
// On Orion (and other mobile MV3 browsers) the background service worker
// often never wakes up — chrome.runtime.sendMessage to it hangs indefinitely.
// This file mirrors background.js's API dispatch in the POPUP context and
// monkey-patches chrome.runtime.sendMessage so every existing call site
// transparently uses the local handler instead of round-tripping through SW.
//
// Loaded as a <script src="api-client.js"> tag in popup.html BEFORE popup.js
// so the patch is in place before any sendMessage call fires.

(function () {
  'use strict';

  const DEBUG = false;
  function log() { if (DEBUG) console.log.apply(console, arguments); }
  function logError() { if (DEBUG) console.error.apply(console, arguments); }

  const API_URL = 'https://stats-editor-production.up.railway.app/api';

  // Token state (kept in module scope, hydrated from chrome.storage)
  let authToken = null;
  let isRefreshing = false;
  let refreshPromise = null;

  // Load token on startup
  try {
    chrome.storage.local.get(['authToken'], (result) => {
      if (result.authToken) authToken = result.authToken;
    });
  } catch (e) {}

  // Lazily re-read the token from storage if our in-memory copy is empty.
  // Needed because popup-side mobileLogin saves the token to chrome.storage
  // but doesn't touch this file's `authToken` variable. Without this, the
  // very first authenticated request after login (e.g. getPresets) returns
  // "Not authenticated" until the user reopens the popup.
  async function ensureFreshToken() {
    if (authToken) return;
    try {
      var result = await chrome.storage.local.get(['authToken']);
      if (result.authToken) authToken = result.authToken;
    } catch (e) {}
  }

  // ===== Token refresh =====
  async function tryRefreshToken() {
    if (!authToken) return false;
    if (isRefreshing) {
      try { return await refreshPromise; } catch { return false; }
    }
    isRefreshing = true;
    refreshPromise = (async () => {
      try {
        const response = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' }
        });
        if (response.ok) {
          const data = await response.json();
          if (data.token) {
            authToken = data.token;
            try { await chrome.storage.local.set({ authToken: data.token }); } catch (e) {}
            return true;
          }
        }
        return false;
      } catch (error) { return false; }
      finally { isRefreshing = false; refreshPromise = null; }
    })();
    return refreshPromise;
  }

  async function logoutLocal() {
    authToken = null;
    try { await chrome.storage.local.remove(['authToken', 'userEmail', 'ofStatsPresets', 'ofStatsActivePreset']); } catch (e) {}
    return { success: true };
  }

  async function authFetch(url, options = {}) {
    await ensureFreshToken();
    const doFetch = () => {
      const headers = Object.assign({}, options.headers || {}, { 'Authorization': `Bearer ${authToken}` });
      return fetch(url, Object.assign({}, options, { headers }));
    };
    let response = await doFetch();
    if (response.status === 401) {
      const refreshed = await tryRefreshToken();
      if (refreshed) response = await doFetch();
      if (response.status === 401) await logoutLocal();
    }
    return response;
  }

  // ===== API cache =====
  const apiCache = {};
  const CACHE_TTL = {
    verifyAuth: 15 * 60 * 1000,
    getSubscriptionStatus: 5 * 60 * 1000,
    getModels: 30 * 60 * 1000,
    getPresets: 30 * 60 * 1000,
    getNotes: 10 * 60 * 1000,
    getNoteTags: 10 * 60 * 1000
  };
  function getCached(key) {
    const e = apiCache[key];
    if (!e) return null;
    if (Date.now() - e.time > (CACHE_TTL[key] || 0)) { delete apiCache[key]; return null; }
    return e.data;
  }
  function setCache(key, data) { apiCache[key] = { data, time: Date.now() }; }
  function clearCache(key) {
    if (key) delete apiCache[key];
    else Object.keys(apiCache).forEach(k => delete apiCache[k]);
  }

  // ===== AUTH API =====
  async function apiRegister(email, password) {
    try {
      const response = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await response.json();
      if (response.ok) {
        if (data.requiresVerification) return { success: true, requiresVerification: true, email: data.email };
        if (data.token) {
          authToken = data.token;
          try { await chrome.storage.local.set({ authToken: data.token, userEmail: data.user.email }); } catch (e) {}
          return { success: true, user: data.user, subscription: data.subscription };
        }
      }
      return { success: false, error: data.error || 'Registration failed' };
    } catch (error) {
      return { success: false, error: 'Network error. Please try again.' };
    }
  }

  async function apiLogin(email, password) {
    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await response.json();
      if (response.ok && data.token) {
        authToken = data.token;
        try { await chrome.storage.local.set({ authToken: data.token, userEmail: data.user.email }); } catch (e) {}
        return { success: true, user: data.user, subscription: data.subscription };
      } else {
        return { success: false, error: data.error || 'Login failed' };
      }
    } catch (error) {
      return { success: false, error: 'Network error. Please try again.' };
    }
  }

  async function apiVerifyAuth() {
    if (!authToken) return { success: false, error: 'Not authenticated', code: 'NO_TOKEN' };
    try {
      const response = await authFetch(`${API_URL}/auth/verify`);
      if (response.status === 401) return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
      const data = await response.json();
      if (response.ok) return { success: true, user: data.user, subscription: data.subscription, usage: data.usage };
      return { success: false, error: data.error };
    } catch (error) {
      return { success: false, error: 'Network error' };
    }
  }

  async function getAuthStatus() {
    try {
      const result = await chrome.storage.local.get(['authToken', 'userEmail']);
      if (result.authToken) authToken = result.authToken;
      return { success: true, isAuthenticated: !!result.authToken, email: result.userEmail || null };
    } catch (error) {
      return { success: true, isAuthenticated: false, email: null };
    }
  }

  async function apiForgotPassword(email) {
    try {
      const response = await fetch(`${API_URL}/auth/forgot-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await response.json();
      return { success: true, message: data.message };
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiResetPassword(email, token, newPassword) {
    try {
      const response = await fetch(`${API_URL}/auth/reset-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, token, newPassword })
      });
      const data = await response.json();
      if (response.ok) return { success: true, message: data.message };
      return { success: false, error: data.error || 'Failed to reset password' };
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiVerifyEmail(email, code) {
    try {
      const response = await fetch(`${API_URL}/auth/verify-email`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code })
      });
      const data = await response.json();
      if (response.ok && data.token) {
        authToken = data.token;
        try { await chrome.storage.local.set({ authToken: data.token, userEmail: data.user.email }); } catch (e) {}
        return { success: true, user: data.user, subscription: data.subscription };
      }
      return { success: false, error: data.error || 'Verification failed' };
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiResendVerification(email) {
    try {
      const response = await fetch(`${API_URL}/auth/resend-verification`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await response.json();
      return { success: response.ok, message: data.message };
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiApplyPromoCode(code) {
    if (!authToken) return { success: false, error: 'Not authenticated. Please log in first.' };
    try {
      const response = await authFetch(`${API_URL}/promo/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, product: 'stats_editor' })
      });
      const data = await response.json();
      if (!response.ok) return { success: false, error: data.error || 'Failed to apply promo code', code: data.code };
      return Object.assign({ success: true }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  // ===== SUBSCRIPTION API =====
  async function apiGetSubscriptionStatus() {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/subscription/status?product=stats_editor`);
      if (response.status === 401) return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiGetPlans() {
    try {
      const response = await fetch(`${API_URL}/subscription/plans?product=stats_editor`);
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiCreatePayment(plan, currency) {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/subscription/create-payment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, currency: currency || null })
      });
      const data = await response.json();
      if (response.ok) {
        return {
          success: true,
          paymentId: data.paymentId, providerPaymentId: data.providerPaymentId,
          payAddress: data.payAddress, payAmount: data.payAmount, payCurrency: data.payCurrency,
          invoiceUrl: data.invoiceUrl, expiresAt: data.expiresAt, status: data.status
        };
      }
      return { success: false, error: data.error || 'Failed to create payment' };
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiGetUpgradeInfo() {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/subscription/upgrade-info`);
      const data = await response.json();
      if (response.ok) return Object.assign({ success: true }, data);
      return { success: false, error: data.error || 'Failed to get upgrade info', code: data.code };
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiCreateUpgradePayment(currency) {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/subscription/create-upgrade-payment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currency: currency || null })
      });
      const data = await response.json();
      if (response.ok) {
        return {
          success: true,
          paymentId: data.paymentId, providerPaymentId: data.providerPaymentId,
          payAddress: data.payAddress, payAmount: data.payAmount, payCurrency: data.payCurrency,
          invoiceUrl: data.invoiceUrl, expiresAt: data.expiresAt, status: data.status,
          upgradePrice: data.upgradePrice, discount: data.discount
        };
      }
      return { success: false, error: data.error || 'Failed to create upgrade payment', code: data.code };
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiCheckPaymentStatus(paymentId) {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/subscription/payment-status/${paymentId}`);
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  // ===== MODELS API =====
  async function apiGetModels() {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/models`);
      if (response.status === 401) return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
      if (response.status === 403) {
        const data = await response.json();
        return { success: false, error: data.error, code: data.code };
      }
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiAddModel(username, displayName, avatarUrl) {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/models/add`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, displayName: displayName || null, avatarUrl: avatarUrl || null })
      });
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiRemoveModel(username) {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/models/${encodeURIComponent(username)}`, { method: 'DELETE' });
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiCheckModel(username) {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/models/check/${encodeURIComponent(username)}`);
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiCheckFarmedModel(username) {
    try {
      const response = await fetch(`${API_URL}/farmed-models/${encodeURIComponent(username)}`);
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  // ===== FANS API =====
  async function apiReportFans(username, fansCount, fansText, reportDay) {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/fans/report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, fansCount, fansText, reportDay })
      });
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiGetFans(username) {
    try {
      const headers = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const response = await fetch(`${API_URL}/fans/${encodeURIComponent(username)}`, { headers });
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiBatchGetFans(usernames) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const response = await fetch(`${API_URL}/fans/batch`, {
        method: 'POST', headers, body: JSON.stringify({ usernames })
      });
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiGetFansTrend(username, days) {
    try {
      const headers = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const response = await fetch(`${API_URL}/fans/trend/${encodeURIComponent(username)}?days=${days || 90}`, { headers });
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiGetEngagementPercentile(username, metrics) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const response = await fetch(`${API_URL}/fans/percentile/${encodeURIComponent(username)}`, {
        method: 'POST', headers, body: JSON.stringify(metrics || {})
      });
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  // ===== PRESETS API =====
  async function apiGetPresets() {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/presets`);
      if (response.status === 401) return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiSyncPresets(presets, activePreset) {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/presets/sync`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presets, activePreset })
      });
      if (response.status === 401) return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiSavePreset(name, presetData, active) {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/presets/${encodeURIComponent(name)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetData, active: !!active })
      });
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiDeletePreset(name) {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/presets/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiSetActivePreset(name) {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/presets/active/${encodeURIComponent(name || '__none__')}`, { method: 'PUT' });
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  // ===== ALERTS API =====
  async function apiReportAlerts(username, alerts) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const response = await fetch(`${API_URL}/alerts/report`, {
        method: 'POST', headers, body: JSON.stringify({ username, alerts })
      });
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiGetAlerts(username) {
    try {
      const response = await fetch(`${API_URL}/alerts/${encodeURIComponent(username)}`);
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  // ===== NOTES API =====
  async function apiGetNotes() {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/notes`);
      if (response.status === 401) return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiSyncNotes(notes, avatars) {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/notes/sync`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes, avatars })
      });
      if (response.status === 401) return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiSaveNote(username, text, tags, date, avatarUrl) {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/notes/${encodeURIComponent(username)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, tags, date, avatarUrl })
      });
      if (response.status === 401) return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiDeleteNote(username) {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/notes/${encodeURIComponent(username)}`, { method: 'DELETE' });
      if (response.status === 401) return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiGetNoteTags() {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/notes/tags`);
      if (response.status === 401) return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiSyncNoteTags(tags) {
    if (!authToken) return { success: false, error: 'Not authenticated' };
    try {
      const response = await authFetch(`${API_URL}/notes/tags`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags })
      });
      if (response.status === 401) return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  async function apiSendSupportEmail(subject, message) {
    try {
      const response = await authFetch(`${API_URL}/auth/support`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, message })
      });
      const data = await response.json();
      return Object.assign({ success: response.ok }, data);
    } catch (e) { return { success: false, error: 'Network error' }; }
  }

  // AI verdict — needs subscription check first
  async function apiGetAIVerdict(scoreData) {
    try {
      const lang = scoreData.lang || 'ru';
      const isRu = lang === 'ru';
      let fansDesc;
      if (scoreData.fansVisible && scoreData.fans > 0) {
        fansDesc = scoreData.fans + (isRu ? ' (ОТКРЫТЫ, видны всем)' : ' (PUBLIC, visible to all)');
      } else if (!scoreData.fansVisible && scoreData.lastKnownFans) {
        fansDesc = (isRu ? 'СКРЫТЫ модельёю. Последние известные: ' : 'HIDDEN by model. Last known: ') + scoreData.lastKnownFans;
      } else if (!scoreData.fansVisible) {
        fansDesc = isRu ? 'СКРЫТЫ модельёю, данных нет' : 'HIDDEN by model, no data';
      } else { fansDesc = '0'; }
      const prompt = isRu
        ? `Профиль @${scoreData.username}: Score: ${scoreData.score}/100 (${scoreData.grade}); Фаны: ${fansDesc}; Возраст: ${scoreData.accountMonths} мес.`
        : `Profile @${scoreData.username}: Score: ${scoreData.score}/100 (${scoreData.grade}); Fans: ${fansDesc}; Age: ${scoreData.accountMonths} months.`;
      const response = await authFetch(`${API_URL}/verdict`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, lang: isRu ? 'ru' : 'en' })
      });
      if (!response.ok) return { verdict: null };
      const data = await response.json();
      return { verdict: data.verdict || null };
    } catch (e) { return { verdict: null }; }
  }

  // ===== DISPATCH (mirrors background.js handleMessage) =====
  async function dispatchApi(request) {
    if (!request || !request.action) return undefined;
    // Hydrate token from storage if our in-memory copy is empty (post-login race).
    await ensureFreshToken();
    try {
      switch (request.action) {
        case 'register':       return await apiRegister(request.email, request.password);
        case 'login':          return await apiLogin(request.email, request.password);
        case 'logout':         clearCache(); return await logoutLocal();
        case 'verifyAuth': {
          const cached = getCached('verifyAuth');
          if (cached) return cached;
          const result = await apiVerifyAuth();
          if (result.success) setCache('verifyAuth', result);
          return result;
        }
        case 'getAuthStatus':  return await getAuthStatus();
        case 'forgotPassword': return await apiForgotPassword(request.email);
        case 'resetPassword':  return await apiResetPassword(request.email, request.token, request.newPassword);
        case 'verifyEmail':    return await apiVerifyEmail(request.email, request.code);
        case 'resendVerification': return await apiResendVerification(request.email);
        case 'applyPromoCode': {
          clearCache('getSubscriptionStatus'); clearCache('verifyAuth');
          return await apiApplyPromoCode(request.code);
        }
        case 'getSubscriptionStatus': {
          const cached = getCached('getSubscriptionStatus');
          if (cached) return cached;
          const result = await apiGetSubscriptionStatus();
          if (result.success) setCache('getSubscriptionStatus', result);
          return result;
        }
        case 'getPlans':         return await apiGetPlans();
        case 'createPayment':    return await apiCreatePayment(request.plan, request.currency);
        case 'getUpgradeInfo':   return await apiGetUpgradeInfo();
        case 'createUpgradePayment': return await apiCreateUpgradePayment(request.currency);
        case 'checkPaymentStatus':   return await apiCheckPaymentStatus(request.paymentId);
        case 'getModels': {
          const cached = getCached('getModels');
          if (cached) return cached;
          const result = await apiGetModels();
          if (result.success) setCache('getModels', result);
          return result;
        }
        case 'addModel':         clearCache('getModels'); return await apiAddModel(request.username, request.displayName, request.avatarUrl);
        case 'removeModel':      clearCache('getModels'); return await apiRemoveModel(request.username);
        case 'checkModel':       return await apiCheckModel(request.username);
        case 'checkFarmedModel': return await apiCheckFarmedModel(request.username);
        case 'getAIVerdict': {
          const subStatus = await apiGetSubscriptionStatus();
          if (!subStatus.success || !subStatus.subscription || subStatus.subscription.status !== 'active') {
            return { success: false, error: 'Subscription not active' };
          }
          return await apiGetAIVerdict(request.scoreData);
        }
        case 'openSubscriptionTab':
          try { chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') }); } catch (e) {}
          return { success: true };
        case 'reportFans':       return await apiReportFans(request.username, request.fansCount, request.fansText, request.reportDay);
        case 'getFans':          return await apiGetFans(request.username);
        case 'batchGetFans':     return await apiBatchGetFans(request.usernames);
        case 'getFansTrend':     return await apiGetFansTrend(request.username, request.days);
        case 'getEngagementPercentile': return await apiGetEngagementPercentile(request.username, request.metrics);
        case 'getPresets': {
          const cached = getCached('getPresets');
          if (cached) return cached;
          const result = await apiGetPresets();
          if (result.success) setCache('getPresets', result);
          return result;
        }
        case 'syncPresets':      clearCache('getPresets'); return await apiSyncPresets(request.presets, request.activePreset);
        case 'savePreset':       clearCache('getPresets'); return await apiSavePreset(request.name, request.presetData, request.active);
        case 'deletePreset':     clearCache('getPresets'); return await apiDeletePreset(request.name);
        case 'setActivePreset':  return await apiSetActivePreset(request.name);
        case 'reportAlerts':     return await apiReportAlerts(request.username, request.alerts);
        case 'getAlerts':        return await apiGetAlerts(request.username);
        case 'getNotes': {
          const cached = getCached('getNotes');
          if (cached) return cached;
          const result = await apiGetNotes();
          if (result.success) setCache('getNotes', result);
          return result;
        }
        case 'syncNotes':        clearCache('getNotes'); return await apiSyncNotes(request.notes, request.avatars);
        case 'saveNote':         clearCache('getNotes'); return await apiSaveNote(request.username, request.text, request.tags, request.date, request.avatarUrl);
        case 'deleteNote':       clearCache('getNotes'); return await apiDeleteNote(request.username);
        case 'getNoteTags': {
          const cached = getCached('getNoteTags');
          if (cached) return cached;
          const result = await apiGetNoteTags();
          if (result.success) setCache('getNoteTags', result);
          return result;
        }
        case 'syncNoteTags':     clearCache('getNoteTags'); return await apiSyncNoteTags(request.tags);
        case 'openSidePanel':    return { success: false, error: 'sidePanel API not available on this platform' };
        case 'closeSidePanel':   return { success: true };
        case 'clearCache':       clearCache(); return { success: true };
        case 'sendSupportEmail': return await apiSendSupportEmail(request.subject, request.message);
        default:                 return undefined; // unknown action — let original sendMessage handle
      }
    } catch (e) {
      logError('mobile dispatch error:', e);
      return { success: false, error: 'Internal error: ' + (e && e.message ? e.message : 'unknown') };
    }
  }

  // ===== MONKEY-PATCH chrome.runtime.sendMessage =====
  const origSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = function (...args) {
    // chrome.runtime.sendMessage(message[, options][, callback])
    // chrome.runtime.sendMessage(extensionId, message[, options][, callback])
    // We only intercept the message-first form (the only one popup.js uses).
    let message, callback;
    if (args.length >= 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
      message = args[0];
      // Last arg could be a callback
      const last = args[args.length - 1];
      if (typeof last === 'function') callback = last;
    }

    // If message has a known action, handle locally
    if (message && typeof message.action === 'string') {
      const known = [
        'register','login','logout','verifyAuth','getAuthStatus','forgotPassword',
        'resetPassword','verifyEmail','resendVerification','applyPromoCode',
        'getSubscriptionStatus','getPlans','createPayment','getUpgradeInfo',
        'createUpgradePayment','checkPaymentStatus','getModels','addModel',
        'removeModel','checkModel','checkFarmedModel','getAIVerdict',
        'openSubscriptionTab','reportFans','getFans','batchGetFans','getFansTrend',
        'getEngagementPercentile','getPresets','syncPresets','savePreset',
        'deletePreset','setActivePreset','reportAlerts','getAlerts','getNotes',
        'syncNotes','saveNote','deleteNote','getNoteTags','syncNoteTags',
        'openSidePanel','closeSidePanel','clearCache','sendSupportEmail'
      ];
      if (known.indexOf(message.action) !== -1) {
        const p = dispatchApi(message);
        if (callback) {
          p.then((r) => { try { callback(r); } catch (e) {} }, () => { try { callback(undefined); } catch (e) {} });
          return undefined;
        }
        return p;
      }
    }

    // Unknown action — fall back to original (may hit SW, but it's not API)
    return origSendMessage(...args);
  };

  // ===== MONKEY-PATCH chrome.tabs.sendMessage with default 5s timeout =====
  // On Orion mobile, sendMessage to a tab whose content script hasn't loaded
  // (or is sleeping) can hang forever. Every call site in popup.js does
  // `await chrome.tabs.sendMessage(...)` — without timeout, ANY of them can
  // freeze the popup. With this wrapper, the worst case is a 5s delay and
  // a null return (callers check for null/ignore).
  if (chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
    const origTabsSendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = function (...args) {
      // Detect callback signature (tabId, message, callback) or (tabId, message, options, callback)
      const last = args[args.length - 1];
      const hasCallback = typeof last === 'function';
      const callback = hasCallback ? last : null;
      const restArgs = hasCallback ? args.slice(0, -1) : args;

      const promise = origTabsSendMessage(...restArgs);
      const timed = Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(null), 5000))
      ]).catch(() => null);

      if (callback) {
        timed.then((r) => { try { callback(r); } catch (e) {} });
        return undefined;
      }
      return timed;
    };
  }

  log('OF Stats Mobile: api-client loaded, sendMessage patched (runtime + tabs)');
})();
