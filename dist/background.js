// Background Service Worker for OF Stats Editor Pro
// Handles API communication with backend

// Debug flag - set to false in production to disable all console logs
const DEBUG = false;
function log(...args) { if (DEBUG) console.log(...args); }
function logError(...args) { if (DEBUG) console.error(...args); }

const API_URL = 'https://stats-editor-production.up.railway.app/api';

// Token management
let authToken = null;

// ==================== API CACHE ====================
// In-memory cache to reduce redundant server requests
const apiCache = {};
const CACHE_TTL = {
  verifyAuth: 15 * 60 * 1000,          // 15 minutes
  getSubscriptionStatus: 15 * 60 * 1000, // 15 minutes
  getModels: 30 * 60 * 1000,            // 30 minutes (invalidated on add/remove)
  getPresets: 30 * 60 * 1000            // 30 minutes (invalidated on sync/save/delete)
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
      
      // Farmed models — comment status
      case 'checkFarmedModel':
        return await apiCheckFarmedModel(request.username);
      
      // AI Verdict for model score
      case 'getAIVerdict':
        return await apiGetAIVerdict(request.scoreData);

      // Fans actions
      case 'reportFans':
        return await apiReportFans(request.username, request.fansCount, request.fansText, request.reportDay);
      
      case 'getFans':
        return await apiGetFans(request.username);
      
      case 'batchGetFans':
        return await apiBatchGetFans(request.usernames);
      
      case 'getFansTrend':
        return await apiGetFansTrend(request.username, request.days);

      case 'getEngagementPercentile':
        return await apiGetEngagementPercentile(request.username, request.metrics);
      
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

// ==================== FARMED MODELS API ====================

async function apiCheckFarmedModel(username) {
  try {
    const response = await fetch(`${API_URL}/farmed-models/${encodeURIComponent(username)}`);
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Check farmed model error:', error);
    return { success: false, error: 'Network error' };
  }
}

// ==================== AI VERDICT (xAI Grok) ====================

async function apiGetAIVerdict(scoreData) {
  try {
    // Build clear fans description
    let fansDesc;
    if (scoreData.fansVisible && scoreData.fans > 0) {
      fansDesc = scoreData.fans + ' (ОТКРЫТЫ, видны всем)';
    } else if (!scoreData.fansVisible && scoreData.lastKnownFans) {
      fansDesc = 'СКРЫТЫ модельёю. Последние известные: ' + scoreData.lastKnownFans;
    } else if (!scoreData.fansVisible) {
      fansDesc = 'СКРЫТЫ модельёю, данных нет';
    } else {
      fansDesc = '0';
    }

    const prompt = `Профиль @${scoreData.username}:
Score: ${scoreData.score}/100 (${scoreData.grade})
Компоненты: MAT ${scoreData.components.maturity}/25, POP ${scoreData.components.popularity}/25, ORG ${scoreData.components.organicity}/25, ACT ${scoreData.components.activity}/15, TRS ${scoreData.components.transparency}/10
Фаны: ${fansDesc}
Лайки: ${scoreData.likes}, Посты: ${scoreData.posts}, Видео: ${scoreData.videos}, Стримы: ${scoreData.streams}
Возраст: ${scoreData.accountMonths} мес.${scoreData.price > 0 ? ' Подписка: ПЛАТНАЯ $' + scoreData.price + '/мес' + (scoreData.fansVisible && scoreData.fans > 0 ? ' (доход ~$' + Math.round(scoreData.price * scoreData.fans) + '/мес)' : '') : ' Подписка: FREE (бесплатная, дохода от подписки НЕТ)'}
Комментарии: ${scoreData.commentsOpen ? 'ОТКРЫТЫ' : scoreData.commentsClosed ? 'ЗАКРЫТЫ' : 'неизвестно'}
Флаги: ${scoreData.flags.join(', ') || 'нет'}`;

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer xai-PJt31Fwdznxy9kd5zFVw4Mba46X4zamDfk0KOCtiRjAfV9ugsWmoPp3D3Z47ePmZCBZJ6kCQGOPAr16v'
      },
      body: JSON.stringify({
        model: 'grok-4.20-beta-0309-non-reasoning',
        messages: [
          { role: 'system', content: 'Ты опытный аналитик профилей OnlyFans. Пиши кратко и по делу, своими словами — без пересказа флагов и метрик. Будь объективным. НЕ ВЫДУМЫВАЙ факты. Если в данных есть «Последние известные» фаны — используй эту цифру, не пиши просто «фаны скрыты». Не упоминай верификацию — она есть у всех. Не называй флаги по имени (Inflated Likes, Low Trust и т.д.) — описывай ситуацию своими словами. Скрытые фаны сами по себе НЕ подозрение на накрутку. Если фаны скрыты и нет «Последних известных» — оценивай размер аудитории ТОЛЬКО по лайкам: менее 5K лайков = маленькая аудитория, 5-50K = средняя, 50K+ = большая. НЕ ПИШИ «широкая аудитория» если лайков мало. Если подписка ПЛАТНАЯ и есть фаны — упомяни доход. Если подписка FREE — КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО упоминать доход, заработок, подписку, монетизацию, слово «бесплатный», слово «платная». Просто НЕ ПИШИ об этом. ФОРМАТ: 2-3 предложения, максимум 40 слов, на русском. ОБЯЗАТЕЛЬНО заканчивай выводом — что это значит для аудитории или качества аккаунта. НЕ начинай с имени/@username. Без markdown.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 200,
        temperature: 0.4
      })
    });

    if (!response.ok) {
      logError('OF Stats: xAI API error:', response.status);
      return { verdict: null };
    }

    const data = await response.json();
    const verdict = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return { verdict: verdict ? verdict.trim() : null };
  } catch (error) {
    logError('OF Stats: AI verdict error:', error);
    return { verdict: null };
  }
}

// ==================== FANS API ====================

async function apiReportFans(username, fansCount, fansText, reportDay) {
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
      body: JSON.stringify({ username, fansCount, fansText, reportDay })
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

async function apiGetFansTrend(username, days) {
  try {
    const headers = {};
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    const response = await fetch(`${API_URL}/fans/trend/${encodeURIComponent(username)}?days=${days || 90}`, { headers });
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Get fans trend error:', error);
    return { success: false, error: 'Network error' };
  }
}

async function apiGetEngagementPercentile(username, metrics) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await fetch(`${API_URL}/fans/percentile/${encodeURIComponent(username)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(metrics || {})
    });
    const data = await response.json();
    return { success: response.ok, ...data };
  } catch (error) {
    logError('OF Stats: Get engagement percentile error:', error);
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

// ==================== SUPPORT ====================

async function apiSendSupportEmail(subject, message) {
  try {
    const response = await fetch(`${API_URL}/auth/support`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
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
