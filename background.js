// Background Service Worker for OF Stats Editor Pro
// Handles API communication with backend

// Debug flag - set to false in production to disable all console logs
const DEBUG = false;
function log(...args) { if (DEBUG) console.log(...args); }
function logError(...args) { if (DEBUG) console.error(...args); }

const API_URL = 'https://stats-editor-production.up.railway.app/api';

// Token management
let authToken = null;

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

async function handleMessage(request, sender) {
  try {
    switch (request.action) {
      // Auth actions
      case 'register':
        return await apiRegister(request.email, request.password);
      
      case 'login':
        return await apiLogin(request.email, request.password);
      
      case 'logout':
        return await logout();
      
      case 'verifyAuth':
        return await apiVerifyAuth();
      
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
      
      case 'applyPromoCode':
        return await apiApplyPromoCode(request.code);
      
      // Subscription actions
      case 'getSubscriptionStatus':
        return await apiGetSubscriptionStatus();
      
      case 'getPlans':
        return await apiGetPlans();
      
      case 'createPayment':
        return await apiCreatePayment(request.plan, request.currency);
      
      case 'checkPaymentStatus':
        return await apiCheckPaymentStatus(request.paymentId);
      
      // Models actions
      case 'getModels':
        return await apiGetModels();
      
      case 'addModel':
        return await apiAddModel(request.username, request.displayName, request.avatarUrl);
      
      case 'removeModel':
        return await apiRemoveModel(request.username);
      
      case 'checkModel':
        return await apiCheckModel(request.username);
      
      // Fans actions
      case 'reportFans':
        return await apiReportFans(request.username, request.fansCount, request.fansText);
      
      case 'getFans':
        return await apiGetFans(request.username);
      
      case 'batchGetFans':
        return await apiBatchGetFans(request.usernames);
      
      // Presets actions (cloud sync)
      case 'getPresets':
        return await apiGetPresets();
      
      case 'syncPresets':
        return await apiSyncPresets(request.presets, request.activePreset);
      
      case 'savePreset':
        return await apiSavePreset(request.name, request.presetData, request.active);
      
      case 'deletePreset':
        return await apiDeletePreset(request.name);
      
      case 'setActivePreset':
        return await apiSetActivePreset(request.name);
      
      // Side panel actions
      case 'openSidePanel':
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
      
      default:
        return { success: false, error: 'Unknown action' };
    }
  } catch (error) {
    logError('OF Stats: Message handler error:', error);
    return { success: false, error: error.message };
  }
}

// Broadcast auth status to all OnlyFans tabs
async function broadcastAuthStatus(isAuthenticated) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://onlyfans.com/*' });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (status) => {
            localStorage.setItem('ofStatsAuthStatus', status ? 'authenticated' : 'not_authenticated');
            // Note: log() is not available in page context
          },
          args: [isAuthenticated]
        });
      } catch (e) {
        // Tab might not be ready, ignore
      }
    }
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
  await chrome.storage.local.remove(['authToken', 'userEmail']);
  await broadcastAuthStatus(false); // Broadcast logout to all tabs
  return { success: true };
}

async function apiVerifyAuth() {
  if (!authToken) {
    await broadcastAuthStatus(false);
    return { success: false, error: 'Not authenticated', code: 'NO_TOKEN' };
  }
  
  try {
    const response = await fetch(`${API_URL}/auth/verify`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    
    if (response.status === 401) {
      // Token expired or invalid
      await logout();
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
    const response = await fetch(`${API_URL}/promo/apply`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ code })
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
    const response = await fetch(`${API_URL}/subscription/status`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    
    if (response.status === 401) {
      await logout();
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
    const response = await fetch(`${API_URL}/subscription/plans`);
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
    const response = await fetch(`${API_URL}/subscription/create-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
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

async function apiCheckPaymentStatus(paymentId) {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  
  try {
    const response = await fetch(`${API_URL}/subscription/payment-status/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    
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
    const response = await fetch(`${API_URL}/models`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    
    if (response.status === 401) {
      await logout();
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
    const response = await fetch(`${API_URL}/models/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
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
    const response = await fetch(`${API_URL}/models/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${authToken}` }
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
    const response = await fetch(`${API_URL}/models/check/${encodeURIComponent(username)}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Check model error:', error);
    return { success: false, error: 'Network error' };
  }
}

// ==================== FANS API ====================

async function apiReportFans(username, fansCount, fansText) {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  
  try {
    const response = await fetch(`${API_URL}/fans/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ username, fansCount, fansText })
    });
    
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Report fans error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function apiGetFans(username) {
  try {
    const headers = {};
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    const response = await fetch(`${API_URL}/fans/${encodeURIComponent(username)}`, { headers });
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Get fans error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function apiBatchGetFans(usernames) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    const response = await fetch(`${API_URL}/fans/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ usernames })
    });
    
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Batch get fans error:', error);
    return { success: false, error: 'Network error' };
  }
}

// ==================== PRESETS API (Cloud Sync) ====================

async function apiGetPresets() {
  if (!authToken) {
    return { success: false, error: 'Not authenticated' };
  }
  
  try {
    const response = await fetch(`${API_URL}/presets`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    
    if (response.status === 401) {
      await logout();
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
    const response = await fetch(`${API_URL}/presets/sync`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ presets, activePreset })
    });
    
    if (response.status === 401) {
      await logout();
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
    const response = await fetch(`${API_URL}/presets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
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
    const response = await fetch(`${API_URL}/presets/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${authToken}` }
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
    const response = await fetch(`${API_URL}/presets/active/${encodeURIComponent(name || '__none__')}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Set active preset error:', error);
    return { success: false, error: 'Network error' };
  }
}

// ==================== UTILITIES ====================

// Refresh token periodically (every 6 days to be safe before 7 day expiry)
chrome.alarms.create('refreshToken', { periodInMinutes: 60 * 24 * 6 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'refreshToken' && authToken) {
    log('OF Stats: Refreshing auth token...');
    const result = await apiVerifyAuth();
    if (!result.success) {
      log('OF Stats: Token refresh failed, user needs to re-login');
    }
  }
});

log('OF Stats: Background service worker initialized');
