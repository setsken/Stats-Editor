// Background Service Worker for OF Stats Editor Pro
// Handles API communication with backend

// Debug flag - set to false in production to disable all console logs
const DEBUG = false;
function log(...args) { if (DEBUG) console.log(...args); }
function logError(...args) { if (DEBUG) console.error(...args); }

const API_URL = 'https://stats-editor-production.up.railway.app/api';

// Token management
let authToken = null;
let isRefreshing = false;
let refreshPromise = null;

// ==================== TOKEN REFRESH ====================
// Try to refresh the token before logging out on 401
async function tryRefreshToken() {
  if (!authToken) return false;
  
  // Prevent multiple simultaneous refresh attempts
  if (isRefreshing) {
    try { return await refreshPromise; } catch { return false; }
  }
  
  isRefreshing = true;
  refreshPromise = (async () => {
    try {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.token) {
          authToken = data.token;
          await chrome.storage.local.set({ authToken: data.token });
          log('OF Stats: Token refreshed successfully');
          return true;
        }
      }
      return false;
    } catch (error) {
      logError('OF Stats: Token refresh failed:', error);
      return false;
    } finally {
      isRefreshing = false;
      refreshPromise = null;
    }
  })();
  
  return refreshPromise;
}

// Handle 401: try refresh first, only logout if refresh fails
async function handle401() {
  const refreshed = await tryRefreshToken();
  if (!refreshed) {
    await logout();
  }
  return refreshed;
}

// Proactive token refresh — check every 6 hours
setInterval(async () => {
  if (!authToken) return;
  try {
    // Decode token to check expiry
    const payload = JSON.parse(atob(authToken.split('.')[1]));
    const expiresIn = payload.exp * 1000 - Date.now();
    // Refresh if less than 7 days remaining
    if (expiresIn < 7 * 24 * 60 * 60 * 1000) {
      log('OF Stats: Token expiring soon, refreshing proactively');
      await tryRefreshToken();
    }
  } catch (e) {
    // ignore decode errors
  }
}, 6 * 60 * 60 * 1000);

// Auth-aware fetch: adds Authorization header, retries once on 401 after token refresh
async function authFetch(url, options = {}) {
  const doFetch = () => {
    const headers = { ...options.headers, 'Authorization': `Bearer ${authToken}` };
    return fetch(url, { ...options, headers });
  };
  
  let response = await doFetch();
  
  if (response.status === 401) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      response = await doFetch();
    }
    if (response.status === 401) {
      await logout();
    }
  }
  
  return response;
}

// ==================== API CACHE ====================
// In-memory cache to reduce redundant server requests
const apiCache = {};
const CACHE_TTL = {
  verifyAuth: 15 * 60 * 1000,          // 15 minutes
  getSubscriptionStatus: 5 * 60 * 1000, // 5 minutes
  getModels: 30 * 60 * 1000,            // 30 minutes (invalidated on add/remove)
  getPresets: 30 * 60 * 1000,           // 30 minutes (invalidated on sync/save/delete)
  getNotes: 10 * 60 * 1000,             // 10 minutes (invalidated on sync/save/delete)
  getNoteTags: 10 * 60 * 1000           // 10 minutes (invalidated on sync)
};

function getCached(key) {
  const entry = apiCache[key];
  if (!entry) return null;
  if (Date.now() - entry.time > (CACHE_TTL[key] || 0)) {
    delete apiCache[key];
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  apiCache[key] = { data, time: Date.now() };
}

function clearCache(key) {
  if (key) {
    delete apiCache[key];
  } else {
    Object.keys(apiCache).forEach(k => delete apiCache[k]);
  }
}

// Load token from storage on startup
chrome.storage.local.get(['authToken'], (result) => {
  if (result.authToken) {
    authToken = result.authToken;
    log('OF Stats: Auth token loaded from storage');
  }
});

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Handle async responses
  handleMessage(request, sender).then(sendResponse);
  return true; // Keep message channel open for async response
});

// ==================== EXTERNAL MESSAGES (SSO for Profile Stats) ====================
// Profile Stats can request the active token via cross-extension messaging.
// Whitelisted senders are declared in manifest.json "externally_connectable.ids".
// Every request opens a small confirmation window so the user explicitly
// approves before the token leaves Stats Editor.
const pendingSSOResponses = new Map(); // reqId -> { sendResponse, timeoutId, senderId }

chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      if (!request || request.action !== 'getStatsEditorToken') {
        sendResponse({ success: false, error: 'Unknown action' });
        return;
      }
      const stored = await chrome.storage.local.get(['authToken', 'userEmail']);
      if (!stored.authToken) {
        sendResponse({ success: false, error: 'Not signed in to Stats Editor', code: 'NOT_AUTHENTICATED' });
        return;
      }
      authToken = stored.authToken;

      // Open the confirmation window and remember the sendResponse so we can
      // reply once the user clicks Allow / Deny (or closes the window).
      const reqId = (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : String(Date.now()) + Math.random();
      const timeoutId = setTimeout(() => {
        const p = pendingSSOResponses.get(reqId);
        if (p) {
          pendingSSOResponses.delete(reqId);
          p.sendResponse({ success: false, error: 'Timed out waiting for confirmation', code: 'TIMEOUT' });
        }
      }, 120 * 1000);

      pendingSSOResponses.set(reqId, { sendResponse, timeoutId, senderId: sender.id });

      const email = encodeURIComponent(stored.userEmail || '');
      const W = 420;
      const H = 420;
      // Center on the primary display (workArea = screen minus taskbar).
      let left, top;
      try {
        const displays = await chrome.system.display.getInfo();
        const primary = displays.find(d => d.isPrimary) || displays[0];
        if (primary && primary.workArea) {
          left = Math.round(primary.workArea.left + (primary.workArea.width - W) / 2);
          top  = Math.round(primary.workArea.top  + (primary.workArea.height - H) / 2);
        }
      } catch (e) { /* permission missing — let Chrome pick a position */ }

      chrome.windows.create({
        url: chrome.runtime.getURL(`auth-confirm.html?id=${reqId}&email=${email}`),
        type: 'popup',
        width: W,
        height: H,
        ...(left != null && top != null ? { left, top } : {}),
        focused: true
      });
    } catch (e) {
      logError('OF Stats: SSO external message error:', e);
      sendResponse({ success: false, error: e.message });
    }
  })();
  return true; // async response
});

// Bridge from the in-extension auth-confirm.html: deliver Allow / Deny back to
// the waiting Profile Stats request.
async function handleSSODecision(request) {
  const p = pendingSSOResponses.get(request.id);
  if (!p) return { success: false, error: 'Unknown SSO request id' };
  clearTimeout(p.timeoutId);
  pendingSSOResponses.delete(request.id);
  if (!request.approved) {
    p.sendResponse({ success: false, error: 'Authorization denied by user', code: 'USER_DENIED' });
    return { success: true, delivered: 'denied' };
  }
  const stored = await chrome.storage.local.get(['authToken', 'userEmail']);
  if (!stored.authToken) {
    p.sendResponse({ success: false, error: 'Stats Editor session expired', code: 'TOKEN_EXPIRED' });
    return { success: true, delivered: 'no-token' };
  }
  p.sendResponse({
    success: true,
    token: stored.authToken,
    email: stored.userEmail || null,
    sentBy: p.senderId
  });
  return { success: true, delivered: 'approved' };
}

async function handleMessage(request, sender) {
  try {
    switch (request.action) {
      // Auth actions
      case 'register':
        return await apiRegister(request.email, request.password);
      
      case 'login':
        return await apiLogin(request.email, request.password);
      
      case 'logout':
        clearCache(); // Clear all cache on logout
        return await logout();
      
      case 'verifyAuth': {
        const cached = getCached('verifyAuth');
        if (cached) return cached;
        const result = await apiVerifyAuth();
        if (result.success) setCache('verifyAuth', result);
        return result;
      }
      
      case 'getAuthStatus':
        return await getAuthStatus();
      
      case 'forgotPassword':
        return await apiForgotPassword(request.email);
      
      case 'resetPassword':
        return await apiResetPassword(request.email, request.token, request.newPassword);
      
      case 'verifyEmail':
        return await apiVerifyEmail(request.email, request.code);
      
      case 'resendVerification':
        return await apiResendVerification(request.email);
      
      case 'applyPromoCode': {
        clearCache('getSubscriptionStatus');
        clearCache('verifyAuth');
        return await apiApplyPromoCode(request.code);
      }
      
      // Subscription actions
      case 'getSubscriptionStatus': {
        const cached = getCached('getSubscriptionStatus');
        if (cached) return cached;
        const result = await apiGetSubscriptionStatus();
        if (result.success) setCache('getSubscriptionStatus', result);
        return result;
      }
      
      case 'getPlans':
        return await apiGetPlans();
      
      case 'createPayment':
        return await apiCreatePayment(request.plan, request.currency);
      
      case 'getUpgradeInfo':
        return await apiGetUpgradeInfo();
      
      case 'createUpgradePayment':
        return await apiCreateUpgradePayment(request.currency);
      
      case 'checkPaymentStatus':
        return await apiCheckPaymentStatus(request.paymentId);
      
      // Models actions
      case 'getModels': {
        const cached = getCached('getModels');
        if (cached) return cached;
        const result = await apiGetModels();
        if (result.success) setCache('getModels', result);
        return result;
      }
      
      case 'addModel': {
        clearCache('getModels');
        return await apiAddModel(request.username, request.displayName, request.avatarUrl);
      }
      
      case 'removeModel': {
        clearCache('getModels');
        return await apiRemoveModel(request.username);
      }
      
      case 'checkModel':
        return await apiCheckModel(request.username);

      case 'openSubscriptionTab':
        chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
        return { success: true };

      // Presets actions (cloud sync)
      case 'getPresets': {
        const cached = getCached('getPresets');
        if (cached) return cached;
        const result = await apiGetPresets();
        if (result.success) setCache('getPresets', result);
        return result;
      }
      
      case 'syncPresets': {
        clearCache('getPresets');
        return await apiSyncPresets(request.presets, request.activePreset);
      }
      
      case 'savePreset': {
        clearCache('getPresets');
        return await apiSavePreset(request.name, request.presetData, request.active);
      }
      
      case 'deletePreset': {
        clearCache('getPresets');
        return await apiDeletePreset(request.name);
      }
      
      case 'setActivePreset':
        return await apiSetActivePreset(request.name);

      // Side panel actions
      case 'openSidePanel':
        // MOBILE-COMPAT: sidePanel API doesn't exist on mobile browsers — skip silently
        if (!chrome.sidePanel || typeof chrome.sidePanel.open !== 'function') {
          return { success: false, error: 'sidePanel API not available on this platform' };
        }
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab) {
            await chrome.sidePanel.open({ tabId: tab.id });
          }
          return { success: true };
        } catch (e) {
          return { success: false, error: e.message };
        }
      
      case 'closeSidePanel':
        // Close popup window will close side panel too
        return { success: true };
      
      case 'clearCache':
        clearCache();
        return { success: true };

      // From auth-confirm.html — user clicked Allow / Deny on the SSO popup.
      case 'sso-decision':
        return await handleSSODecision(request);
      
      case 'sendSupportEmail':
        return await apiSendSupportEmail(request.subject, request.message);
      
      default:
        return { success: false, error: 'Unknown action' };
    }
  } catch (error) {
    logError('OF Stats: Message handler error:', error);
    return { success: false, error: error.message };
  }
}

// Broadcast auth status to all OnlyFans tabs
// MOBILE-COMPAT: chrome.scripting.executeScript is unreliable on mobile —
// use pageLocalStorage handler via sendMessage. CRITICAL: do NOT await each
// message — on mobile (Orion), sendMessage to a tab whose content script
// hasn't loaded can hang for a long time. Fire-and-forget keeps the caller
// (apiLogin → popup) responsive.
async function broadcastAuthStatus(isAuthenticated) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://onlyfans.com/*' });
    const value = isAuthenticated ? 'authenticated' : 'not_authenticated';
    tabs.forEach((tab) => {
      try {
        // Fire-and-forget — the .catch swallows the "no receiver" error AND
        // any hang on mobile. We don't need the response here.
        const p = chrome.tabs.sendMessage(tab.id, {
          action: 'pageLocalStorage',
          op: 'set',
          key: 'ofStatsAuthStatus',
          value: value
        });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) { /* ignore */ }
    });
  } catch (e) {
    log('OF Stats: Could not broadcast auth status', e);
  }
}

// ==================== AUTH API ====================

async function apiRegister(email, password) {
  try {
    const response = await fetch(`${API_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      // Check if email verification is required
      if (data.requiresVerification) {
        return { success: true, requiresVerification: true, email: data.email };
      }
      
      // Direct registration (no verification)
      if (data.token) {
        authToken = data.token;
        await chrome.storage.local.set({ authToken: data.token, userEmail: data.user.email });
        await broadcastAuthStatus(true);
        return { success: true, user: data.user, subscription: data.subscription };
      }
    }
    
    return { success: false, error: data.error || 'Registration failed' };
  } catch (error) {
    logError('OF Stats: Register error:', error);
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
      await chrome.storage.local.set({ authToken: data.token, userEmail: data.user.email });
      await broadcastAuthStatus(true); // Broadcast to all tabs
      return { success: true, user: data.user, subscription: data.subscription };
    } else {
      return { success: false, error: data.error || 'Login failed' };
    }
  } catch (error) {
    logError('OF Stats: Login error:', error);
    return { success: false, error: 'Network error. Please try again.' };
  }
}

async function logout() {
  authToken = null;
  await chrome.storage.local.remove(['authToken', 'userEmail', 'ofStatsPresets', 'ofStatsActivePreset']);
  await broadcastAuthStatus(false); // Broadcast logout to all tabs
  return { success: true };
}

async function apiVerifyAuth() {
  if (!authToken) {
    await broadcastAuthStatus(false);
    return { success: false, error: 'Not authenticated', code: 'NO_TOKEN' };
  }
  
  try {
    const response = await authFetch(`${API_URL}/auth/verify`);
    
    if (response.status === 401) {
      return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
    }
    
    const data = await response.json();
    
    if (response.ok) {
      await broadcastAuthStatus(true); // User is authenticated
      return { success: true, user: data.user, subscription: data.subscription, usage: data.usage };
    } else {
      return { success: false, error: data.error };
    }
  } catch (error) {
    logError('OF Stats: Verify auth error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function getAuthStatus() {
  try {
    const result = await chrome.storage.local.get(['authToken', 'userEmail']);
    // Also update the local variable if token exists
    if (result.authToken) {
      authToken = result.authToken;
    }
    return {
      success: true,
      isAuthenticated: !!result.authToken,
      email: result.userEmail || null
    };
  } catch (error) {
    logError('getAuthStatus error:', error);
    return {
      success: true,
      isAuthenticated: false,
      email: null
    };
  }
}

async function apiForgotPassword(email) {
  try {
    const response = await fetch(`${API_URL}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    
    const data = await response.json();
    return { success: true, message: data.message };
  } catch (error) {
    logError('OF Stats: Forgot password error:', error);
    return { success: false, error: 'Network error. Please try again.' };
  }
}

async function apiResetPassword(email, token, newPassword) {
  try {
    const response = await fetch(`${API_URL}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, token, newPassword })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      return { success: true, message: data.message };
    } else {
      return { success: false, error: data.error || 'Failed to reset password' };
    }
  } catch (error) {
    logError('OF Stats: Reset password error:', error);
    return { success: false, error: 'Network error. Please try again.' };
  }
}

async function apiVerifyEmail(email, code) {
  try {
    const response = await fetch(`${API_URL}/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code })
    });
    
    const data = await response.json();
    
    if (response.ok && data.token) {
      authToken = data.token;
      await chrome.storage.local.set({ authToken: data.token, userEmail: data.user.email });
      await broadcastAuthStatus(true);
      return { success: true, user: data.user, subscription: data.subscription };
    } else {
      return { success: false, error: data.error || 'Verification failed' };
    }
  } catch (error) {
    logError('OF Stats: Verify email error:', error);
    return { success: false, error: 'Network error. Please try again.' };
  }
}

async function apiResendVerification(email) {
  try {
    const response = await fetch(`${API_URL}/auth/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    
    const data = await response.json();
    return { success: response.ok, message: data.message };
  } catch (error) {
    logError('OF Stats: Resend verification error:', error);
    return { success: false, error: 'Network error. Please try again.' };
  }
}

async function apiApplyPromoCode(code) {
  if (!authToken) {
    log('OF Stats: Promo - No auth token');
    return { success: false, error: 'Not authenticated. Please log in first.' };
  }
  
  try {
    log('OF Stats: Applying promo code:', code);
    // Tell the backend this code is being applied from the Stats Editor
    // extension, so a Profile Stats promo entered here gets rejected with
    // WRONG_PRODUCT instead of silently extending the user's PS sub.
    const response = await authFetch(`${API_URL}/promo/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, product: 'stats_editor' })
    });
    
    const data = await response.json();
    log('OF Stats: Promo response:', response.status, data);
    
    if (!response.ok) {
      return { success: false, error: data.error || 'Failed to apply promo code', code: data.code };
    }
    
    return { success: true, ...data };
  } catch (error) {
    logError('OF Stats: Apply promo code error:', error);
    return { success: false, error: 'Network error. Please try again.' };
  }
}

// ==================== SUBSCRIPTION API ====================

async function apiGetSubscriptionStatus() {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  
  try {
    // Scope to Stats Editor — without ?product the backend returns the user's
    // latest subscription across ALL products. After they buy Profile Stats
    // it'd return that row and the popup would render its "PROFILE_STATS"
    // plan as FREE (Stats Editor has no such plan key in its UI map).
    const response = await authFetch(`${API_URL}/subscription/status?product=stats_editor`);
    
    if (response.status === 401) {
      return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
    }
    
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Get subscription error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function apiGetPlans() {
  try {
    // Scope to Stats Editor plans only — backend now serves Profile Stats
    // ($15/mo) from the same endpoint, but that plan belongs in the
    // Profile Stats extension, not the Stats Editor upgrade screen.
    const response = await fetch(`${API_URL}/subscription/plans?product=stats_editor`);
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Get plans error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function apiCreatePayment(plan, currency = null) {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  
  try {
    const response = await authFetch(`${API_URL}/subscription/create-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, currency })
    });
    
    const data = await response.json();
    
    // Transform snake_case to camelCase for consistency
    if (response.ok) {
      return { 
        success: true,
        paymentId: data.paymentId,
        providerPaymentId: data.providerPaymentId,
        payAddress: data.payAddress,
        payAmount: data.payAmount,
        payCurrency: data.payCurrency,
        invoiceUrl: data.invoiceUrl,
        expiresAt: data.expiresAt,
        status: data.status
      };
    }
    
    return { success: false, error: data.error || 'Failed to create payment' };
  } catch (error) {
    logError('OF Stats: Create payment error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function apiGetUpgradeInfo() {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  try {
    const response = await authFetch(`${API_URL}/subscription/upgrade-info`);
    const data = await response.json();
    if (response.ok) {
      return { success: true, ...data };
    }
    return { success: false, error: data.error || 'Failed to get upgrade info', code: data.code };
  } catch (error) {
    logError('OF Stats: Get upgrade info error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function apiCreateUpgradePayment(currency = null) {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  try {
    const response = await authFetch(`${API_URL}/subscription/create-upgrade-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency })
    });
    const data = await response.json();
    if (response.ok) {
      return {
        success: true,
        paymentId: data.paymentId,
        providerPaymentId: data.providerPaymentId,
        payAddress: data.payAddress,
        payAmount: data.payAmount,
        payCurrency: data.payCurrency,
        invoiceUrl: data.invoiceUrl,
        expiresAt: data.expiresAt,
        status: data.status,
        upgradePrice: data.upgradePrice,
        discount: data.discount
      };
    }
    return { success: false, error: data.error || 'Failed to create upgrade payment', code: data.code };
  } catch (error) {
    logError('OF Stats: Create upgrade payment error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function apiCheckPaymentStatus(paymentId) {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  
  try {
    const response = await authFetch(`${API_URL}/subscription/payment-status/${paymentId}`);
    
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Check payment error:', error);
    return { success: false, error: 'Network error' };
  }
}

// ==================== MODELS API ====================

async function apiGetModels() {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  
  try {
    const response = await authFetch(`${API_URL}/models`);
    
    if (response.status === 401) {
      return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
    }
    
    if (response.status === 403) {
      const data = await response.json();
      return { success: false, error: data.error, code: data.code };
    }
    
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Get models error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function apiAddModel(username, displayName = null, avatarUrl = null) {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  
  try {
    const response = await authFetch(`${API_URL}/models/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, displayName, avatarUrl })
    });
    
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Add model error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function apiRemoveModel(username) {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  
  try {
    const response = await authFetch(`${API_URL}/models/${encodeURIComponent(username)}`, {
      method: 'DELETE'
    });
    
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Remove model error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function apiCheckModel(username) {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  
  try {
    const response = await authFetch(`${API_URL}/models/check/${encodeURIComponent(username)}`);
    
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Check model error:', error);
    return { success: false, error: 'Network error' };
  }
}

// ==================== PRESETS API (Cloud Sync) ====================

async function apiGetPresets() {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  
  try {
    const response = await authFetch(`${API_URL}/presets`);
    
    if (response.status === 401) {
      return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
    }
    
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Get presets error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function apiSyncPresets(presets, activePreset) {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  
  try {
    const response = await authFetch(`${API_URL}/presets/sync`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presets, activePreset })
    });
    
    if (response.status === 401) {
      return { success: false, error: 'Session expired', code: 'TOKEN_EXPIRED' };
    }
    
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Sync presets error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function apiSavePreset(name, presetData, active = false) {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  
  try {
    const response = await authFetch(`${API_URL}/presets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presetData, active })
    });
    
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Save preset error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function apiDeletePreset(name) {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  
  try {
    const response = await authFetch(`${API_URL}/presets/${encodeURIComponent(name)}`, {
      method: 'DELETE'
    });
    
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Delete preset error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function apiSetActivePreset(name) {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  
  try {
    const response = await authFetch(`${API_URL}/presets/active/${encodeURIComponent(name || '__none__')}`, {
      method: 'PUT'
    });
    
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Set active preset error:', error);
    return { success: false, error: 'Network error' };
  }
}

// ==================== SUPPORT ====================

async function apiSendSupportEmail(subject, message) {
  try {
    const response = await authFetch(`${API_URL}/auth/support`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, message })
    });
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Send support email error:', error);
    return { success: false, error: 'Network error' };
  }
}

// ==================== UTILITIES ====================

// MOBILE-COMPAT: chrome.alarms is unavailable on mobile browsers (Orion etc.).
// On mobile, token refresh happens lazily via tryRefreshToken() inside other
// API calls — the missed periodic refresh has no user-visible impact.
if (chrome.alarms && typeof chrome.alarms.create === 'function') {
  // Refresh token periodically via alarm (every 3 days)
  try { chrome.alarms.create('refreshToken', { periodInMinutes: 60 * 24 * 3 }); } catch (e) {}
  try {
    chrome.alarms.onAlarm.addListener(async (alarm) => {
      if (alarm.name === 'refreshToken' && authToken) {
        log('OF Stats: Periodic token refresh...');
        await tryRefreshToken();
      }
    });
  } catch (e) {}
}

log('OF Stats: Background service worker initialized');
