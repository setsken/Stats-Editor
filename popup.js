// ==================== AUTH SYSTEM ====================

// Debug flag - set to false in production to disable all console logs
const DEBUG = false;
function log(...args) { if (DEBUG) log(...args); }
function logError(...args) { if (DEBUG) logError(...args); }

// Auth State
let currentUser = null;
let currentSubscription = null;
let currentModels = [];
let uniqueModelsThisPeriod = 0; // Unique models added this subscription period
let selectedPlan = null;
let currentPaymentId = null;
let paymentCheckInterval = null;
let pendingEmail = null; // For verification/reset flows
let currentModelAvatarUrl = null; // Current model's avatar URL
let listenersInitialized = false; // Flag to prevent duplicate event listeners
let notifications = []; // Notifications array

// Screen Elements
const loadingScreen = document.getElementById('loadingScreen');
const loginScreen = document.getElementById('loginScreen');
const registerScreen = document.getElementById('registerScreen');
const subscriptionScreen = document.getElementById('subscriptionScreen');
const paymentScreen = document.getElementById('paymentScreen');
const mainApp = document.getElementById('mainApp');
const resetCodeScreen = document.getElementById('resetCodeScreen');
const verifyEmailScreen = document.getElementById('verifyEmailScreen');

// Auth Form Elements
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const loginEmail = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const loginError = document.getElementById('loginError');
const registerEmail = document.getElementById('registerEmail');
const registerPassword = document.getElementById('registerPassword');
const registerConfirm = document.getElementById('registerConfirm');
const registerError = document.getElementById('registerError');
const showRegisterLink = document.getElementById('showRegister');
const showLoginLink = document.getElementById('showLogin');
const logoutLink = document.getElementById('logoutLink');

// User Menu Elements
const headerMenuBtn = document.getElementById('headerMenuBtn');
const userMenuDropdown = document.getElementById('userMenuDropdown');
const userMenuEmail = document.getElementById('userMenuEmail');
const userMenuPlan = document.getElementById('userMenuPlan');
const modelsCountEl = document.getElementById('modelsCount');
const modelsLimitEl = document.getElementById('modelsLimit');
const manageModelsBtn = document.getElementById('manageModelsBtn');
const upgradeBtn = document.getElementById('upgradeBtn');
const logoutBtn = document.getElementById('logoutBtn');

// Models Modal Elements
const modelsModalOverlay = document.getElementById('modelsModalOverlay');
const modelsList = document.getElementById('modelsList');
const modalModelsCount = document.getElementById('modalModelsCount');
const modalModelsLimit = document.getElementById('modalModelsLimit');
const modelsModalClose = document.getElementById('modelsModalClose');

// Forgot password elements
const forgotPasswordScreen = document.getElementById('forgotPasswordScreen');
const forgotPasswordForm = document.getElementById('forgotPasswordForm');
const forgotPasswordLink = document.getElementById('forgotPasswordLink');
const backToLoginLink = document.getElementById('backToLogin');

// Show specific screen
function showScreen(screenId) {
  const screens = [loadingScreen, loginScreen, registerScreen, subscriptionScreen, paymentScreen, mainApp, forgotPasswordScreen, resetCodeScreen, verifyEmailScreen, document.getElementById('networkScreen')];
  screens.forEach(screen => {
    if (screen) screen.style.display = 'none';
  });
  
  const targetScreen = document.getElementById(screenId);
  if (targetScreen) {
    targetScreen.style.display = screenId === 'mainApp' ? 'block' : 'flex';
  }
  
  // Re-setup password toggles when showing screens with password fields
  if (['loginScreen', 'registerScreen', 'resetCodeScreen'].includes(screenId)) {
    setTimeout(() => setupPasswordToggles(), 50);
  }
  
  // Save current screen state for persistence (except loading screen)
  if (screenId !== 'loadingScreen') {
    chrome.storage.local.set({ 
      popupScreen: screenId,
      popupPendingEmail: pendingEmail || null,
      popupPaymentId: currentPaymentId || null,
      popupSelectedPlan: selectedPlan || null
    });
  }
}

// Initialize Auth
async function initAuth() {
  showScreen('loadingScreen');
  
  // Load notifications
  await loadNotifications();
  
  try {
    // Check for saved popup state (for verification/reset/payment flows)
    const savedState = await chrome.storage.local.get(['popupScreen', 'popupPendingEmail', 'popupPaymentId', 'popupSelectedPlan']);
    
    // If there's a pending payment flow, restore it
    if (savedState.popupScreen === 'paymentScreen' && savedState.popupPaymentId) {
      currentPaymentId = savedState.popupPaymentId;
      selectedPlan = savedState.popupSelectedPlan;
      await restorePaymentScreen();
      return;
    }
    
    // If there's a pending verification or reset flow, restore it
    if (savedState.popupScreen && ['verifyEmailScreen', 'resetCodeScreen', 'forgotPasswordScreen'].includes(savedState.popupScreen)) {
      pendingEmail = savedState.popupPendingEmail;
      
      // Update email display for verification screen
      if (savedState.popupScreen === 'verifyEmailScreen' && pendingEmail) {
        const emailDisplay = document.getElementById('verifyEmailDisplay');
        if (emailDisplay) emailDisplay.textContent = pendingEmail;
      }
      // Update email display for reset code screen
      if (savedState.popupScreen === 'resetCodeScreen' && pendingEmail) {
        const emailDisplay = document.getElementById('resetEmailDisplay');
        if (emailDisplay) emailDisplay.textContent = pendingEmail;
      }
      
      showScreen(savedState.popupScreen);
      return;
    }
    
    // First try to get auth status directly from storage (faster, works even if service worker is asleep)
    const storageData = await chrome.storage.local.get(['authToken', 'userEmail']);
    
    if (!storageData.authToken) {
      // No token, show login
      log('OF Stats: No auth token found');
      showScreen('loginScreen');
      return;
    }
    
    log('OF Stats: Token found, verifying...');
    
    // Token exists, now verify with backend (with timeout)
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Connection timeout')), 5000)
    );
    
    let verifyResult;
    try {
      const verifyPromise = chrome.runtime.sendMessage({ action: 'verifyAuth' });
      verifyResult = await Promise.race([verifyPromise, timeoutPromise]);
    } catch (e) {
      // Network error or timeout - don't logout, just use cached data
      log('OF Stats: Verify failed (network issue), using cached auth');
      verifyResult = { success: true, networkError: true };
    }
    
    log('OF Stats: Verify result:', verifyResult);
    
    // Only logout if explicitly told token is invalid (not for network errors)
    if (!verifyResult || (!verifyResult.success && !verifyResult.networkError)) {
      // Check if it's a real auth error (not network)
      if (verifyResult && verifyResult.code === 'TOKEN_EXPIRED') {
        // Token actually expired on server - logout
        await chrome.storage.local.remove(['authToken', 'userEmail']);
        showScreen('loginScreen');
        return;
      }
      // For network errors, try to continue with cached data
      if (verifyResult && verifyResult.error === 'Network error') {
        log('OF Stats: Network error during verify, continuing with cached auth');
        // Try to get cached subscription data
        const cachedSub = await chrome.storage.local.get(['ofStatsSubscription']);
        if (cachedSub.ofStatsSubscription) {
          currentSubscription = cachedSub.ofStatsSubscription;
          currentUser = { email: storageData.userEmail };
        }
      } else {
        // Unknown error - show login
        await chrome.storage.local.remove(['authToken', 'userEmail']);
        showScreen('loginScreen');
        return;
      }
    }
    
    currentUser = verifyResult.user;
    currentSubscription = verifyResult.subscription;
    
    // Save subscription status to storage for content.js to check
    await chrome.storage.local.set({ 
      ofStatsSubscription: currentSubscription,
      ofStatsSubscriptionActive: hasActiveSubscription()
    });
    
    // Check subscription status
    if (!hasActiveSubscription()) {
      // Disable plugin and clear fake values
      await disablePluginDueToExpiredSubscription();
      
      await loadPlans();
      showScreen('subscriptionScreen');
      document.getElementById('currentUserEmail').textContent = currentUser.email;
      
      // Update expired text and badge based on status
      const expiredText = document.getElementById('subExpiredText');
      const expiredBadge = document.getElementById('subExpiredBadge');
      const authTitle = document.querySelector('#subscriptionScreen .auth-title');
      
      // Show badge and set title for expired scenario
      if (authTitle) authTitle.textContent = 'Subscription Required';
      if (expiredBadge) expiredBadge.style.display = '';
      
      if (currentSubscription && currentSubscription.status === 'expired') {
        if (expiredText) expiredText.textContent = 'Your subscription has expired';
        if (expiredBadge) expiredBadge.textContent = 'Subscription Expired';
      } else if (currentSubscription && (currentSubscription.status === 'trial_expired' || currentSubscription.plan === 'trial')) {
        if (expiredText) expiredText.textContent = 'Your trial has expired';
        if (expiredBadge) expiredBadge.textContent = 'Trial Expired';
      } else {
        if (expiredText) expiredText.textContent = 'Your subscription has expired';
        if (expiredBadge) expiredBadge.textContent = 'Expired';
      }
      return;
    }
    
    // Load models
    await loadUserModels();
    
    // Set localStorage flag for inject-early.js that subscription is active
    try {
      const tabs = await chrome.tabs.query({ url: '*://*.onlyfans.com/*' });
      for (const tab of tabs) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              localStorage.setItem('ofStatsSubActive', 'true');
            }
          });
        } catch (e) {}
      }
    } catch (e) {}
    
    // Update UI with user info
    updateUserUI();
    
    // Show main app
    showScreen('mainApp');
    
    // Initialize the main app
    initMainApp();
    
  } catch (error) {
    logError('Auth init error:', error);
    // Show login screen on any error
    showScreen('loginScreen');
    
    // If it was a timeout, show a message
    if (error.message === 'Connection timeout') {
      const loginError = document.getElementById('loginError');
      if (loginError) {
        loginError.textContent = 'Connection timeout. Please try again.';
        loginError.style.display = 'block';
      }
    }
  }
}

// Check if user has active subscription
// IMPORTANT: We trust the server's isActive flag, NOT local date checks
// This prevents users from manipulating their computer's clock to extend subscriptions
function hasActiveSubscription() {
  if (!currentSubscription) return false;
  
  // SECURITY: Trust server's isActive flag - it's calculated using server time (NOW())
  // The server query: CASE WHEN expires_at > NOW() AND status = 'active' THEN true ELSE false END
  // This cannot be manipulated by changing local computer time
  if (typeof currentSubscription.isActive === 'boolean') {
    return currentSubscription.isActive;
  }
  
  // Fallback: check status field (also set by server)
  // Only allow 'active' or 'trial' status
  return currentSubscription.status === 'active' || currentSubscription.status === 'trial';
}

// Disable plugin when subscription expires
async function disablePluginDueToExpiredSubscription() {
  log('OF Stats: Disabling plugin due to expired subscription');
  
  // Get current settings
  const result = await chrome.storage.local.get('ofStatsSettings');
  const settings = result.ofStatsSettings || {};
  
  // Disable the plugin
  settings.enabled = false;
  await chrome.storage.local.set({ ofStatsSettings: settings });
  
  // Update subscription status in storage
  await chrome.storage.local.set({ 
    ofStatsSubscriptionActive: false 
  });
  
  // Also set localStorage flag for inject-early.js (it can't access chrome.storage)
  // and clear all cached data from localStorage
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.onlyfans.com/*' });
    for (const tab of tabs) {
      try {
        // Execute script in tab to set localStorage and clear caches
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            localStorage.setItem('ofStatsSubActive', 'false');
            localStorage.removeItem('ofStatsCache');
            localStorage.removeItem('ofStatsEarningStats');
            localStorage.removeItem('ofStatsEarningsData');
          }
        });
        // Send resetChanges message to restore original values
        await chrome.tabs.sendMessage(tab.id, { action: 'resetChanges' });
        // Also send applyChanges with disabled settings to ensure plugin is off
        await chrome.tabs.sendMessage(tab.id, { action: 'applyChanges', settings: { enabled: false } });
      } catch (e) {
        // Tab might not have content script loaded
      }
    }
  } catch (e) {
    log('OF Stats: Could not notify tabs:', e);
  }
}

// Check subscription and redirect if expired
async function checkSubscriptionAndRedirect() {
  // Refresh subscription status from server
  const result = await chrome.runtime.sendMessage({ action: 'getSubscriptionStatus' });
  if (result.success && result.subscription) {
    currentSubscription = result.subscription;
  }
  
  // Save subscription status to storage for content.js to check
  const isActive = hasActiveSubscription();
  await chrome.storage.local.set({ 
    ofStatsSubscription: currentSubscription,
    ofStatsSubscriptionActive: isActive
  });
  
  if (!isActive) {
    // Disable plugin and clear fake values
    await disablePluginDueToExpiredSubscription();
    
    await loadPlans();
    showScreen('subscriptionScreen');
    
    // Update email
    if (currentUser) {
      document.getElementById('currentUserEmail').textContent = currentUser.email;
    }
    
    const expiredText = document.getElementById('subExpiredText');
    const expiredBadge = document.getElementById('subExpiredBadge');
    const authTitle = document.querySelector('#subscriptionScreen .auth-title');
    
    // Show badge and restore title for expired scenario
    if (authTitle) authTitle.textContent = 'Subscription Required';
    if (expiredBadge) expiredBadge.style.display = '';
    
    if (currentSubscription && currentSubscription.status === 'expired') {
      if (expiredText) expiredText.textContent = 'Your subscription has expired';
      if (expiredBadge) expiredBadge.textContent = 'Subscription Expired';
    } else if (currentSubscription && (currentSubscription.status === 'trial_expired' || currentSubscription.plan === 'trial')) {
      if (expiredText) expiredText.textContent = 'Your trial has expired';
      if (expiredBadge) expiredBadge.textContent = 'Trial Expired';
    } else {
      if (expiredText) expiredText.textContent = 'Your subscription has expired';
      if (expiredBadge) expiredBadge.textContent = 'Expired';
    }
    return false;
  }
  return true;
}

// Update UI with user info
function updateUserUI() {
  if (currentUser) {
    const emailEl = document.getElementById('userMenuEmail');
    if (emailEl) emailEl.textContent = currentUser.email;
  }
  
  if (currentSubscription) {
    // Backend sends 'plan' field, not 'plan_type'
    const plan = currentSubscription.plan || currentSubscription.plan_type || 'free';
    const planName = plan === 'trial' ? 'TRIAL' : 
                     plan === 'plus' ? 'PLUS' :
                     plan === 'pro' ? 'PRO' : 'FREE';
    
    const planEl = document.getElementById('userMenuPlan');
    if (planEl) planEl.textContent = planName;
    
    // Update logo subtitle with plan name
    const logoSubtitle = document.getElementById('logoSubtitle');
    if (logoSubtitle) logoSubtitle.textContent = planName;
    
    // Update subscription expiry date in dropdown
    updateSubscriptionExpiry();
    
    // Check for expiring subscription and notify
    checkSubscriptionExpiryNotification();
    
    // Update model limits (null or 999999 means unlimited)
    // Show unique models used this period, not just active count
    const limit = currentSubscription.modelLimit || currentSubscription.model_limit || 0;
    const used = uniqueModelsThisPeriod; // Unique models this subscription period
    
    const countEl = document.getElementById('modelsCount');
    const limitEl = document.getElementById('modelsLimit');
    const modalCountEl = document.getElementById('modalModelsCount');
    const modalLimitEl = document.getElementById('modalModelsLimit');
    
    if (countEl) countEl.textContent = used;
    if (limitEl) limitEl.textContent = (limit === null || limit >= 999999) ? '?' : limit;
    if (modalCountEl) modalCountEl.textContent = used;
    if (modalLimitEl) modalLimitEl.textContent = (limit === null || limit >= 999999) ? '?' : limit;
  }
}

// Check if subscription is expiring soon and add notification
async function checkSubscriptionExpiryNotification() {
  if (!currentSubscription) return;
  
  const expiresAt = currentSubscription.expires_at || currentSubscription.expiresAt || 
                    currentSubscription.ends_at || currentSubscription.endsAt;
  if (!expiresAt) return;
  
  const expiryDate = new Date(expiresAt);
  const now = new Date();
  const daysLeft = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
  
  // Check if we already notified about this expiry
  const storageKey = `expiryNotified_${expiryDate.toISOString().split('T')[0]}`;
  const result = await chrome.storage.local.get(storageKey);
  
  if (result[storageKey]) return; // Already notified
  
  // Notify if 3 days or less remaining
  if (daysLeft <= 3 && daysLeft > 0) {
    await addNotification('warning', 'Subscription Expiring Soon', 
      `Your subscription expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Renew now to continue using all features.`);
    await chrome.storage.local.set({ [storageKey]: true });
  } else if (daysLeft <= 0) {
    await addNotification('warning', 'Subscription Expired', 
      'Your subscription has expired. Please renew to continue using Stats Editor Pro.');
    await chrome.storage.local.set({ [storageKey]: true });
  }
}

// Load user models
async function loadUserModels() {
  try {
    const result = await chrome.runtime.sendMessage({ action: 'getModels' });
    if (result.success) {
      currentModels = result.models || [];
      uniqueModelsThisPeriod = result.uniqueThisPeriod || currentModels.length;
      
      // Load locally stored avatars and merge with models
      const stored = await chrome.storage.local.get('modelAvatars');
      const avatars = stored.modelAvatars || {};
      
      currentModels = currentModels.map(model => ({
        ...model,
        avatar_url: model.avatar_url || avatars[model.username] || null
      }));
    }
  } catch (error) {
    logError('Error loading models:', error);
    currentModels = [];
    uniqueModelsThisPeriod = 0;
  }
}

// Save avatar locally for a model
async function saveModelAvatarLocally(username, avatarUrl) {
  if (!avatarUrl) return;
  try {
    const stored = await chrome.storage.local.get('modelAvatars');
    const avatars = stored.modelAvatars || {};
    avatars[username] = avatarUrl;
    await chrome.storage.local.set({ modelAvatars: avatars });
  } catch (error) {
    logError('Error saving avatar locally:', error);
  }
}

// Load subscription plans
async function loadPlans() {
  try {
    const result = await chrome.runtime.sendMessage({ action: 'getPlans' });
    if (result.success && result.plans) {
      renderPlans(result.plans.filter(p => p.id !== 'trial'));
    }
  } catch (error) {
    logError('Error loading plans:', error);
  }
}

// Render plans
function renderPlans(plans) {
  const container = document.getElementById('plansContainer');
  if (!container) return;
  
  // Define features for each plan
  const planFeatures = {
    plus: [
      { text: 'Up to 10 models', included: true },
      { text: 'Statistics editing', included: true },
      { text: 'Fans graph editing', included: true },
    ],
    pro: [
      { text: 'Up to 50 models', included: true },
      { text: 'Statistics editing', included: true },
      { text: 'Fans graph editing', included: true },
    ]
  };
  
  container.innerHTML = plans.map(plan => {
    // Normalize plan name
    const planId = plan.id || plan.name.toLowerCase();
    const displayName = planId === 'basic' ? 'Plus' : plan.name;
    const normalizedId = planId === 'basic' ? 'plus' : planId;
    const features = planFeatures[normalizedId] || planFeatures.plus;
    const isPopular = normalizedId === 'pro';
    
    return `
    <div class="plan-card ${isPopular ? 'popular' : ''}" data-plan="${planId}">
      ${isPopular ? '<span class="popular-badge">BEST VALUE</span>' : ''}
      <div class="plan-header">
        <span class="plan-name">${displayName}</span>
        <span class="plan-price">$${plan.price}<span class="plan-period">/mo</span></span>
      </div>
      <div class="plan-features">
        ${features.map(f => `
          <div class="plan-feature-item ${f.included ? 'included' : 'not-included'}">
            <svg class="feature-check" viewBox="0 0 24 24" width="14" height="14">
              ${f.included 
                ? '<path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
                : '<path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
              }
            </svg>
            <span>${f.text}</span>
          </div>
        `).join('')}
      </div>
      <button class="plan-select-btn">${isPopular ? 'Get Pro' : 'Get Plus'}</button>
    </div>
  `;
  }).join('');
  
  // Add click handlers
  container.querySelectorAll('.plan-card').forEach(card => {
    card.addEventListener('click', () => selectPlan(card.dataset.plan));
  });
}

// Select plan
async function selectPlan(planId) {
  selectedPlan = planId;
  
  // Update UI
  document.querySelectorAll('.plan-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.plan === planId);
  });
  
  // Show network selection screen (plus/basic = $30, pro/premium = $50)
  const price = (planId === 'plus' || planId === 'basic') ? 30 : 50;
  document.getElementById('networkPlanPrice').textContent = `Pay $${price} USDT`;
  document.getElementById('exactAmount').textContent = `$${price}`;
  
  showScreen('networkScreen');
}

// Select network and create payment
async function selectNetwork(networkId) {
  try {
    const result = await chrome.runtime.sendMessage({ 
      action: 'createPayment', 
      plan: selectedPlan,
      currency: networkId
    });
    
    if (!result.success) {
      // Check if it's an "active subscription" message
      if (result.error && result.error.includes('active subscription')) {
        showInfoModal('Subscription Active', result.error, 'info');
      } else {
        showInfoModal('Payment Error', result.error || 'Failed to create payment', 'error');
      }
      return;
    }
    
    currentPaymentId = result.paymentId;
    
    // Show payment screen
    showScreen('paymentScreen');
    
    // Reset button and status to initial state
    const checkBtn = document.getElementById('checkPaymentBtn');
    const statusEl = document.getElementById('paymentStatus');
    if (checkBtn) {
      checkBtn.style.display = '';
      checkBtn.disabled = false;
      checkBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" width="18" height="18">
          <path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Verify Payment</span>
      `;
    }
    if (statusEl) {
      statusEl.style.display = 'none';
    }
    
    // Update payment info
    const planName = (selectedPlan === 'plus' || selectedPlan === 'basic') ? 'Plus Plan - $30' : 'Pro Plan - $50';
    document.getElementById('paymentPlanName').textContent = planName;
    
    // Show exact USDT amount
    const price = (selectedPlan === 'plus' || selectedPlan === 'basic') ? 30 : 50;
    document.getElementById('paymentAmount').textContent = `${price} USDT`;
    
    if (result.payAddress) {
      document.getElementById('paymentAddressText').textContent = result.payAddress;
      
      // Save payment address for restoration
      await chrome.storage.local.set({ popupPayAddress: result.payAddress });
      
      // Generate QR code
      generatePaymentQR(result.payAddress);
    }
    
    // Save and start expiration timer - use REAL time from NOWPayments
    // We must show actual time because payment will expire on their server
    if (result.expiresAt) {
      await chrome.storage.local.set({ popupPaymentExpires: result.expiresAt });
      startPaymentTimer(result.expiresAt);
      
      // Warn user if time is less than 10 minutes
      const timeLeft = new Date(result.expiresAt).getTime() - Date.now();
      if (timeLeft < 10 * 60 * 1000) {
        const minutes = Math.floor(timeLeft / 60000);
        log(`Warning: Only ${minutes} minutes to complete payment!`);
      }
    } else {
      // Default 15 minutes if no expiration provided
      const defaultExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await chrome.storage.local.set({ popupPaymentExpires: defaultExpires });
      startPaymentTimer(defaultExpires);
    }
    
    // Start checking payment status
    startPaymentStatusCheck(result.paymentId);
    
  } catch (error) {
    logError('Create payment error:', error);
    showInfoModal('Network Error', 'Network error. Please try again.', 'error');
  }
}

// Auto-check interval for payment status
let paymentAutoCheckInterval = null;

// Check payment once (called by button)
async function checkPaymentOnce(paymentId, isAutoCheck = false) {
  const checkBtn = document.getElementById('checkPaymentBtn');
  const statusEl = document.getElementById('paymentStatus');
  
  // On first manual click, hide button and start auto-checking
  if (!isAutoCheck) {
    checkBtn.style.display = 'none';
    // Start auto-checking every 10 seconds
    if (paymentAutoCheckInterval) clearInterval(paymentAutoCheckInterval);
    paymentAutoCheckInterval = setInterval(() => checkPaymentOnce(paymentId, true), 10000);
  }
  
  // Show checking status
  statusEl.style.display = 'flex';
  statusEl.innerHTML = `
    <div class="payment-status-icon waiting">
      <div class="auth-btn-loader"></div>
    </div>
    <span>Verifying payment... This may take a few minutes.</span>
  `;
  
  try {
    const result = await chrome.runtime.sendMessage({ 
      action: 'checkPaymentStatus', 
      paymentId: paymentId 
    });
    
    log('Payment status check:', result);
    
    // Check if payment is completed
    // Backend returns 'completed' only if payment is fully confirmed OR >= 98% paid
    if (result.success && result.status && 
        ['finished', 'confirmed', 'complete', 'paid', 'completed'].includes(result.status.toLowerCase())) {
      // Payment confirmed!
      if (paymentTimerInterval) {
        clearInterval(paymentTimerInterval);
      }
      if (paymentAutoCheckInterval) {
        clearInterval(paymentAutoCheckInterval);
      }
      
      // Clear payment state from storage
      await chrome.storage.local.remove(['popupPaymentId', 'popupSelectedPlan', 'popupPayAddress', 'popupPaymentExpires']);
      
      // Refresh subscription status
      const subStatus = await chrome.runtime.sendMessage({ action: 'getSubscriptionStatus' });
      if (subStatus.subscription) {
        currentSubscription = subStatus.subscription;
        await chrome.storage.local.set({ 
          ofStatsSubscription: currentSubscription,
          ofStatsSubscriptionActive: true
        });
        
        // Set localStorage flag for inject-early.js
        try {
          const tabs = await chrome.tabs.query({ url: '*://*.onlyfans.com/*' });
          for (const tab of tabs) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                  localStorage.setItem('ofStatsSubActive', 'true');
                }
              });
            } catch (e) {}
          }
        } catch (e) {}
      }
      
      await loadUserModels();
      updateUserUI();
      
      // Show success
      checkBtn.style.display = 'none';
      statusEl.innerHTML = `
        <div class="payment-status-icon success">
          <svg viewBox="0 0 24 24" fill="none" width="24" height="24">
            <path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <span style="color: var(--success);">Payment confirmed!</span>
      `;
      
      setTimeout(() => {
        showScreen('mainApp');
        initMainApp();
      }, 2000);
      
    } else if (result.success && result.status && result.status.toLowerCase() === 'partial') {
      // Partial payment - user paid less than required (< 98%)
      statusEl.innerHTML = `
        <div class="payment-status-icon waiting" style="background: var(--warning);">
          <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
            <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </div>
        <span style="color: var(--warning);">Incomplete payment detected. Please send the full amount.</span>
      `;
    } else {
      // Payment not yet confirmed - keep waiting, auto-check will continue
      statusEl.innerHTML = `
        <div class="payment-status-icon waiting">
          <div class="auth-btn-loader"></div>
        </div>
        <span>Waiting for payment confirmation... Checking automatically.</span>
      `;
    }
  } catch (error) {
    logError('Payment check error:', error);
    // On error, show error message but continue auto-checking
    statusEl.innerHTML = `
      <div class="payment-status-icon waiting">
        <div class="auth-btn-loader"></div>
      </div>
      <span>Connection error. Retrying automatically...</span>
    `;
  }
}

// Start payment status checking (removed auto-check - now manual only)
function startPaymentStatusCheck(paymentId) {
  // Clear any existing interval
  if (paymentCheckInterval) {
    clearInterval(paymentCheckInterval);
  }
  
  // Set up the check button handler
  const checkBtn = document.getElementById('checkPaymentBtn');
  if (checkBtn) {
    checkBtn.onclick = () => checkPaymentOnce(paymentId);
  }
}

// Generate QR code for payment address
function generatePaymentQR(address) {
  const qrContainer = document.getElementById('paymentQr');
  if (!qrContainer) return;
  
  // Create QR code using a simple canvas-based approach
  const size = 140;
  qrContainer.innerHTML = `
    <div class="qr-code-container">
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(address)}&bgcolor=0f1535&color=ffffff&margin=8" 
           alt="QR Code" 
           class="qr-code-image"
           width="${size}" 
           height="${size}" />
    </div>
  `;
}

// Payment timer interval
let paymentTimerInterval = null;

// Start payment expiration timer
function startPaymentTimer(expiresAt) {
  // Clear any existing timer
  if (paymentTimerInterval) {
    clearInterval(paymentTimerInterval);
  }
  
  const timerEl = document.getElementById('paymentTimer');
  const timeLeftEl = document.getElementById('paymentTimeLeft');
  
  if (!timerEl || !timeLeftEl) return;
  
  const updateTimer = () => {
    const now = Date.now();
    const expires = new Date(expiresAt).getTime();
    const diff = expires - now;
    
    if (diff <= 0) {
      // Timer expired
      clearInterval(paymentTimerInterval);
      timeLeftEl.textContent = 'Expired';
      timerEl.classList.add('expired');
      
      // Auto-redirect to network selection after a moment
      setTimeout(async () => {
        await clearPaymentState();
        showScreen('networkScreen');
      }, 2000);
      return;
    }
    
    // Calculate minutes and seconds
    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    
    timeLeftEl.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    
    // Add warning class when under 2 minutes
    if (diff < 120000) {
      timerEl.classList.add('expired');
    } else {
      timerEl.classList.remove('expired');
    }
  };
  
  // Update immediately and then every second
  updateTimer();
  paymentTimerInterval = setInterval(updateTimer, 1000);
}

// Clear payment state helper
async function clearPaymentState() {
  if (paymentCheckInterval) {
    clearInterval(paymentCheckInterval);
  }
  if (paymentTimerInterval) {
    clearInterval(paymentTimerInterval);
  }
  if (paymentAutoCheckInterval) {
    clearInterval(paymentAutoCheckInterval);
  }
  await chrome.storage.local.remove(['popupPaymentId', 'popupSelectedPlan', 'popupPayAddress', 'popupPaymentExpires']);
  currentPaymentId = null;
}

// Restore payment screen state after popup reopen
async function restorePaymentScreen() {
  showScreen('paymentScreen');
  
  // Reset button and status to initial state
  const checkBtn = document.getElementById('checkPaymentBtn');
  const statusEl = document.getElementById('paymentStatus');
  if (checkBtn) {
    checkBtn.style.display = '';
    checkBtn.disabled = false;
    checkBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" width="18" height="18">
        <path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Verify Payment</span>
    `;
  }
  if (statusEl) {
    statusEl.style.display = 'none';
  }
  
  // Update plan name
  const planName = (selectedPlan === 'plus' || selectedPlan === 'basic') ? 'Plus Plan - $30' : 'Pro Plan - $50';
  document.getElementById('paymentPlanName').textContent = planName;
  
  // Get saved payment data from storage
  const savedData = await chrome.storage.local.get(['popupPayAddress', 'popupPaymentExpires']);
  
  const price = (selectedPlan === 'plus' || selectedPlan === 'basic') ? 30 : 50;
  document.getElementById('paymentAmount').textContent = `${price} USDT`;
  
  if (savedData.popupPayAddress) {
    document.getElementById('paymentAddressText').textContent = savedData.popupPayAddress;
    generatePaymentQR(savedData.popupPayAddress);
  }
  
  // Restore timer
  if (savedData.popupPaymentExpires) {
    const expires = new Date(savedData.popupPaymentExpires).getTime();
    if (expires > Date.now()) {
      startPaymentTimer(savedData.popupPaymentExpires);
    } else {
      // Payment expired
      document.getElementById('paymentTimeLeft').textContent = 'Expired';
      document.getElementById('paymentTimer').classList.add('expired');
      setTimeout(async () => {
        await clearPaymentState();
        showScreen('networkScreen');
      }, 2000);
      return;
    }
  }
  
  // Resume payment status checking
  startPaymentStatusCheck(currentPaymentId);
}

// Setup password toggle functionality
function setupPasswordToggles() {
  const toggleBtns = document.querySelectorAll('.password-toggle');
  
  toggleBtns.forEach(btn => {
    // Remove old listeners by cloning
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    
    newBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const targetId = newBtn.getAttribute('data-target');
      const input = document.getElementById(targetId);
      
      if (input) {
        if (input.type === 'password') {
          input.type = 'text';
          newBtn.classList.add('showing');
        } else {
          input.type = 'password';
          newBtn.classList.remove('showing');
        }
      }
    });
  });
}

// Setup Auth Event Listeners
function setupAuthListeners() {
  // Setup password toggles
  setupPasswordToggles();
  
  // Show register form
  if (showRegisterLink) {
    showRegisterLink.addEventListener('click', (e) => {
      e.preventDefault();
      showScreen('registerScreen');
    });
  }
  
  // Show login form
  if (showLoginLink) {
    showLoginLink.addEventListener('click', (e) => {
      e.preventDefault();
      showScreen('loginScreen');
    });
  }
  
  // Show forgot password form
  if (forgotPasswordLink) {
    forgotPasswordLink.addEventListener('click', (e) => {
      e.preventDefault();
      showScreen('forgotPasswordScreen');
    });
  }
  
  // Back to login from forgot password
  if (backToLoginLink) {
    backToLoginLink.addEventListener('click', (e) => {
      e.preventDefault();
      showScreen('loginScreen');
    });
  }
  
  // Forgot password form submit
  if (forgotPasswordForm) {
    forgotPasswordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await handleForgotPassword();
    });
  }
  
  // Reset code form submit
  const resetCodeForm = document.getElementById('resetCodeForm');
  if (resetCodeForm) {
    resetCodeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await handleResetPassword();
    });
  }
  
  // Resend reset code
  const resendResetCode = document.getElementById('resendResetCode');
  if (resendResetCode) {
    resendResetCode.addEventListener('click', async (e) => {
      e.preventDefault();
      await handleForgotPassword();
    });
  }
  
  // Back to forgot password from reset code
  const backToForgot = document.getElementById('backToForgot');
  if (backToForgot) {
    backToForgot.addEventListener('click', (e) => {
      e.preventDefault();
      showScreen('forgotPasswordScreen');
    });
  }
  
  // Verify email form submit
  const verifyEmailForm = document.getElementById('verifyEmailForm');
  if (verifyEmailForm) {
    verifyEmailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await handleVerifyEmail();
    });
  }
  
  // Resend verification code
  const resendVerifyCode = document.getElementById('resendVerifyCode');
  if (resendVerifyCode) {
    resendVerifyCode.addEventListener('click', async (e) => {
      e.preventDefault();
      await resendVerificationCode();
    });
  }
  
  // Back to register from verify email
  const backToRegister = document.getElementById('backToRegister');
  if (backToRegister) {
    backToRegister.addEventListener('click', (e) => {
      e.preventDefault();
      showScreen('registerScreen');
    });
  }
  
  // Login form submit
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await handleLogin();
    });
  }
  
  // Register form submit
  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await handleRegister();
    });
  }
  
  // Logout links
  if (logoutLink) {
    logoutLink.addEventListener('click', async (e) => {
      e.preventDefault();
      await handleLogout();
    });
  }
  
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      userMenuDropdown.style.display = 'none';
      const overlay = document.getElementById('dropdownOverlay');
      if (overlay) overlay.classList.remove('active');
      await handleLogout();
    });
  }
  
  // Payment back button - show custom modal
  const paymentBackBtn = document.getElementById('paymentBackBtn');
  if (paymentBackBtn) {
    paymentBackBtn.addEventListener('click', (e) => {
      e.preventDefault();
      // Show custom confirmation modal
      document.getElementById('cancelPaymentOverlay').classList.add('active');
    });
  }
  
  // Cancel payment modal - Stay button
  const cancelPaymentNo = document.getElementById('cancelPaymentNo');
  if (cancelPaymentNo) {
    cancelPaymentNo.addEventListener('click', () => {
      document.getElementById('cancelPaymentOverlay').classList.remove('active');
    });
  }
  
  // Cancel payment modal - Leave button
  const cancelPaymentYes = document.getElementById('cancelPaymentYes');
  if (cancelPaymentYes) {
    cancelPaymentYes.addEventListener('click', async () => {
      document.getElementById('cancelPaymentOverlay').classList.remove('active');
      await clearPaymentState();
      await loadPlans();
      showScreen('subscriptionScreen');
    });
  }
  
  // Close cancel payment modal on overlay click
  const cancelPaymentOverlay = document.getElementById('cancelPaymentOverlay');
  if (cancelPaymentOverlay) {
    cancelPaymentOverlay.addEventListener('click', (e) => {
      if (e.target === cancelPaymentOverlay) {
        cancelPaymentOverlay.classList.remove('active');
      }
    });
  }
  
  // Back buttons
  const subscriptionBackBtn = document.getElementById('subscriptionBackBtn');
  if (subscriptionBackBtn) {
    subscriptionBackBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      // Go back to main app even with expired subscription
      // User can view but not enable the plugin
      await loadUserModels();
      updateUserUI();
      showScreen('mainApp');
      // Initialize without subscription redirect check
      initMainApp(true); // skipSubscriptionCheck = true
    });
  }
  
  const verifyBackBtn = document.getElementById('verifyBackBtn');
  if (verifyBackBtn) {
    verifyBackBtn.addEventListener('click', (e) => {
      e.preventDefault();
      pendingEmail = null;
      chrome.storage.local.remove(['popupScreen', 'popupPendingEmail']);
      showScreen('registerScreen');
    });
  }
  
  const forgotBackBtn = document.getElementById('forgotBackBtn');
  if (forgotBackBtn) {
    forgotBackBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showScreen('loginScreen');
    });
  }
  
  const resetCodeBackBtn = document.getElementById('resetCodeBackBtn');
  if (resetCodeBackBtn) {
    resetCodeBackBtn.addEventListener('click', (e) => {
      e.preventDefault();
      pendingEmail = null;
      chrome.storage.local.remove(['popupScreen', 'popupPendingEmail']);
      showScreen('loginScreen');
    });
  }
  
  // Promo code apply
  const applyPromoBtn = document.getElementById('applyPromoBtn');
  if (applyPromoBtn) {
    applyPromoBtn.addEventListener('click', async () => {
      await handleApplyPromoCode();
    });
  }
  
  const promoCodeInput = document.getElementById('promoCodeInput');
  if (promoCodeInput) {
    promoCodeInput.addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        await handleApplyPromoCode();
      }
    });
  }
  
  // Network selection
  const networkBackBtn = document.getElementById('networkBackBtn');
  if (networkBackBtn) {
    networkBackBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showScreen('subscriptionScreen');
      loadPlans(); // Reload plans when going back
    });
  }
  
  document.querySelectorAll('.network-card').forEach(card => {
    card.addEventListener('click', async () => {
      // Update selection UI
      document.querySelectorAll('.network-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      
      // Create payment with selected network
      await selectNetwork(card.dataset.network);
    });
  });

  // Copy address button
  const copyAddressBtn = document.getElementById('copyAddressBtn');
  if (copyAddressBtn) {
    copyAddressBtn.addEventListener('click', () => {
      const address = document.getElementById('paymentAddressText').textContent;
      navigator.clipboard.writeText(address);
      copyAddressBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" width="16" height="16"><path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      setTimeout(() => {
        copyAddressBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" width="16" height="16"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4C2.89543 15 2 14.1046 2 13V4C2 2.89543 2.89543 2 4 2H13C14.1046 2 15 2.89543 15 4V5" stroke="currentColor" stroke-width="2"/></svg>`;
      }, 2000);
    });
  }
  
  // Get or create dropdown overlay
  let dropdownOverlay = document.getElementById('dropdownOverlay');
  if (!dropdownOverlay) {
    dropdownOverlay = document.createElement('div');
    dropdownOverlay.id = 'dropdownOverlay';
    dropdownOverlay.className = 'dropdown-overlay';
    document.body.appendChild(dropdownOverlay);
  }
  
  // Helper to close all dropdowns
  function closeAllDropdowns() {
    if (userMenuDropdown) userMenuDropdown.style.display = 'none';
    const notificationsPanel = document.getElementById('notificationsPanel');
    if (notificationsPanel) notificationsPanel.style.display = 'none';
    dropdownOverlay.classList.remove('active');
  }
  
  // Close dropdowns when clicking overlay (use mousedown to handle drag scenarios)
  dropdownOverlay.addEventListener('mousedown', closeAllDropdowns);
  
  // Prevent clicks on dropdowns from closing them (both mousedown and click for fallback listeners)
  if (userMenuDropdown) {
    userMenuDropdown.addEventListener('mousedown', (e) => e.stopPropagation());
    userMenuDropdown.addEventListener('click', (e) => e.stopPropagation());
  }
  const notificationsPanelForClick = document.getElementById('notificationsPanel');
  if (notificationsPanelForClick) {
    notificationsPanelForClick.addEventListener('mousedown', (e) => e.stopPropagation());
    notificationsPanelForClick.addEventListener('click', (e) => e.stopPropagation());
  }
  
  // User menu toggle
  if (headerMenuBtn) {
    headerMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = userMenuDropdown.style.display !== 'none';
      
      // Close notifications if open
      const notificationsPanel = document.getElementById('notificationsPanel');
      if (notificationsPanel) notificationsPanel.style.display = 'none';
      
      if (isVisible) {
        userMenuDropdown.style.display = 'none';
        dropdownOverlay.classList.remove('active');
      } else {
        userMenuDropdown.style.display = 'block';
        dropdownOverlay.classList.add('active');
      }
    });
  }
  
  // Expand to side panel button
  const expandPanelBtn = document.getElementById('expandPanelBtn');
  if (expandPanelBtn) {
    expandPanelBtn.addEventListener('click', async () => {
      try {
        // Open side panel directly (requires user gesture)
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          await chrome.sidePanel.open({ tabId: tab.id });
          // Close the popup after opening side panel
          window.close();
        }
      } catch (e) {
        log('Could not open side panel:', e);
        // Fallback: show toast with error
        showToast('Could not open side panel', 'error');
      }
    });
  }
  
  // Collapse side panel button (close panel)
  const collapsePanelBtn = document.getElementById('collapsePanelBtn');
  if (collapsePanelBtn) {
    collapsePanelBtn.addEventListener('click', async () => {
      try {
        // Close side panel
        window.close();
      } catch (e) {
        log('Could not close side panel:', e);
      }
    });
  }
  
  // Close menu on outside click (overlay handles this now, but keep as fallback)
  document.addEventListener('click', (e) => {
    if (userMenuDropdown && !userMenuDropdown.contains(e.target) && e.target !== headerMenuBtn) {
      userMenuDropdown.style.display = 'none';
      if (dropdownOverlay) dropdownOverlay.classList.remove('active');
    }
  });
  
  // Manage models
  if (manageModelsBtn) {
    manageModelsBtn.addEventListener('click', () => {
      userMenuDropdown.style.display = 'none';
      const overlay = document.getElementById('dropdownOverlay');
      if (overlay) overlay.classList.remove('active');
      showModelsModal();
    });
  }
  
  // Upgrade button
  if (upgradeBtn) {
    upgradeBtn.addEventListener('click', async () => {
      userMenuDropdown.style.display = 'none';
      const overlay = document.getElementById('dropdownOverlay');
      if (overlay) overlay.classList.remove('active');
      await loadPlans();
      showScreen('subscriptionScreen');
      
      // Update text for upgrade scenario (subscription is active)
      const expiredText = document.getElementById('subExpiredText');
      const expiredBadge = document.getElementById('subExpiredBadge');
      const authTitle = document.querySelector('#subscriptionScreen .auth-title');
      
      if (hasActiveSubscription()) {
        // User has active subscription, show upgrade text
        if (authTitle) authTitle.textContent = 'Upgrade Plan';
        if (expiredText) expiredText.textContent = 'Choose a plan to upgrade your subscription';
        if (expiredBadge) expiredBadge.style.display = 'none';
      } else {
        // Subscription expired, show expired text
        if (authTitle) authTitle.textContent = 'Subscription Required';
        if (expiredBadge) expiredBadge.style.display = '';
        // Badge text will be set by checkSubscriptionAndRedirect
      }
    });
  }
  
  // Models modal close
  if (modelsModalClose) {
    modelsModalClose.addEventListener('click', () => {
      modelsModalOverlay.classList.remove('active');
    });
  }
  
  if (modelsModalOverlay) {
    modelsModalOverlay.addEventListener('click', (e) => {
      if (e.target === modelsModalOverlay) {
        modelsModalOverlay.classList.remove('active');
      }
    });
  }
  
  // Delete model confirmation modal
  const deleteModelOverlay = document.getElementById('deleteModelOverlay');
  const deleteModelCancel = document.getElementById('deleteModelCancel');
  const deleteModelConfirm = document.getElementById('deleteModelConfirm');
  
  if (deleteModelCancel) {
    deleteModelCancel.addEventListener('click', () => {
      deleteModelOverlay.classList.remove('active');
    });
  }
  
  if (deleteModelConfirm) {
    deleteModelConfirm.addEventListener('click', async () => {
      const username = deleteModelOverlay.dataset.username;
      if (username) {
        await removeModel(username);
        deleteModelOverlay.classList.remove('active');
      }
    });
  }
  
  if (deleteModelOverlay) {
    deleteModelOverlay.addEventListener('click', (e) => {
      if (e.target === deleteModelOverlay) {
        deleteModelOverlay.classList.remove('active');
      }
    });
  }
  
  // Password reset success modal
  const passwordResetSuccessOverlay = document.getElementById('passwordResetSuccessOverlay');
  const passwordResetSuccessOk = document.getElementById('passwordResetSuccessOk');
  
  if (passwordResetSuccessOk) {
    passwordResetSuccessOk.addEventListener('click', () => {
      hidePasswordResetSuccessModal();
      showScreen('loginScreen');
    });
  }
  
  if (passwordResetSuccessOverlay) {
    passwordResetSuccessOverlay.addEventListener('click', (e) => {
      if (e.target === passwordResetSuccessOverlay) {
        hidePasswordResetSuccessModal();
        showScreen('loginScreen');
      }
    });
  }
  
  // Universal info modal
  const infoModalOverlay = document.getElementById('infoModalOverlay');
  const infoModalOk = document.getElementById('infoModalOk');
  
  if (infoModalOk) {
    infoModalOk.addEventListener('click', () => {
      hideInfoModal();
    });
  }
  
  if (infoModalOverlay) {
    infoModalOverlay.addEventListener('click', (e) => {
      if (e.target === infoModalOverlay) {
        hideInfoModal();
      }
    });
  }
  
  // Notifications panel
  const notificationBtn = document.getElementById('notificationBtn');
  const notificationsPanel = document.getElementById('notificationsPanel');
  const notificationsClose = document.getElementById('notificationsClose');
  const notificationsClear = document.getElementById('notificationsClear');
  
  // Get dropdown overlay reference
  const dropdownOverlayRef = document.getElementById('dropdownOverlay');
  
  if (notificationBtn) {
    notificationBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = notificationsPanel.style.display !== 'none';
      
      // Close user menu if open
      const userMenu = document.getElementById('userMenuDropdown');
      if (userMenu) userMenu.style.display = 'none';
      
      if (isVisible) {
        notificationsPanel.style.display = 'none';
        if (dropdownOverlayRef) dropdownOverlayRef.classList.remove('active');
      } else {
        notificationsPanel.style.display = 'flex';
        if (dropdownOverlayRef) dropdownOverlayRef.classList.add('active');
        renderNotifications();
      }
    });
  }
  
  if (notificationsClose) {
    notificationsClose.addEventListener('click', () => {
      notificationsPanel.style.display = 'none';
      if (dropdownOverlayRef) dropdownOverlayRef.classList.remove('active');
    });
  }
  
  if (notificationsClear) {
    notificationsClear.addEventListener('click', () => {
      clearAllNotifications();
    });
  }
  
  // Close notifications on outside click (fallback like menu)
  document.addEventListener('click', (e) => {
    if (notificationsPanel && 
        notificationsPanel.style.display !== 'none' && 
        !notificationsPanel.contains(e.target) && 
        e.target !== notificationBtn &&
        !notificationBtn.contains(e.target)) {
      notificationsPanel.style.display = 'none';
      if (dropdownOverlayRef) dropdownOverlayRef.classList.remove('active');
    }
  });
  
}

// ==================== NOTIFICATIONS SYSTEM ====================

// Load notifications from storage
async function loadNotifications() {
  try {
    const result = await chrome.storage.local.get('ofStatsNotifications');
    notifications = result.ofStatsNotifications || [];
    updateNotificationBadge();
  } catch (e) {
    notifications = [];
  }
}

// Save notifications to storage
async function saveNotifications() {
  try {
    await chrome.storage.local.set({ ofStatsNotifications: notifications });
    updateNotificationBadge();
  } catch (e) {}
}

// Add new notification
async function addNotification(type, title, message) {
  const notification = {
    id: Date.now(),
    type: type, // 'info', 'success', 'warning', 'promo'
    title: title,
    message: message,
    timestamp: new Date().toISOString(),
    read: false
  };
  
  notifications.unshift(notification);
  
  // Keep only last 20 notifications
  if (notifications.length > 20) {
    notifications = notifications.slice(0, 20);
  }
  
  await saveNotifications();
  renderNotifications();
}

// Mark notification as read
async function markNotificationRead(id) {
  const notification = notifications.find(n => n.id === id);
  if (notification) {
    notification.read = true;
    await saveNotifications();
    renderNotifications();
  }
}

// Clear all notifications
async function clearAllNotifications() {
  notifications = [];
  await saveNotifications();
  renderNotifications();
}

// Update notification badge
function updateNotificationBadge() {
  const badge = document.getElementById('notificationBadge');
  const unreadCount = notifications.filter(n => !n.read).length;
  
  if (badge) {
    badge.style.display = unreadCount > 0 ? 'block' : 'none';
  }
}

// Render notifications list
function renderNotifications() {
  const list = document.getElementById('notificationsList');
  const empty = document.getElementById('notificationsEmpty');
  const clearBtn = document.getElementById('notificationsClear');
  
  if (!list) return;
  
  if (notifications.length === 0) {
    list.style.display = 'none';
    if (empty) empty.style.display = 'flex';
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }
  
  list.style.display = 'block';
  if (empty) empty.style.display = 'none';
  if (clearBtn) clearBtn.style.display = 'block';
  
  list.innerHTML = notifications.map(n => {
    const timeAgo = getTimeAgo(new Date(n.timestamp));
    const iconMap = {
      info: `<svg viewBox="0 0 24 24" fill="none" width="16" height="16">
               <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
               <line x1="12" y1="16" x2="12" y2="12" stroke="currentColor" stroke-width="2"/>
               <line x1="12" y1="8" x2="12.01" y2="8" stroke="currentColor" stroke-width="2"/>
             </svg>`,
      success: `<svg viewBox="0 0 24 24" fill="none" width="16" height="16">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" stroke="currentColor" stroke-width="2"/>
                  <polyline points="22 4 12 14.01 9 11.01" stroke="currentColor" stroke-width="2"/>
                </svg>`,
      warning: `<svg viewBox="0 0 24 24" fill="none" width="16" height="16">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="2"/>
                  <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="2"/>
                  <line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" stroke-width="2"/>
                </svg>`,
      promo: `<svg viewBox="0 0 24 24" fill="none" width="16" height="16">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" stroke="currentColor" stroke-width="2"/>
                <line x1="7" y1="7" x2="7.01" y2="7" stroke="currentColor" stroke-width="2"/>
              </svg>`
    };
    
    return `
      <div class="notification-item ${n.read ? '' : 'unread'}" data-id="${n.id}" style="position: relative;">
        <div class="notification-icon ${n.type}">
          ${iconMap[n.type] || iconMap.info}
        </div>
        <div class="notification-content">
          <div class="notification-title">${n.title}</div>
          <div class="notification-message">${n.message}</div>
          <div class="notification-time">${timeAgo}</div>
        </div>
      </div>
    `;
  }).join('');
  
  // Add click handlers to mark as read
  list.querySelectorAll('.notification-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = parseInt(item.dataset.id);
      markNotificationRead(id);
    });
  });
  
  updateNotificationBadge();
}

// Get relative time string
function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  
  return date.toLocaleDateString();
}

// Update subscription expiration date in dropdown menu
function updateSubscriptionExpiry() {
  const userMenuExpires = document.getElementById('userMenuExpires');
  if (!userMenuExpires) return;
  
  if (currentSubscription) {
    // Try multiple field names for end date
    const endDate = currentSubscription.ends_at || currentSubscription.endsAt || 
                    currentSubscription.end_date || currentSubscription.endDate ||
                    currentSubscription.expires_at || currentSubscription.expiresAt ||
                    currentSubscription.trial_ends_at || currentSubscription.trialEndsAt;
    
    log('Subscription data:', currentSubscription);
    log('End date found:', endDate);
    
    if (endDate) {
      const date = new Date(endDate);
      if (!isNaN(date.getTime())) {
        userMenuExpires.textContent = 'Expires: ' + date.toLocaleDateString();
        return;
      }
    }
    
    // If no end date, show "Active" for paid or trial status
    const status = currentSubscription.status;
    if (status === 'trial' || status === 'active') {
      userMenuExpires.textContent = '✅ Active';
    } else {
      userMenuExpires.textContent = '';
    }
  } else {
    userMenuExpires.textContent = '';
  }
}

// Helper to safely show login error
function showLoginError(message) {
  const errorEl = document.getElementById('loginError');
  if (errorEl) {
    errorEl.textContent = message;
  } else {
    logError('Login error (no element):', message);
  }
}

// Handle login
async function handleLogin() {
  const btn = document.getElementById('loginBtn');
  const btnText = btn?.querySelector('.auth-btn-text');
  const loader = btn?.querySelector('.auth-btn-loader');
  const emailInput = document.getElementById('loginEmail');
  const passwordInput = document.getElementById('loginPassword');
  
  if (!btn || !emailInput || !passwordInput) {
    logError('Login form elements not found');
    return;
  }
  
  showLoginError('');
  btn.disabled = true;
  if (btnText) btnText.style.display = 'none';
  if (loader) loader.style.display = 'block';
  
  try {
    // Retry logic for service worker wake-up
    let result = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await chrome.runtime.sendMessage({
          action: 'login',
          email: emailInput.value,
          password: passwordInput.value
        });
        if (result !== undefined) break;
      } catch (e) {
        log('Login attempt', attempt + 1, 'failed, retrying...');
        await new Promise(r => setTimeout(r, 300));
      }
    }
    
    if (!result) {
      showLoginError('Connection error. Please try again.');
      return;
    }
    
    if (result.success) {
      currentUser = result.user;
      currentSubscription = result.subscription;
      // Clear saved popup state after successful login
      await chrome.storage.local.remove(['popupScreen', 'popupPendingEmail']);
      
      if (!hasActiveSubscription()) {
        await loadPlans();
        showScreen('subscriptionScreen');
        const userEmailEl = document.getElementById('currentUserEmail');
        if (userEmailEl) userEmailEl.textContent = currentUser.email;
      } else {
        await loadUserModels();
        updateUserUI();
        showScreen('mainApp');
        initMainApp();
      }
    } else {
      showLoginError(result.error || 'Login failed');
    }
  } catch (error) {
    logError('Login error:', error);
    showLoginError('Network error. Please try again.');
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.style.display = 'inline';
    if (loader) loader.style.display = 'none';
  }
}

// Handle forgot password
async function handleForgotPassword() {
  const btn = document.getElementById('forgotBtn');
  const btnText = btn.querySelector('.auth-btn-text');
  const loader = btn.querySelector('.auth-btn-loader');
  const errorEl = document.getElementById('forgotError');
  const successEl = document.getElementById('forgotSuccess');
  const emailInput = document.getElementById('forgotEmail');
  
  errorEl.textContent = '';
  errorEl.style.display = 'none';
  successEl.textContent = '';
  successEl.style.display = 'none';
  
  btn.disabled = true;
  btnText.style.display = 'none';
  loader.style.display = 'block';
  
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'forgotPassword',
      email: emailInput.value
    });
    
    if (result.success) {
      // Save email for reset flow
      pendingEmail = emailInput.value;
      
      // Show reset code screen
      const emailDisplay = document.getElementById('resetEmailDisplay');
      if (emailDisplay) emailDisplay.textContent = pendingEmail;
      
      showScreen('resetCodeScreen');
    } else {
      errorEl.textContent = result.error || 'Failed to send reset code';
      errorEl.style.display = 'block';
    }
  } catch (error) {
    errorEl.textContent = 'Network error. Please try again.';
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btnText.style.display = 'inline';
    loader.style.display = 'none';
  }
}

// Handle reset password with code
async function handleResetPassword() {
  const btn = document.getElementById('resetCodeBtn');
  const btnText = btn.querySelector('.auth-btn-text');
  const loader = btn.querySelector('.auth-btn-loader');
  const errorEl = document.getElementById('resetCodeError');
  const codeInput = document.getElementById('resetCode');
  const newPasswordInput = document.getElementById('newPassword');
  const confirmInput = document.getElementById('newPasswordConfirm');
  
  errorEl.textContent = '';
  
  // Validate passwords match
  if (newPasswordInput.value !== confirmInput.value) {
    errorEl.textContent = 'Passwords do not match';
    return;
  }
  
  if (newPasswordInput.value.length < 6) {
    errorEl.textContent = 'Password must be at least 6 characters';
    return;
  }
  
  btn.disabled = true;
  btnText.style.display = 'none';
  loader.style.display = 'block';
  
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'resetPassword',
      email: pendingEmail,
      token: codeInput.value.trim(),
      newPassword: newPasswordInput.value
    });
    
    if (result.success) {
      // Show success modal and redirect to login
      showPasswordResetSuccessModal();
      pendingEmail = null;
      // Clear saved popup state after successful reset
      await chrome.storage.local.remove(['popupScreen', 'popupPendingEmail']);
    } else {
      errorEl.textContent = result.error || 'Invalid or expired code';
    }
  } catch (error) {
    errorEl.textContent = 'Network error. Please try again.';
  } finally {
    btn.disabled = false;
    btnText.style.display = 'inline';
    loader.style.display = 'none';
  }
}

// Handle register
async function handleRegister() {
  const btn = document.getElementById('registerBtn');
  const btnText = btn.querySelector('.auth-btn-text');
  const loader = btn.querySelector('.auth-btn-loader');
  
  registerError.textContent = '';
  
  // Validate passwords match
  if (registerPassword.value !== registerConfirm.value) {
    registerError.textContent = 'Passwords do not match';
    return;
  }
  
  btn.disabled = true;
  btnText.style.display = 'none';
  loader.style.display = 'block';
  
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'register',
      email: registerEmail.value,
      password: registerPassword.value
    });
    
    if (result.success) {
      if (result.requiresVerification) {
        // Show verification screen
        pendingEmail = registerEmail.value;
        const emailDisplay = document.getElementById('verifyEmailDisplay');
        if (emailDisplay) emailDisplay.textContent = pendingEmail;
        showScreen('verifyEmailScreen');
      } else {
        // Direct login (backwards compatibility)
        currentUser = result.user;
        currentSubscription = result.subscription || { status: 'trial', plan: 'trial', model_limit: 10 };
        await loadUserModels();
        updateUserUI();
        
        // Add welcome notification for new users
        await addNotification('success', 'Welcome to Stats Editor Pro!', 
          'Your account has been created. Enjoy your free trial!');
        
        showScreen('mainApp');
        initMainApp();
      }
    } else {
      registerError.textContent = result.error || 'Registration failed';
    }
  } catch (error) {
    registerError.textContent = 'Network error. Please try again.';
  } finally {
    btn.disabled = false;
    btnText.style.display = 'inline';
    loader.style.display = 'none';
  }
}

// Handle email verification
async function handleVerifyEmail() {
  const btn = document.getElementById('verifyBtn');
  const btnText = btn.querySelector('.auth-btn-text');
  const loader = btn.querySelector('.auth-btn-loader');
  const errorEl = document.getElementById('verifyError');
  const codeInput = document.getElementById('verifyCode');
  
  errorEl.textContent = '';
  
  btn.disabled = true;
  btnText.style.display = 'none';
  loader.style.display = 'block';
  
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'verifyEmail',
      email: pendingEmail,
      code: codeInput.value.trim()
    });
    
    if (result.success) {
      currentUser = result.user;
      currentSubscription = result.subscription || { status: 'trial', plan: 'trial', model_limit: 10 };
      pendingEmail = null;
      // Clear saved popup state after successful verification
      await chrome.storage.local.remove(['popupScreen', 'popupPendingEmail']);
      await loadUserModels();
      updateUserUI();
      showScreen('mainApp');
      initMainApp();
    } else {
      errorEl.textContent = result.error || 'Invalid verification code';
    }
  } catch (error) {
    errorEl.textContent = 'Network error. Please try again.';
  } finally {
    btn.disabled = false;
    btnText.style.display = 'inline';
    loader.style.display = 'none';
  }
}

// Resend verification code
async function resendVerificationCode() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'resendVerification',
      email: pendingEmail
    });
    
    if (result.success) {
      showInfoModal('Code Sent', 'Verification code sent! Check your email.', 'success');
    } else {
      showInfoModal('Error', result.error || 'Failed to resend code', 'error');
    }
  } catch (error) {
    showInfoModal('Network Error', 'Network error. Please try again.', 'error');
  }
}

// Handle logout
async function handleLogout() {
  try {
    await chrome.runtime.sendMessage({ action: 'logout' });
  } catch (e) {
    log('Logout message error (ok):', e);
  }
  
  currentUser = null;
  currentSubscription = null;
  currentModels = [];
  pendingEmail = null;
  currentPaymentId = null;
  selectedPlan = null;
  
  // Clear any payment intervals
  if (paymentCheckInterval) {
    clearInterval(paymentCheckInterval);
  }
  if (paymentTimerInterval) {
    clearInterval(paymentTimerInterval);
  }
  
  // Clear saved popup state and subscription status
  await chrome.storage.local.remove(['popupScreen', 'popupPendingEmail', 'popupPaymentId', 'popupSelectedPlan', 'popupPayAddress', 'popupPaymentExpires', 'ofStatsSubscription', 'ofStatsSubscriptionActive']);
  
  // Also clear localStorage caches on all OnlyFans tabs
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.onlyfans.com/*' });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            localStorage.removeItem('ofStatsSubActive');
            localStorage.removeItem('ofStatsCache');
            localStorage.removeItem('ofStatsEarningStats');
            localStorage.removeItem('ofStatsEarningsData');
          }
        });
      } catch (e) {}
    }
  } catch (e) {}
  
  // Clear form fields - get elements fresh
  const emailInput = document.getElementById('loginEmail');
  const passwordInput = document.getElementById('loginPassword');
  const errorEl = document.getElementById('loginError');
  
  if (emailInput) emailInput.value = '';
  if (passwordInput) passwordInput.value = '';
  if (errorEl) errorEl.textContent = '';
  
  showScreen('loginScreen');
}

// Handle promo code application
async function handleApplyPromoCode() {
  const input = document.getElementById('promoCodeInput');
  const btn = document.getElementById('applyPromoBtn');
  const message = document.getElementById('promoMessage');
  
  const code = input.value.trim().toUpperCase();
  if (!code) {
    message.textContent = 'Please enter a promo code';
    message.className = 'promo-code-message error';
    return;
  }
  
  btn.disabled = true;
  btn.textContent = '...';
  message.textContent = '';
  
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'applyPromoCode',
      code: code
    });
    
    if (result && result.success) {
      // Success - code activated
      message.textContent = result.message || 'Promo code activated successfully!';
      message.className = 'promo-code-message success';
      input.value = '';
      
      // Add notification with correct days from server response
      const planName = result.subscription?.plan || result.plan || 'subscription';
      const daysAdded = result.subscription?.days || result.days || 7;
      await addNotification('promo', 'Promo Code Activated!', 
        `Code "${code}" activated. ${daysAdded} days of ${planName.toUpperCase()} added to your account.`);
      
      // Refresh subscription status
      setTimeout(async () => {
        const verifyResult = await chrome.runtime.sendMessage({ action: 'verifyAuth' });
        if (verifyResult && verifyResult.success) {
          currentUser = verifyResult.user;
          currentSubscription = verifyResult.subscription;
          
          if (hasActiveSubscription()) {
            await loadUserModels();
            updateUserUI();
            showScreen('mainApp');
            initMainApp();
          }
        }
      }, 1000);
    } else {
      // Error handling with specific messages
      const errorCode = result?.code || '';
      const errorMessage = result?.error || 'Invalid promo code';
      
      if (errorCode === 'ALREADY_USED' || errorMessage.includes('already used') || errorMessage.includes('already been used')) {
        message.textContent = 'This code has already been used';
        message.className = 'promo-code-message error';
        await addNotification('warning', 'Promo Code Already Used', 
          `The code "${code}" has already been activated on your account.`);
      } else if (errorCode === 'INVALID_CODE' || errorMessage.includes('Invalid') || errorMessage.includes('not found')) {
        message.textContent = 'Invalid promo code';
        message.className = 'promo-code-message error';
      } else if (errorCode === 'EXPIRED' || errorMessage.includes('expired')) {
        message.textContent = 'This promo code has expired';
        message.className = 'promo-code-message error';
      } else if (errorCode === 'LIMIT_REACHED' || errorMessage.includes('limit')) {
        message.textContent = 'This promo code usage limit reached';
        message.className = 'promo-code-message error';
      } else {
        message.textContent = errorMessage;
        message.className = 'promo-code-message error';
      }
    }
  } catch (error) {
    message.textContent = 'Network error. Please try again.';
    message.className = 'promo-code-message error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply';
  }
}

// Show models modal
async function showModelsModal() {
  await loadUserModels();
  renderModelsList();
  modelsModalOverlay.classList.add('active');
}

// Render models list
function renderModelsList() {
  if (!modelsList) return;
  
  if (currentModels.length === 0) {
    modelsList.innerHTML = '<div class="models-empty">No models added yet. Models are added automatically when you apply changes on a profile.</div>';
    return;
  }
  
  modelsList.innerHTML = currentModels.map(model => {
    // Format date safely - backend returns createdAt (camelCase)
    let dateStr = 'Unknown date';
    const createdDate = model.createdAt || model.created_at;
    if (createdDate) {
      const date = new Date(createdDate);
      if (!isNaN(date.getTime())) {
        dateStr = date.toLocaleDateString();
      }
    }
    
    return `
    <div class="model-item" data-username="${model.username}">
      <div class="model-item-avatar">
        ${model.avatar_url 
          ? `<img src="${model.avatar_url}" alt="@${model.username}">`
          : `<svg viewBox="0 0 24 24" fill="none">
              <path d="M20 21V19C20 17.9391 19.5786 16.9217 18.8284 16.1716C18.0783 15.4214 17.0609 15 16 15H8C6.93913 15 5.92172 15.4214 5.17157 16.1716C4.42143 16.9217 4 17.9391 4 19V21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>`
        }
      </div>
      <div class="model-item-info">
        <span class="model-item-name">@${model.username}</span>
        <span class="model-item-date">Added ${dateStr}</span>
      </div>
      <button class="model-item-remove" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" width="16" height="16">
          <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  `}).join('');
  
  // Add remove handlers
  modelsList.querySelectorAll('.model-item-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const item = e.target.closest('.model-item');
      const username = item.dataset.username;
      showDeleteModelConfirm(username);
    });
  });
  
  updateUserUI();
}

// Show universal info/error modal
// type: 'info', 'success', 'warning', 'error'
function showInfoModal(title, message, type = 'info') {
  const overlay = document.getElementById('infoModalOverlay');
  const titleText = document.getElementById('infoModalTitleText');
  const messageEl = document.getElementById('infoModalMessage');
  const iconEl = document.getElementById('infoModalIcon');
  
  if (!overlay) return;
  
  // Set title and message
  if (titleText) titleText.textContent = title;
  if (messageEl) messageEl.textContent = message;
  
  // Set icon based on type
  const icons = {
    info: `<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
           <line x1="12" y1="16" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
           <line x1="12" y1="8" x2="12.01" y2="8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
    success: `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <polyline points="22 4 12 14.01 9 11.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    warning: `<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
              <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
    error: `<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
            <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`
  };
  
  const colors = {
    info: 'var(--accent-primary)',
    success: 'var(--success)',
    warning: 'var(--warning)',
    error: 'var(--danger)'
  };
  
  if (iconEl) {
    iconEl.innerHTML = icons[type] || icons.info;
    iconEl.style.color = colors[type] || colors.info;
  }
  
  overlay.classList.add('active');
}

// Hide universal info modal
function hideInfoModal() {
  const overlay = document.getElementById('infoModalOverlay');
  if (overlay) {
    overlay.classList.remove('active');
  }
}

// Show password reset success modal
function showPasswordResetSuccessModal() {
  const overlay = document.getElementById('passwordResetSuccessOverlay');
  if (overlay) {
    overlay.classList.add('active');
  }
}

// Hide password reset success modal
function hidePasswordResetSuccessModal() {
  const overlay = document.getElementById('passwordResetSuccessOverlay');
  if (overlay) {
    overlay.classList.remove('active');
  }
}

// Show delete model confirmation
function showDeleteModelConfirm(username) {
  const deleteModelUsername = document.getElementById('deleteModelUsername');
  const deleteModelOverlay = document.getElementById('deleteModelOverlay');
  
  if (deleteModelUsername) deleteModelUsername.textContent = `@${username}`;
  if (deleteModelOverlay) {
    deleteModelOverlay.dataset.username = username;
    deleteModelOverlay.classList.add('active');
  }
}

// Remove model
async function removeModel(username) {
  try {
    const result = await chrome.runtime.sendMessage({ action: 'removeModel', username });
    if (result.success) {
      currentModels = currentModels.filter(m => m.username !== username);
      
      // Remove avatar from local storage
      const stored = await chrome.storage.local.get('modelAvatars');
      const avatars = stored.modelAvatars || {};
      delete avatars[username];
      await chrome.storage.local.set({ modelAvatars: avatars });
      
      renderModelsList();
      updateUserUI();
    }
  } catch (error) {
    logError('Error removing model:', error);
  }
}

// Check if model can be added
async function checkAndAddModel(username) {
  if (!currentSubscription) return false;
  
  const limit = currentSubscription.modelLimit || currentSubscription.model_limit || 0;
  
  // Check if already added
  if (currentModels.some(m => m.username === username)) {
    // Update avatar locally if we have a new one
    if (currentModelAvatarUrl) {
      await saveModelAvatarLocally(username, currentModelAvatarUrl);
    }
    return true; // Already added, allow
  }
  
  // Check limit (null or very high number = unlimited)
  if (limit !== null && limit < 999999 && currentModels.length >= limit) {
    return false; // At limit
  }
  
  // Add model
  try {
    const result = await chrome.runtime.sendMessage({ 
      action: 'addModel', 
      username,
      avatarUrl: currentModelAvatarUrl 
    });
    if (result.success) {
      // Save avatar locally as backup
      if (currentModelAvatarUrl) {
        await saveModelAvatarLocally(username, currentModelAvatarUrl);
      }
      await loadUserModels();
      updateUserUI();
      return true;
    }
    // Check if error is limit related
    if (result.code === 'MODEL_LIMIT_REACHED') {
      return false;
    }
    // Other errors - still allow local usage
    return true;
  } catch (error) {
    logError('Error adding model:', error);
    // Network error - allow local usage
    return true;
  }
}

// ==================== MAIN APP ====================

// DOM Elements
const mainToggle = document.getElementById('pluginEnabled');
const topCreatorsInput = document.getElementById('topCreators');
const currentBalanceInput = document.getElementById('currentBalance');
const pendingBalanceInput = document.getElementById('pendingBalance');
const earningsCountInput = document.getElementById('earningsCount');
const earningsCompleteCountInput = document.getElementById('earningsCompleteCount');
const fansCountInput = document.getElementById('fansCount');
const fansTooltipInput = document.getElementById('fansTooltip');
const followingCountInput = document.getElementById('followingCount');
const followingTooltipInput = document.getElementById('followingTooltip');
const applyBtn = document.getElementById('applyBtn');
const resetBtn = document.getElementById('resetBtn');
const statusIndicator = document.getElementById('statusIndicator');
const modelNameEl = document.getElementById('modelName');
const modelAvatarImg = document.getElementById('modelAvatarImg');
const modelAvatarPlaceholder = document.getElementById('modelAvatarPlaceholder');
const container = document.querySelector('.container');
const floatingNumbers = document.getElementById('floatingNumbers');

// Preset DOM Elements
const presetSelect = document.getElementById('presetSelect');
const customPresetSelect = document.getElementById('customPresetSelect');
const presetSelectTrigger = document.getElementById('presetSelectTrigger');
const presetSelectText = document.getElementById('presetSelectText');
const presetDropdown = document.getElementById('presetDropdown');
const savePresetBtn = document.getElementById('savePresetBtn');
const deletePresetBtn = document.getElementById('deletePresetBtn');
const presetModalOverlay = document.getElementById('presetModalOverlay');
const presetNameInput = document.getElementById('presetNameInput');
const presetModalCancel = document.getElementById('presetModalCancel');
const presetModalSave = document.getElementById('presetModalSave');
const deleteModalOverlay = document.getElementById('deleteModalOverlay');
const deletePresetName = document.getElementById('deletePresetName');
const deleteModalCancel = document.getElementById('deleteModalCancel');
const deleteModalConfirm = document.getElementById('deleteModalConfirm');
// Track form state
let savedFormState = {};
let hasUnsavedChanges = false;
let currentPresets = {};

// Default settings
const defaultSettings = {
  enabled: true,
  topCreators: '',
  currentBalance: '',
  pendingBalance: '',
  earningsCount: '',
  earningsCompleteCount: '',
  fansCount: '',
  fansTooltip: '',
  followingCount: '',
  followingTooltip: '',
  modelName: '@not_detected',
  modelAvatar: ''
};

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  // Setup auth listeners first (always needed)
  setupAuthListeners();
  
  // Initialize authentication
  await initAuth();
});

// Initialize main app after auth
async function initMainApp(skipSubscriptionCheck = false) {
  // First check if subscription is still active (unless skipped)
  const subscriptionExpired = !hasActiveSubscription();
  
  if (!skipSubscriptionCheck) {
    const isActive = await checkSubscriptionAndRedirect();
    if (!isActive) {
      log('OF Stats: Subscription not active, redirecting to subscription screen');
      return; // checkSubscriptionAndRedirect already shows the subscription screen
    }
  }
  
  await loadPresets();
  await loadSettings();
  await getModelInfo();
  
  // Only setup listeners once to prevent duplicates
  if (!listenersInitialized) {
    setupEventListeners();
    setupPresetListeners();
    listenersInitialized = true;
  }
  
  updateIconFills();
  updateTooltipFieldsState();
  updateApplyButtonState();
  
  // If subscription expired, force toggle OFF and disable it
  if (subscriptionExpired) {
    mainToggle.checked = false;
    mainToggle.disabled = true;
    updateStatusIndicator(false);
    updateContainerState(false);
  } else {
    mainToggle.disabled = false;
    // Only start periodic subscription check if subscription is active
    startSubscriptionCheck();
  }
}

// Periodic subscription check
let subscriptionCheckInterval = null;

function startSubscriptionCheck() {
  // Clear any existing interval
  if (subscriptionCheckInterval) {
    clearInterval(subscriptionCheckInterval);
  }
  
  // Check subscription every 5 minutes
  subscriptionCheckInterval = setInterval(async () => {
    const isActive = await checkSubscriptionAndRedirect();
    if (!isActive) {
      // Subscription expired, stop checking
      clearInterval(subscriptionCheckInterval);
    }
  }, 5 * 60 * 1000);
}

// Load saved settings from storage
async function loadSettings() {
  try {
    const result = await chrome.storage.local.get('ofStatsSettings');
    const settings = result.ofStatsSettings || defaultSettings;
    
    mainToggle.checked = settings.enabled;
    topCreatorsInput.value = settings.topCreators || '';
    currentBalanceInput.value = settings.currentBalance || '';
    pendingBalanceInput.value = settings.pendingBalance || '';
    earningsCountInput.value = settings.earningsCount || '';
    earningsCompleteCountInput.value = settings.earningsCompleteCount || '';
    fansCountInput.value = settings.fansCount || '';
    fansTooltipInput.value = settings.fansTooltip || '';
    followingCountInput.value = settings.followingCount || '';
    followingTooltipInput.value = settings.followingTooltip || '';
    
    updateStatusIndicator(settings.enabled);
    updateContainerState(settings.enabled);
    updateIconFills();
    
    // Save initial form state for comparison
    saveCurrentFormState();
    hasUnsavedChanges = false;
  } catch (error) {
    logError('Error loading settings:', error);
  }
}

// Save current form values as the "saved" state
function saveCurrentFormState() {
  savedFormState = {
    topCreators: topCreatorsInput.value,
    currentBalance: currentBalanceInput.value,
    pendingBalance: pendingBalanceInput.value,
    earningsCount: earningsCountInput.value,
    earningsCompleteCount: earningsCompleteCountInput.value,
    fansCount: fansCountInput.value,
    fansTooltip: fansTooltipInput.value,
    followingCount: followingCountInput.value,
    followingTooltip: followingTooltipInput.value
  };
}

// Check if form has unsaved changes
function checkForChanges() {
  const current = {
    topCreators: topCreatorsInput.value,
    currentBalance: currentBalanceInput.value,
    pendingBalance: pendingBalanceInput.value,
    earningsCount: earningsCountInput.value,
    earningsCompleteCount: earningsCompleteCountInput.value,
    fansCount: fansCountInput.value,
    fansTooltip: fansTooltipInput.value,
    followingCount: followingCountInput.value,
    followingTooltip: followingTooltipInput.value
  };
  
  hasUnsavedChanges = Object.keys(current).some(key => current[key] !== savedFormState[key]);
  return hasUnsavedChanges;
}

// Update tooltip fields enabled/disabled state
function updateTooltipFieldsState() {
  // Fans tooltip - active only if fansCount has value
  if (fansCountInput.value.trim()) {
    fansTooltipInput.disabled = false;
    fansTooltipInput.classList.remove('disabled-field');
  } else {
    fansTooltipInput.disabled = true;
    fansTooltipInput.classList.add('disabled-field');
    fansTooltipInput.value = ''; // Clear if parent is empty
  }
  
  // Following tooltip - active only if followingCount has value
  if (followingCountInput.value.trim()) {
    followingTooltipInput.disabled = false;
    followingTooltipInput.classList.remove('disabled-field');
  } else {
    followingTooltipInput.disabled = true;
    followingTooltipInput.classList.add('disabled-field');
    followingTooltipInput.value = ''; // Clear if parent is empty
  }
}

// Save settings to storage
// preserveEarningStats: if true, never clear ofStatsEarningStats (used when loading from preset)
async function saveSettings(preserveEarningStats = false) {
  // Get existing myModelUsername to preserve it
  const existingSettings = await chrome.storage.local.get('ofStatsSettings');
  const myModelUsername = existingSettings?.ofStatsSettings?.myModelUsername || '';
  
  const settings = {
    enabled: mainToggle.checked,
    topCreators: topCreatorsInput.value,
    currentBalance: currentBalanceInput.value,
    pendingBalance: pendingBalanceInput.value,
    earningsCount: earningsCountInput.value,
    earningsCompleteCount: earningsCompleteCountInput.value,
    fansCount: fansCountInput.value,
    fansTooltip: fansTooltipInput.value,
    followingCount: followingCountInput.value,
    followingTooltip: followingTooltipInput.value,
    myModelUsername: myModelUsername // Preserve model username
  };
  
  try {
    // Check if earnings settings changed - if so, we need to regenerate transactions
    const oldSettings = await chrome.storage.local.get('ofStatsSettings');
    const oldEarningsCount = oldSettings?.ofStatsSettings?.earningsCount || '';
    const oldEarningsCompleteCount = oldSettings?.ofStatsSettings?.earningsCompleteCount || '';
    const oldCurrentBalance = oldSettings?.ofStatsSettings?.currentBalance || '';
    const oldPendingBalance = oldSettings?.ofStatsSettings?.pendingBalance || '';
    const newEarningsCount = settings.earningsCount || '';
    const newEarningsCompleteCount = settings.earningsCompleteCount || '';
    const newCurrentBalance = settings.currentBalance || '';
    const newPendingBalance = settings.pendingBalance || '';
    // Only clear cache if earnings COUNT values actually CHANGED (not just because they have values)
    // This preserves monthly data between page reloads when settings haven't changed
    const earningsChanged = oldEarningsCount !== newEarningsCount || 
                            oldEarningsCompleteCount !== newEarningsCompleteCount;
    // Also clear if balance changed TO A NEW VALUE (not if it was cleared to empty)
    // If new values are empty (Reset case), don't regenerate - keep existing data
    const balanceChangedToNewValue = (newCurrentBalance || newPendingBalance) && 
                                      (oldCurrentBalance !== newCurrentBalance || 
                                       oldPendingBalance !== newPendingBalance);
    
    await chrome.storage.local.set({ ofStatsSettings: settings });
    
    // Cache ALL settings to localStorage for instant loading
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('onlyfans.com')) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (settingsJSON, shouldClearEarnings, shouldClearBalance, preserveEarnings) => {
            localStorage.setItem('ofStatsCache', settingsJSON);
            
            // If preserveEarnings is true (loading from preset), NEVER clear earning stats
            if (preserveEarnings) {
              // Note: log() not available in page context
              return;
            }
            
            // Check if current earning stats were loaded from preset - NEVER delete preset data
            var existingStats = localStorage.getItem('ofStatsEarningStats');
            var isFromPreset = false;
            try {
              if (existingStats) {
                var parsed = JSON.parse(existingStats);
                isFromPreset = parsed.fromPreset === true;
              }
            } catch(e) {}
            
            // Clear earnings cache ONLY if count values changed to force regeneration
            // BUT: Don't clear if data was loaded from preset (has fromPreset flag)
            if (shouldClearEarnings && !isFromPreset) {
              localStorage.removeItem('ofStatsEarningsData');
              localStorage.removeItem('ofStatsEarningsKey');
              // Clear earning stats completely so months will regenerate with new totals
              localStorage.removeItem('ofStatsEarningStats');
              // Clear chart caches so they regenerate with new Gross values
              localStorage.removeItem('ofStatsChartDataCache');
              localStorage.removeItem('ofStatsChartGrossValue');
              localStorage.removeItem('ofStatsEarningsBreakdownCache');
              // Also remove the months-applied flag so page will re-render
              var container = document.querySelector('.b-stats-wrap');
              if (container) {
                container.removeAttribute('data-of-stats-months-applied');
                container.removeAttribute('data-of-stats-months-replaced');
              }
            }
            // If balance changed, clear earning stats so they regenerate with new minimum requirements
            // This ensures current month is always > Current + Pending balance
            // BUT: Don't clear if data was loaded from preset (has fromPreset flag)
            if (shouldClearBalance && !shouldClearEarnings) {
              if (!isFromPreset) {
                localStorage.removeItem('ofStatsEarningStats');
                localStorage.removeItem('ofStatsChartDataCache');
                localStorage.removeItem('ofStatsChartGrossValue');
                localStorage.removeItem('ofStatsEarningsBreakdownCache');
                var container = document.querySelector('.b-stats-wrap');
                if (container) {
                  container.removeAttribute('data-of-stats-months-applied');
                  container.removeAttribute('data-of-stats-months-replaced');
                }
              }
            }
          },
          args: [JSON.stringify(settings), earningsChanged, balanceChangedToNewValue, preserveEarningStats]
        });
      }
    } catch (e) {
      log('Could not update localStorage cache:', e);
    }
    
    return true;
  } catch (error) {
    logError('Error saving settings:', error);
    return false;
  }
}

// Get model info from current tab
async function getModelInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tab && tab.url && tab.url.includes('onlyfans.com')) {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getModelName' });
      
      if (response) {
        if (response.modelName) {
          modelNameEl.textContent = response.modelName;
          
          // Save model username to settings (will be included in ofStatsCache)
          const cleanUsername = response.modelName.replace('@', '').toLowerCase();
          
          // Get current settings and add myModelUsername
          const currentSettings = await chrome.storage.local.get('ofStatsSettings');
          if (currentSettings.ofStatsSettings) {
            currentSettings.ofStatsSettings.myModelUsername = cleanUsername;
            await chrome.storage.local.set({ ofStatsSettings: currentSettings.ofStatsSettings });
            
            // Update localStorage cache immediately on ALL tabs
            try {
              const allTabs = await chrome.tabs.query({ url: '*://*.onlyfans.com/*' });
              for (const t of allTabs) {
                try {
                  await chrome.scripting.executeScript({
                    target: { tabId: t.id },
                    func: (username) => {
                      // Update the cached settings with new username
                      const cached = localStorage.getItem('ofStatsCache');
                      if (cached) {
                        const settings = JSON.parse(cached);
                        settings.myModelUsername = username;
                        localStorage.setItem('ofStatsCache', JSON.stringify(settings));
                      }
                    },
                    args: [cleanUsername]
                  });
                } catch (e) {}
              }
            } catch (e) {
              log('Could not update all tabs:', e);
            }
          }
        }
        
        // Set avatar if available
        if (response.avatarUrl) {
          modelAvatarImg.src = response.avatarUrl;
          modelAvatarImg.style.display = 'block';
          modelAvatarPlaceholder.style.display = 'none';
          currentModelAvatarUrl = response.avatarUrl; // Store for addModel
        } else {
          currentModelAvatarUrl = null;
        }
      }
    }
  } catch (error) {
    log('Could not get model info:', error);
  }
}

// Update status indicator
function updateStatusIndicator(enabled) {
  const statusText = statusIndicator.querySelector('.status-text');
  
  if (enabled) {
    statusIndicator.classList.remove('inactive');
    statusText.textContent = 'Active';
  } else {
    statusIndicator.classList.add('inactive');
    statusText.textContent = 'Inactive';
  }
}

// Update container state
function updateContainerState(enabled) {
  if (enabled) {
    container.classList.remove('disabled');
  } else {
    container.classList.add('disabled');
  }
}

// Update icon fills based on input values
function updateIconFills() {
  // Heart icon for fans
  const fansIcon = document.getElementById('fansHeartIcon');
  if (fansCountInput.value.trim()) {
    fansIcon.classList.add('filled');
  } else {
    fansIcon.classList.remove('filled');
  }
  
  // User icon for following
  const followingIcon = document.getElementById('followingUserIcon');
  if (followingCountInput.value.trim()) {
    followingIcon.classList.add('filled');
  } else {
    followingIcon.classList.remove('filled');
  }
  
  // Top Creators icon
  const topCreatorsIcon = document.getElementById('topCreatorsIcon');
  if (topCreatorsIcon) {
    if (topCreatorsInput.value.trim()) {
      topCreatorsIcon.classList.add('filled');
    } else {
      topCreatorsIcon.classList.remove('filled');
    }
  }
  
  // Earnings icon
  const earningsIcon = document.getElementById('earningsIcon');
  if (earningsIcon) {
    if (earningsCountInput.value.trim() || earningsCompleteCountInput.value.trim()) {
      earningsIcon.classList.add('filled');
    } else {
      earningsIcon.classList.remove('filled');
    }
  }
}

// Parse number from string (handles K, M notation)
function parseNumber(str) {
  if (!str) return 0;
  str = str.toString().trim().toUpperCase();
  
  const kMatch = str.match(/^([\d.]+)\s*K$/);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);
  
  const mMatch = str.match(/^([\d.]+)\s*M$/);
  if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1000000);
  
  return parseInt(str.replace(/[^\d]/g, '')) || 0;
}

// Format number to K/M notation (always with decimal: 47.0K)
function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

// Auto-format percentage input for Top Creators field
// Rules:
// - 10% and above: whole numbers (49%, 35%, 87%, 10%)
// - 1% to 10%: one decimal (7.1%, 8.4%, 3.5%)
// - Below 1%: two decimals (0.81%, 0.99%, 0.04%)
// Auto-adds % if missing
function autoFormatPercentage(input) {
  let value = input.value.trim();
  if (!value) return;
  
  // Remove % if present to get raw number
  let cleanValue = value.replace('%', '').trim();
  
  // Parse as float
  let num = parseFloat(cleanValue);
  if (isNaN(num)) return;
  
  // Clamp to reasonable range (0 to 100)
  num = Math.max(0, Math.min(100, num));
  
  // Format based on value
  if (num >= 10) {
    // 10% and above: whole numbers
    input.value = Math.round(num) + '%';
  } else if (num >= 1) {
    // 1% to 10%: one decimal place
    input.value = num.toFixed(1) + '%';
  } else if (num > 0) {
    // Below 1%: two decimal places
    input.value = num.toFixed(2) + '%';
  } else {
    // Zero or invalid
    input.value = '0%';
  }
}

// Auto-format balance values to ensure 2 decimal places (cents)
// Examples: 2134 -> 2134.XX (random cents), 2134.3 -> 2134.3X (add second decimal)
function autoFormatBalanceValue(input) {
  let value = input.value.trim();
  if (!value) return;
  
  // Remove commas for processing
  let cleanValue = value.replace(/,/g, '');
  
  // Check if it's a valid number
  const numMatch = cleanValue.match(/^(\d+)(\.?(\d*))?$/);
  if (!numMatch) return;
  
  const intPart = numMatch[1];
  const decimalPart = numMatch[3] || '';
  
  let finalValue;
  
  if (decimalPart.length === 0) {
    // No decimal - add random cents (01-99)
    const cents = Math.floor(Math.random() * 99) + 1;
    finalValue = intPart + '.' + cents.toString().padStart(2, '0');
  } else if (decimalPart.length === 1) {
    // One decimal digit - add second random digit (0-9)
    const secondDigit = Math.floor(Math.random() * 10);
    finalValue = intPart + '.' + decimalPart + secondDigit;
  } else if (decimalPart.length > 2) {
    // More than 2 decimals - truncate to 2
    finalValue = intPart + '.' + decimalPart.substring(0, 2);
  } else {
    // Already 2 decimals - keep as is
    finalValue = intPart + '.' + decimalPart;
  }
  
  // Add commas to integer part for display
  const parts = finalValue.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  input.value = parts.join('.');
}

// Auto-format input to add K if needed (e.g., 46.1 -> 46.1K, 23K -> 23.0K)
// For simple numbers like 22, 9, 12 - treat as thousands and add random decimal (22.3K, 9.1K, 12.7K)
function autoFormatKValue(input) {
  let value = input.value.trim();
  if (!value) return;
  
  // If it's a decimal number without K/M suffix (like 46.1 or 5.6)
  const decimalMatch = value.match(/^(\d+\.\d+)$/);
  if (decimalMatch) {
    // Add K suffix
    input.value = value + 'K';
    autoGenerateTooltip(input);
    return;
  }
  
  // If it's K without decimal (23K -> 23.0K)
  const kNoDecimalMatch = value.match(/^(\d+)\s*K$/i);
  if (kNoDecimalMatch) {
    input.value = kNoDecimalMatch[1] + '.0K';
    autoGenerateTooltip(input);
    return;
  }
  
  // If it's M without decimal (5M -> 5.0M)
  const mNoDecimalMatch = value.match(/^(\d+)\s*M$/i);
  if (mNoDecimalMatch) {
    input.value = mNoDecimalMatch[1] + '.0M';
    autoGenerateTooltip(input);
    return;
  }
  
  // If it's K/M with decimal already - just ensure proper format
  const kWithDecimalMatch = value.match(/^(\d+\.\d+)\s*K$/i);
  if (kWithDecimalMatch) {
    input.value = kWithDecimalMatch[1] + 'K';
    autoGenerateTooltip(input);
    return;
  }
  
  const mWithDecimalMatch = value.match(/^(\d+\.\d+)\s*M$/i);
  if (mWithDecimalMatch) {
    input.value = mWithDecimalMatch[1] + 'M';
    autoGenerateTooltip(input);
    return;
  }
  
  // If it's just a whole number (22, 9, 12) - treat as thousands with random decimal
  const wholeNumberMatch = value.match(/^(\d+)$/);
  if (wholeNumberMatch) {
    const num = parseInt(wholeNumberMatch[1]);
    // For small numbers (1-999), treat as thousands and add random decimal
    if (num < 1000) {
      const randomDecimal = Math.floor(Math.random() * 10); // 0-9
      input.value = num + '.' + randomDecimal + 'K';
      autoGenerateTooltip(input);
      return;
    }
    // For large numbers (>=1000), format properly
    input.value = formatNumber(num);
    autoGenerateTooltip(input);
  }
}

// Auto-generate tooltip value based on the count field value
// Generates a random number within the valid range for that K/M value
function autoGenerateTooltip(countInput) {
  const tooltipInput = countInput === fansCountInput ? fansTooltipInput : followingTooltipInput;
  
  // Only auto-generate if tooltip is empty or user hasn't manually set a valid value
  const currentTooltip = tooltipInput.value.trim();
  const countValue = countInput.value.trim();
  
  if (!countValue) return;
  
  const range = getTooltipRange(countValue);
  if (range.min === 0 && range.max === 0) return;
  
  // If tooltip is empty or current value is outside valid range, generate new one
  if (!currentTooltip || !validateTooltipSilent(countInput, tooltipInput)) {
    // Generate random value within valid range
    const randomOffset = Math.floor(Math.random() * 99) - 49; // -49 to +49
    const centerValue = Math.round((range.min + range.max) / 2);
    const newTooltip = Math.max(range.min, Math.min(range.max, centerValue + randomOffset));
    tooltipInput.value = newTooltip.toString();
    
    // Clear any error state
    const wrapper = tooltipInput.closest('.input-wrapper-combined');
    if (wrapper) wrapper.classList.remove('error');
    hideTooltipHint(tooltipInput);
  }
}

// Get valid tooltip range for a K/M value
// 47.0K = numbers that round to 47.0 when /1000 with toFixed(1)
// Range: 46950 to 47049
function getTooltipRange(kValue) {
  if (!kValue) return { min: 0, max: 0 };
  
  const str = kValue.toString().trim().toUpperCase();
  
  // Parse the K value (e.g., "47.0K" -> 47.0)
  const kMatch = str.match(/^([\d.]+)\s*K$/i);
  if (kMatch) {
    const num = parseFloat(kMatch[1]);
    // 47.0K means values 46950-47049 (round to 47.0 with toFixed(1))
    const center = Math.round(num * 1000);
    const min = center - 50;
    const max = center + 49;
    return { min: Math.max(0, min), max };
  }
  
  const mMatch = str.match(/^([\d.]+)\s*M$/i);
  if (mMatch) {
    const num = parseFloat(mMatch[1]);
    const center = Math.round(num * 1000000);
    const min = center - 50000;
    const max = center + 49999;
    return { min: Math.max(0, min), max };
  }
  
  // If it's just a number
  const plainNum = parseInt(str.replace(/[^\d]/g, ''));
  if (plainNum) {
    return { min: plainNum, max: plainNum };
  }
  
  return { min: 0, max: 0 };
}

// Show/hide tooltip hint popup
function showTooltipHint(tooltipInput, message) {
  // Remove existing hint
  hideTooltipHint(tooltipInput);
  
  const wrapper = tooltipInput.closest('.input-wrapper-combined');
  const hint = document.createElement('div');
  hint.className = 'tooltip-hint';
  hint.innerHTML = message;
  wrapper.appendChild(hint);
  
  // Animate in
  requestAnimationFrame(() => hint.classList.add('show'));
}

function hideTooltipHint(tooltipInput) {
  const wrapper = tooltipInput.closest('.input-wrapper-combined');
  const existingHint = wrapper.querySelector('.tooltip-hint');
  if (existingHint) {
    existingHint.remove();
  }
}

// Update Apply button state
function updateApplyButtonState() {
  const fansValid = validateTooltipSilent(fansCountInput, fansTooltipInput);
  const followingValid = validateTooltipSilent(followingCountInput, followingTooltipInput);
  const hasChanges = checkForChanges();
  
  // Button is active only if: validation passes AND there are unsaved changes
  if (!fansValid || !followingValid || !hasChanges) {
    applyBtn.disabled = true;
    applyBtn.classList.add('disabled');
  } else {
    applyBtn.disabled = false;
    applyBtn.classList.remove('disabled');
  }
}

// Silent validation (no UI changes, just returns true/false)
function validateTooltipSilent(countInput, tooltipInput) {
  const countValue = countInput.value.trim();
  const tooltipValue = tooltipInput.value.trim();
  
  if (!countValue || !tooltipValue) return true;
  
  const range = getTooltipRange(countValue);
  const tooltip = parseInt(tooltipValue.replace(/[^\d]/g, '')) || 0;
  
  return tooltip >= range.min && tooltip <= range.max;
}

// Validate tooltip against count value (with UI feedback)
function validateTooltip(countInput, tooltipInput) {
  const wrapper = tooltipInput.closest('.input-wrapper-combined');
  const countValue = countInput.value.trim();
  const tooltipValue = tooltipInput.value.trim();
  
  if (!countValue || !tooltipValue) {
    wrapper.classList.remove('error');
    hideTooltipHint(tooltipInput);
    updateApplyButtonState();
    return true;
  }
  
  const range = getTooltipRange(countValue);
  const tooltip = parseInt(tooltipValue.replace(/[^\d]/g, '')) || 0;
  
  if (tooltip < range.min || tooltip > range.max) {
    wrapper.classList.add('error');
    showTooltipHint(tooltipInput, `<span class="hint-label">Range:</span> <span class="hint-value">${range.min.toLocaleString()} - ${range.max.toLocaleString()}</span>`);
    updateApplyButtonState();
    return false;
  }
  
  wrapper.classList.remove('error');
  hideTooltipHint(tooltipInput);
  updateApplyButtonState();
  return true;
}

// Create floating number animation
function createFloatingNumber(button, amount) {
  const rect = button.getBoundingClientRect();
  const floatingNum = document.createElement('div');
  floatingNum.className = 'floating-number';
  floatingNum.textContent = '+' + amount;
  floatingNum.style.left = (rect.left + rect.width / 2 - 20) + 'px';
  floatingNum.style.top = (rect.top) + 'px';
  
  floatingNumbers.appendChild(floatingNum);
  
  setTimeout(() => {
    floatingNum.remove();
  }, 1500);
}

// Quick add fans or following
function quickAdd(target, amount, button) {
  if (target === 'fans') {
    // Current fans count
    const currentFans = parseNumber(fansCountInput.value);
    const newFans = currentFans + amount;
    const newFormatted = formatNumber(newFans);
    fansCountInput.value = newFormatted;
    
    // Generate tooltip within valid range
    const range = getTooltipRange(newFormatted);
    // Random value within the valid range
    const randomOffset = Math.floor(Math.random() * 99) - 49; // -49 to +49
    const newTooltip = Math.max(range.min, Math.min(range.max, newFans + randomOffset));
    fansTooltipInput.value = newTooltip.toString();
    
    // Re-validate tooltip and remove error UI if fixed
    fansTooltipInput.value = newTooltip.toString();
    validateTooltip(fansCountInput, fansTooltipInput);
  } else if (target === 'following') {
    // Current following count
    const currentFollowing = parseNumber(followingCountInput.value);
    const newFollowing = currentFollowing + amount;
    const newFormatted = formatNumber(newFollowing);
    followingCountInput.value = newFormatted;
    
    // Generate tooltip within valid range
    const range = getTooltipRange(newFormatted);
    const randomOffset = Math.floor(Math.random() * 99) - 49;
    const newTooltip = Math.max(range.min, Math.min(range.max, newFollowing + randomOffset));
    followingTooltipInput.value = newTooltip.toString();
    validateTooltip(followingCountInput, followingTooltipInput);
  }
  
  // Animation
  createFloatingNumber(button, amount);
  
  // Update icons and states
  updateIconFills();
  updateTooltipFieldsState();
  updateApplyButtonState();
  
  // Don't auto-save - user must click Apply Changes
}

// Apply changes to the page
async function applyChanges() {
  // Check if subscription is still active
  const isActive = await checkSubscriptionAndRedirect();
  if (!isActive) {
    showToast('Your subscription has expired. Please renew to continue.', 'error');
    return;
  }
  
  // Check if user can add this model (subscription limit check)
  const currentModelUsername = modelNameEl.textContent.replace('@', '').toLowerCase();
  if (currentModelUsername && currentModelUsername !== 'not_detected') {
    const canAdd = await checkAndAddModel(currentModelUsername);
    if (!canAdd) {
      showToast('Model limit reached! Upgrade your plan.', 'error');
      return;
    }
  }
  
  // Auto-format fields before saving
  autoFormatPercentage(topCreatorsInput);
  autoFormatBalanceValue(currentBalanceInput);
  autoFormatBalanceValue(pendingBalanceInput);
  
  const saved = await saveSettings();
  
  if (!saved) {
    showToast('Error saving settings', 'error');
    return;
  }
  
  // IMPORTANT: Clear reset pending flag and statistics chart disabled flag explicitly
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('onlyfans.com')) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          localStorage.removeItem('ofStatsResetPending');
          // Clear statistics chart disabled flag - user is applying settings, so enable generation again
          localStorage.removeItem('ofStatsStatisticsChartDisabled');
          // Note: log() not available in page context
        }
      });
    }
  } catch (e) {
    log('Could not clear reset pending flag:', e);
  }
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab) {
      showToast('No active tab found', 'error');
      return;
    }
    
    if (!tab.url || !tab.url.includes('onlyfans.com')) {
      showToast('Please open OnlyFans website', 'error');
      return;
    }
    
    const settings = {
      enabled: mainToggle.checked,
      topCreators: topCreatorsInput.value,
      currentBalance: currentBalanceInput.value,
      pendingBalance: pendingBalanceInput.value,
      earningsCount: earningsCountInput.value,
      earningsCompleteCount: earningsCompleteCountInput.value,
      fansCount: fansCountInput.value,
      fansTooltip: fansTooltipInput.value,
      followingCount: followingCountInput.value,
      followingTooltip: followingTooltipInput.value
    };
    
    try {
      // Start loading animation in popup
      applyBtn.disabled = true;
      applyBtn.classList.add('loading');
      // add spinner if not present
      if (!applyBtn.querySelector('.btn-spinner')) {
        const spinner = document.createElement('span');
        spinner.className = 'btn-spinner';
        applyBtn.appendChild(spinner);
      }

      // Get ALL OnlyFans tabs
      const allTabs = await chrome.tabs.query({ url: '*://*.onlyfans.com/*' });
      
      // Determine which tabs need to be reloaded based on current page and settings
      // If we're changing earnings-related settings, reload all earnings pages
      const earningsPages = ['/my/statements/earnings', '/my/statistics/statements/earnings', '/my/stats/earnings'];
      const currentIsEarningsPage = earningsPages.some(p => tab.url.includes(p));
      const hasEarningsSettings = earningsCountInput.value || earningsCompleteCountInput.value || 
                                   currentBalanceInput.value || pendingBalanceInput.value || 
                                   topCreatorsInput.value;
      
      // Tabs to reload: current tab + other earnings tabs if we're on earnings page or have earnings settings
      const tabsToReload = [tab];
      
      if (currentIsEarningsPage || hasEarningsSettings) {
        // Find other earnings tabs (not the current one)
        for (const t of allTabs) {
          if (t.id !== tab.id && t.url) {
            const isEarningsTab = earningsPages.some(p => t.url.includes(p));
            if (isEarningsTab) {
              tabsToReload.push(t);
            }
          }
        }
      }
      
      // Update localStorage cache on ALL OnlyFans tabs first (for instant apply on next visit)
      const settingsJSON = JSON.stringify(settings);
      for (const t of allTabs) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: t.id },
            func: (json) => {
              localStorage.setItem('ofStatsCache', json);
            },
            args: [settingsJSON]
          });
        } catch (e) {
          // Tab might not be ready, ignore
        }
      }
      
      // Send applyChanges message to all tabs being reloaded
      for (const t of tabsToReload) {
        try {
          await chrome.tabs.sendMessage(t.id, { 
            action: 'applyChanges', 
            settings: settings 
          });
        } catch (e) {
          // Content script might not be loaded
        }
      }

      // Track how many tabs we're waiting for
      let tabsLoading = tabsToReload.length;
      const tabIdsToReload = tabsToReload.map(t => t.id);
      
      // Reload all tabs that need updating
      for (const t of tabsToReload) {
        try {
          await chrome.tabs.reload(t.id);
        } catch (reloadErr) {
          try { chrome.tabs.reload(t.id); } catch(e){}
          tabsLoading--;
        }
      }

      // Wait for tabs to finish loading (status === 'complete') or timeout
      const onUpdated = (updatedTabId, changeInfo) => {
        if (tabIdsToReload.includes(updatedTabId) && changeInfo.status === 'complete') {
          tabsLoading--;
          
          // When all tabs are loaded, cleanup
          if (tabsLoading <= 0) {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            applyBtn.classList.remove('loading');
            const spinnerEl = applyBtn.querySelector('.btn-spinner');
            if (spinnerEl) spinnerEl.remove();
            
            // Mark changes as saved - update saved state and disable button
            saveCurrentFormState();
            hasUnsavedChanges = false;
            updateApplyButtonState();
            
            const reloadedCount = tabsToReload.length;
            if (reloadedCount > 1) {
              showToast('Changes applied to ' + reloadedCount + ' pages');
            } else {
              showToast('Page reloaded and changes applied');
            }
          }
        }
      };

      chrome.tabs.onUpdated.addListener(onUpdated);

      // Fallback timeout to remove spinner if onUpdated doesn't fire
      setTimeout(() => {
        try {
          chrome.tabs.onUpdated.removeListener(onUpdated);
        } catch(e){}
        if (applyBtn.classList.contains('loading')) {
          applyBtn.classList.remove('loading');
          const spinnerEl = applyBtn.querySelector('.btn-spinner');
          if (spinnerEl) spinnerEl.remove();
          
          // Still mark as saved even on timeout
          saveCurrentFormState();
          hasUnsavedChanges = false;
          updateApplyButtonState();
          
          showToast('Settings saved - reload may still be in progress', 'warning');
        }
      }, 15000);

    } catch (e) {
      log('Could not reach content script:', e);
      applyBtn.classList.remove('loading');
      const spinnerEl = applyBtn.querySelector('.btn-spinner');
      if (spinnerEl) spinnerEl.remove();
      applyBtn.disabled = false;
      showToast('Settings saved! Reload the page.', 'warning');
    }
  } catch (error) {
    logError('Error applying changes:', error);
    showToast('Settings saved! Reload the page.', 'warning');
  }
}

// Reset all settings
async function resetSettings() {
  // Add spinning animation to reset button
  resetBtn.classList.add('spinning');
  
  topCreatorsInput.value = '';
  currentBalanceInput.value = '';
  pendingBalanceInput.value = '';
  earningsCountInput.value = '';
  earningsCompleteCountInput.value = '';
  fansCountInput.value = '';
  fansTooltipInput.value = '';
  followingCountInput.value = '';
  followingTooltipInput.value = '';
  
  updateIconFills();
  updateTooltipFieldsState();
  await saveSettings();
  
  // ALWAYS clear earnings cache on reset
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('onlyfans.com')) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // Set flag to disable statistics chart generation until GROSS is changed or Apply is clicked
          localStorage.setItem('ofStatsStatisticsChartDisabled', 'true');
          // Note: log() not available in page context
          
          // Clear /my/statements/earnings cache (transaction rows)
          localStorage.removeItem('ofStatsEarningsData');
          localStorage.removeItem('ofStatsEarningsKey');
          
          // NOTE: Don't clear any earning stats or chart caches on Reset!
          // These hold the randomly generated data that should persist.
          // Clearing them causes charts to regenerate with new random data
          // on every F5, which looks like a bug.
          // - ofStatsEarningStats: monthly data for Gross calculation
          // - ofStatsChartDataCache: cached chart points data
          // - ofStatsChartGrossValue: Gross value used for chart cache key
          // - ofStatsEarningsBreakdownCache: earnings breakdown data
          // - ofStatsAutoTransactionsData: auto-generated transactions
          // - ofStatsAutoTransactionsGross: Gross for auto-transactions cache
          // Users can change Gross by clicking on it if they want new values.
          
          // NOTE: Don't clear ofStatsCache here - saveSettings() already wrote
          // the correct (empty) values to it. Clearing it would cause
          // inject-early.js to exit early and break functionality like Gross click.
          
          // Remove the months-applied flag so page will re-render on next load
          var container = document.querySelector('.b-stats-wrap');
          if (container) {
            container.removeAttribute('data-of-stats-months-applied');
            container.removeAttribute('data-of-stats-months-replaced');
          }
          
          // Stop the observer that hides original elements
          if (typeof stopOriginalElementsObserver === 'function') {
            stopOriginalElementsObserver();
          } else if (window.ofStatsOriginalElementsObserver) {
            window.ofStatsOriginalElementsObserver.disconnect();
            window.ofStatsOriginalElementsObserver = null;
          }
          
          // Reset /my/statistics/statements/earnings page flags and destroy existing charts
          var statisticsWrapper = document.querySelector('.b-statistics-page-content__wrapper');
          if (statisticsWrapper) {
            // Destroy Chart.js instances before removing canvas elements
            var mainCanvas = document.getElementById('of-stats-earnings-chart-main');
            var asideCanvas = document.getElementById('of-stats-earnings-chart-aside');
            if (typeof Chart !== 'undefined') {
              if (mainCanvas) {
                var mainChart = Chart.getChart(mainCanvas);
                if (mainChart) mainChart.destroy();
              }
              if (asideCanvas) {
                var asideChart = Chart.getChart(asideCanvas);
                if (asideChart) asideChart.destroy();
              }
              // Also destroy any mini charts
              document.querySelectorAll('canvas[id^="of-stats-mini-chart-"]').forEach(function(canvas) {
                var chart = Chart.getChart(canvas);
                if (chart) chart.destroy();
              });
            }
            
            statisticsWrapper.querySelectorAll('[data-of-stats-generated]').forEach(function(el) {
              el.remove();
            });
            statisticsWrapper.removeAttribute('data-of-stats-applied');
            
            // Restore original hidden elements
            statisticsWrapper.querySelectorAll('[data-of-stats-original-hidden]').forEach(function(el) {
              el.removeAttribute('data-of-stats-original-hidden');
              el.style.display = '';
            });
          }
          // Reset Earnings section processed flag to show original content
          document.querySelectorAll('.b-useful-data[data-of-stats-processed]').forEach(function(el) {
            el.removeAttribute('data-of-stats-processed');
          });
          
          // Remove hiding style to show original content on statistics/statements/earnings page
          var hideEarningsStyle = document.getElementById('of-stats-hide-earnings-content');
          if (hideEarningsStyle) {
            hideEarningsStyle.remove();
            log('OF Stats: Removed hide-earnings-content style (Reset clicked)');
          }
        }
      });
    }
  } catch (e) {
    log('Could not clear earnings cache:', e);
  }
  
  // Update saved state after reset
  saveCurrentFormState();
  hasUnsavedChanges = false;
  updateApplyButtonState();
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tab && tab.url && tab.url.includes('onlyfans.com')) {
      await chrome.tabs.sendMessage(tab.id, { action: 'resetChanges' });
      
      // Reload the tab so reset takes effect instantly
      try {
        await chrome.tabs.reload(tab.id);
      } catch (reloadErr) {
        try { chrome.tabs.reload(tab.id); } catch(e){}
      }
    }
  } catch (error) {
    log('Could not reset page:', error);
  }
  
  showToast('Settings reset!');
  
  // Remove spinning animation after it completes
  setTimeout(() => {
    resetBtn.classList.remove('spinning');
  }, 500);
}

// Show toast notification
function showToast(message, type = 'success') {
  const existingToast = document.querySelector('.toast');
  if (existingToast) {
    existingToast.remove();
  }
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => toast.classList.add('show'), 10);
  
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// Setup event listeners
function setupEventListeners() {
  // Main toggle
  mainToggle.addEventListener('change', async () => {
    const enabled = mainToggle.checked;
    
    // Check subscription before enabling
    if (enabled) {
      const isActive = await checkSubscriptionAndRedirect();
      if (!isActive) {
        mainToggle.checked = false;
        showToast('Your subscription has expired. Please renew to continue.', 'error');
        return;
      }
    }
    
    updateStatusIndicator(enabled);
    updateContainerState(enabled);
    await saveSettings();
    
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (tab && tab.url && tab.url.includes('onlyfans.com')) {
        const settings = {
          enabled: enabled,
          currentBalance: currentBalanceInput.value,
          pendingBalance: pendingBalanceInput.value,
          fansCount: fansCountInput.value,
          fansTooltip: fansTooltipInput.value,
          followingCount: followingCountInput.value,
          followingTooltip: followingTooltipInput.value
        };
        
        await chrome.tabs.sendMessage(tab.id, { 
          action: enabled ? 'applyChanges' : 'resetChanges', 
          settings: settings 
        });
      }
    } catch (error) {
      log('Could not toggle changes:', error);
    }
  });
  
  // Apply button
  applyBtn.addEventListener('click', applyChanges);
  
  // Reset button
  resetBtn.addEventListener('click', resetSettings);
  
  // Quick add buttons
  document.querySelectorAll('.quick-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      const amount = parseInt(btn.dataset.amount);
      quickAdd(target, amount, btn);
    });
  });
  
  // Input validation - only allow specific characters
  // Top Creators field: digits, dot, percent sign
  topCreatorsInput.addEventListener('keypress', (e) => {
    const char = e.key;
    // Allow: digits, dot, percent
    if (!/[\d.%]/.test(char) && !['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) {
      e.preventDefault();
    }
  });
  
  topCreatorsInput.addEventListener('input', (e) => {
    // Remove any non-allowed characters that might be pasted
    e.target.value = e.target.value.replace(/[^\d.%]/g, '');
  });
  
  // Auto-format percentage on blur for Top Creators field
  topCreatorsInput.addEventListener('blur', () => {
    autoFormatPercentage(topCreatorsInput);
    updateIconFills();
    updateApplyButtonState();
  });
  
  // Balance fields: digits, dot, comma - with validation to prevent multiple dots
  [currentBalanceInput, pendingBalanceInput].forEach(input => {
    input.addEventListener('keypress', (e) => {
      const char = e.key;
      // Allow navigation keys
      if (['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) {
        return;
      }
      // Allow: digits, comma always
      if (/[\d,]/.test(char)) {
        return;
      }
      // Allow dot only if there isn't one already
      if (char === '.') {
        const currentValue = e.target.value.replace(/,/g, '');
        if (currentValue.includes('.')) {
          e.preventDefault(); // Already has a dot, don't allow another
          return;
        }
        return;
      }
      // Block everything else
      e.preventDefault();
    });
    
    input.addEventListener('input', (e) => {
      // Remove non-allowed characters and ensure only one dot
      let value = e.target.value.replace(/[^\d.,]/g, '');
      // Remove all dots except the first one
      const parts = value.split('.');
      if (parts.length > 2) {
        value = parts[0] + '.' + parts.slice(1).join('');
      }
      // Limit decimal places to 2
      if (parts.length === 2 && parts[1].length > 2) {
        value = parts[0] + '.' + parts[1].substring(0, 2);
      }
      e.target.value = value;
    });
    
    // Auto-format balance on blur to ensure proper cents format
    input.addEventListener('blur', () => {
      autoFormatBalanceValue(input);
      updateApplyButtonState();
    });
  });
  
  // Count fields: digits, dot, K, M
  [fansCountInput, followingCountInput].forEach(input => {
    input.addEventListener('keypress', (e) => {
      const char = e.key;
      // Allow: digits, dot, K, M, k, m
      if (!/[\d.KkMm]/.test(char) && !['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) {
        e.preventDefault();
      }
    });
    
    input.addEventListener('input', (e) => {
      // Remove any non-allowed characters, keep only digits, dot, K, M
      e.target.value = e.target.value.replace(/[^\d.KkMm]/g, '');
    });
  });
  
  // Tooltip fields: only digits
  [fansTooltipInput, followingTooltipInput].forEach(input => {
    input.addEventListener('keypress', (e) => {
      const char = e.key;
      // Allow only digits
      if (!/\d/.test(char) && !['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) {
        e.preventDefault();
      }
    });
    
    input.addEventListener('input', (e) => {
      // Remove any non-digit characters
      e.target.value = e.target.value.replace(/\D/g, '');
    });
  });
  
  // Earnings count field: only digits
  earningsCountInput.addEventListener('keypress', (e) => {
    const char = e.key;
    if (!/\d/.test(char) && !['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) {
      e.preventDefault();
    }
  });
  
  earningsCountInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '');
  });
  
  // Earnings complete count field: only digits
  earningsCompleteCountInput.addEventListener('keypress', (e) => {
    const char = e.key;
    if (!/\d/.test(char) && !['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) {
      e.preventDefault();
    }
  });
  
  earningsCompleteCountInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '');
  });
  
  // Update UI on input change but DON'T auto-save - only Apply Changes saves
  const inputs = [topCreatorsInput, currentBalanceInput, pendingBalanceInput, earningsCountInput, earningsCompleteCountInput, fansCountInput, fansTooltipInput, followingCountInput, followingTooltipInput];
  inputs.forEach(input => {
    input.addEventListener('input', () => {
      updateIconFills();
      updateTooltipFieldsState();
      updateApplyButtonState();
      // Removed auto-save - values only apply after clicking Apply Changes
    });
  });
  
  // Auto-format K value on blur for fans/following count fields
  fansCountInput.addEventListener('blur', () => {
    autoFormatKValue(fansCountInput);
    updateIconFills();
    updateTooltipFieldsState();
    updateApplyButtonState();
  });
  
  followingCountInput.addEventListener('blur', () => {
    autoFormatKValue(followingCountInput);
    updateIconFills();
    updateTooltipFieldsState();
    updateApplyButtonState();
  });
  
  // Validate tooltip in real-time on input
  fansTooltipInput.addEventListener('input', () => {
    validateTooltip(fansCountInput, fansTooltipInput);
  });
  
  followingTooltipInput.addEventListener('input', () => {
    validateTooltip(followingCountInput, followingTooltipInput);
  });
  
  // Also validate and update tooltip state when count changes
  fansCountInput.addEventListener('input', () => {
    updateTooltipFieldsState();
    if (fansTooltipInput.value.trim()) {
      validateTooltip(fansCountInput, fansTooltipInput);
    }
  });
  
  followingCountInput.addEventListener('input', () => {
    updateTooltipFieldsState();
    if (followingTooltipInput.value.trim()) {
      validateTooltip(followingCountInput, followingTooltipInput);
    }
  });
  
  // Keep showing hint - don't hide on blur anymore
  // (hint stays visible as long as there's an error)
  
  // Show hint again on focus if there's an error
  fansTooltipInput.addEventListener('focus', () => {
    validateTooltip(fansCountInput, fansTooltipInput);
  });
  
  followingTooltipInput.addEventListener('focus', () => {
    validateTooltip(followingCountInput, followingTooltipInput);
  });
  
  // Disable Enter key saving – only Apply button triggers save
  inputs.forEach(input => {
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // prevent accidental saves; do nothing on Enter
      }
    });
  });
}

// ==================== PRESETS FUNCTIONALITY ====================

let activePresetName = '';

// Load presets from storage
async function loadPresets() {
  try {
    const result = await chrome.storage.local.get(['ofStatsPresets', 'ofStatsActivePreset']);
    currentPresets = result.ofStatsPresets || {};
    activePresetName = result.ofStatsActivePreset || '';
    updatePresetSelect();
    
    // Restore active preset selection
    if (activePresetName && currentPresets[activePresetName]) {
      presetSelect.value = activePresetName;
      deletePresetBtn.disabled = false;
      // Update custom dropdown to show selected preset
      updateCustomDropdownSelection();
    }
  } catch (error) {
    logError('Error loading presets:', error);
    currentPresets = {};
  }
}

// Save presets to storage
async function savePresets() {
  try {
    await chrome.storage.local.set({ ofStatsPresets: currentPresets });
    return true;
  } catch (error) {
    logError('Error saving presets:', error);
    return false;
  }
}

// Save active preset name
async function saveActivePreset(name) {
  try {
    activePresetName = name || '';
    await chrome.storage.local.set({ ofStatsActivePreset: activePresetName });
  } catch (error) {
    logError('Error saving active preset:', error);
  }
}

// Update custom dropdown options
function updateCustomDropdown() {
  // Clear dropdown except first option
  presetDropdown.innerHTML = '<div class="custom-select-option selected" data-value="">No preset</div>';
  
  // Add presets sorted by name
  const presetNames = Object.keys(currentPresets).sort((a, b) => 
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  
  presetNames.forEach(name => {
    const option = document.createElement('div');
    option.className = 'custom-select-option';
    option.dataset.value = name;
    option.textContent = name;
    presetDropdown.appendChild(option);
  });
  
  // Update selected state
  updateCustomDropdownSelection();
}

// Update selection in custom dropdown
function updateCustomDropdownSelection() {
  const currentValue = presetSelect.value;
  presetSelectText.textContent = currentValue || 'No preset';
  
  // Update selected class
  presetDropdown.querySelectorAll('.custom-select-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.value === currentValue);
  });
}

// Update preset select dropdown
function updatePresetSelect() {
  // Clear existing options except the first one
  while (presetSelect.options.length > 1) {
    presetSelect.remove(1);
  }
  
  // Add presets sorted by name
  const presetNames = Object.keys(currentPresets).sort((a, b) => 
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  
  presetNames.forEach(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    presetSelect.appendChild(option);
  });
  
  // Update delete button state
  deletePresetBtn.disabled = presetSelect.value === '';
  
  // Update custom dropdown
  updateCustomDropdown();
}

// Get current form data as preset
function getCurrentFormDataForPreset() {
  return {
    enabled: mainToggle.checked,
    topCreators: topCreatorsInput.value,
    currentBalance: currentBalanceInput.value,
    pendingBalance: pendingBalanceInput.value,
    earningsCount: earningsCountInput.value,
    earningsCompleteCount: earningsCompleteCountInput.value,
    fansCount: fansCountInput.value,
    fansTooltip: fansTooltipInput.value,
    followingCount: followingCountInput.value,
    followingTooltip: followingTooltipInput.value,
    // Save timestamp for reference
    savedAt: new Date().toISOString()
  };
}

// Get earning stats data from the page's localStorage (for presets)
async function getEarningStatsFromPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('onlyfans.com')) {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const earningStats = localStorage.getItem('ofStatsEarningStats');
          return earningStats ? JSON.parse(earningStats) : null;
        }
      });
      return result[0]?.result || null;
    }
  } catch (e) {
    log('Could not get earning stats from page:', e);
  }
  return null;
}

// Set earning stats data to the page's localStorage (for presets)
async function setEarningStatsToPage(earningStatsData) {
  if (!earningStatsData) return false;
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('onlyfans.com')) {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (data) => {
          // Mark data as loaded from preset to skip validation on reload
          data.fromPreset = true;
          data.presetLoadedAt = Date.now();
          
          // Extract oldest month from months array and save it
          // This allows regenerating months while preserving the same date range
          if (data.months && data.months.length > 0) {
            const oldestMonth = data.months[data.months.length - 1];
            data.oldestMonth = {
              year: oldestMonth.year,
              month: oldestMonth.month
            };
            // Note: console.log here runs in page context, not extension
          }
          
          localStorage.setItem('ofStatsEarningStats', JSON.stringify(data));
          // Clear chart caches so they regenerate with new values
          localStorage.removeItem('ofStatsChartDataCache');
          localStorage.removeItem('ofStatsChartGrossValue');
          localStorage.removeItem('ofStatsEarningsBreakdownCache');
          // Remove applied flags to force re-render
          const container = document.querySelector('.b-stats-wrap');
          if (container) {
            container.removeAttribute('data-of-stats-months-applied');
            container.removeAttribute('data-of-stats-months-replaced');
          }
          // Note: console.log here runs in page context, not extension
          
          // Verify the data was saved correctly
          const verified = localStorage.getItem('ofStatsEarningStats');
          return verified ? JSON.parse(verified).fromPreset === true : false;
        },
        args: [earningStatsData]
      });
      
      // Check if data was saved successfully
      if (result && result[0] && result[0].result === true) {
        log('OF Stats: Earning stats saved and verified');
        return true;
      }
    }
  } catch (e) {
    log('Could not set earning stats to page:', e);
  }
  return false;
}

// Clear earning stats from page's localStorage (for resetting to random generation)
async function clearEarningStatsFromPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('onlyfans.com')) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // Remove earning stats so they will regenerate randomly
          localStorage.removeItem('ofStatsEarningStats');
          // Clear all chart caches
          localStorage.removeItem('ofStatsChartDataCache');
          localStorage.removeItem('ofStatsChartGrossValue');
          localStorage.removeItem('ofStatsEarningsBreakdownCache');
          // Remove applied flags to force re-render
          const container = document.querySelector('.b-stats-wrap');
          if (container) {
            container.removeAttribute('data-of-stats-months-applied');
            container.removeAttribute('data-of-stats-months-replaced');
          }
          // Note: log() is not available in page context
        }
      });
    }
  } catch (e) {
    log('Could not clear earning stats from page:', e);
  }
}

// Clear ONLY transaction table data (not charts/earning stats) for fresh regeneration
async function clearTransactionDataFromPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('onlyfans.com')) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // Clear ONLY transaction table data - this is the earnings rows shown in the table
          localStorage.removeItem('ofStatsEarningsData');
          localStorage.removeItem('ofStatsEarningsKey');
          // Note: We keep ofStatsEarningStats (charts/monthly data) intact
        }
      });
    }
  } catch (e) {
    log('Could not clear transaction data from page:', e);
  }
}

// Load preset data into form
async function loadPresetIntoForm(presetData, applyEarningStats = true) {
  if (!presetData) return;
  
  // Check if subscription is active - if not, don't enable toggle
  const subscriptionActive = hasActiveSubscription();
  
  // Only enable toggle if subscription is active AND preset says enabled
  const shouldEnable = subscriptionActive && presetData.enabled !== false;
  
  mainToggle.checked = shouldEnable;
  mainToggle.disabled = !subscriptionActive;
  
  topCreatorsInput.value = presetData.topCreators || '';
  currentBalanceInput.value = presetData.currentBalance || '';
  pendingBalanceInput.value = presetData.pendingBalance || '';
  earningsCountInput.value = presetData.earningsCount || '';
  earningsCompleteCountInput.value = presetData.earningsCompleteCount || '';
  fansCountInput.value = presetData.fansCount || '';
  fansTooltipInput.value = presetData.fansTooltip || '';
  followingCountInput.value = presetData.followingCount || '';
  followingTooltipInput.value = presetData.followingTooltip || '';
  
  // Restore earning stats if present in preset (await to ensure it's set before page reload)
  if (applyEarningStats && presetData.earningStats) {
    await setEarningStatsToPage(presetData.earningStats);
  }
  
  // Clear transaction table data so it regenerates fresh each time preset is loaded
  // This affects only the Earnings table rows (Pending|Complete), not charts
  if (presetData.earningsCount || presetData.earningsCompleteCount) {
    await clearTransactionDataFromPage();
  }
  
  // Save current form state so Apply button shows correct state (no changes)
  saveCurrentFormState();
  
  // Update UI
  updateStatusIndicator(shouldEnable);
  updateContainerState(shouldEnable);
  updateIconFills();
  updateTooltipFieldsState();
  updateApplyButtonState();
}

// Clear form to default values (when selecting "No preset")
function clearFormToDefaults() {
  // Check if subscription is active
  const subscriptionActive = hasActiveSubscription();
  const shouldEnable = subscriptionActive && defaultSettings.enabled;
  
  mainToggle.checked = shouldEnable;
  mainToggle.disabled = !subscriptionActive;
  
  topCreatorsInput.value = defaultSettings.topCreators;
  currentBalanceInput.value = defaultSettings.currentBalance;
  pendingBalanceInput.value = defaultSettings.pendingBalance;
  earningsCountInput.value = defaultSettings.earningsCount;
  earningsCompleteCountInput.value = defaultSettings.earningsCompleteCount;
  fansCountInput.value = defaultSettings.fansCount;
  fansTooltipInput.value = defaultSettings.fansTooltip;
  followingCountInput.value = defaultSettings.followingCount;
  followingTooltipInput.value = defaultSettings.followingTooltip;
  
  // Save current form state so Apply button shows correct state
  saveCurrentFormState();
  
  // Update UI
  updateStatusIndicator(shouldEnable);
  updateContainerState(shouldEnable);
  updateIconFills();
  updateTooltipFieldsState();
  updateApplyButtonState();
}

// Show save preset modal
function showSavePresetModal() {
  presetNameInput.value = '';
  presetModalOverlay.classList.add('active');
  setTimeout(() => presetNameInput.focus(), 100);
}

// Hide save preset modal
function hideSavePresetModal() {
  presetModalOverlay.classList.remove('active');
  presetNameInput.value = '';
}

// Show delete confirmation modal
function showDeleteModal(presetName) {
  deletePresetName.textContent = presetName;
  deleteModalOverlay.classList.add('active');
}

// Hide delete confirmation modal
function hideDeleteModal() {
  deleteModalOverlay.classList.remove('active');
}

// Save current settings as preset
async function saveCurrentAsPreset(name) {
  if (!name || !name.trim()) return false;
  
  const trimmedName = name.trim();
  const presetData = getCurrentFormDataForPreset();
  
  // Get earning stats from page and include in preset
  const earningStats = await getEarningStatsFromPage();
  if (earningStats) {
    presetData.earningStats = earningStats;
    log('OF Stats: Saving preset with earning stats - Gross: $' + earningStats.gross?.toFixed(2) + ', Net: $' + earningStats.net?.toFixed(2));
  }
  
  currentPresets[trimmedName] = presetData;
  
  if (await savePresets()) {
    updatePresetSelect();
    presetSelect.value = trimmedName;
    deletePresetBtn.disabled = false;
    
    // Update custom dropdown to show selected preset
    updateCustomDropdownSelection();
    
    // Save as active preset
    await saveActivePreset(trimmedName);
    
    // Show success animation on button
    showPresetSaveSuccess();
    
    // Show toast notification
    showToast('Preset saved!');
    
    return true;
  }
  
  return false;
}

// Delete preset
async function deletePreset(name) {
  if (!name || !currentPresets[name]) return false;
  
  delete currentPresets[name];
  
  if (await savePresets()) {
    updatePresetSelect();
    presetSelect.value = '';
    deletePresetBtn.disabled = true;
    
    // Clear active preset if it was deleted
    if (activePresetName === name) {
      await saveActivePreset('');
    }
    
    return true;
  }
  
  return false;
}

// Show save success animation
function showPresetSaveSuccess() {
  savePresetBtn.style.background = 'rgba(16, 185, 129, 0.2)';
  savePresetBtn.style.borderColor = 'var(--success)';
  savePresetBtn.style.color = 'var(--success)';
  
  setTimeout(() => {
    savePresetBtn.style.background = '';
    savePresetBtn.style.borderColor = '';
    savePresetBtn.style.color = '';
  }, 1000);
}

// Setup custom dropdown listeners
function setupCustomDropdown() {
  // Toggle dropdown on trigger click
  presetSelectTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    customPresetSelect.classList.toggle('open');
  });
  
  // Handle option click
  presetDropdown.addEventListener('click', async (e) => {
    const option = e.target.closest('.custom-select-option');
    if (!option) return;
    
    const value = option.dataset.value;
    presetSelect.value = value;
    customPresetSelect.classList.remove('open');
    
    // Trigger change event
    presetSelect.dispatchEvent(new Event('change'));
  });
  
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!customPresetSelect.contains(e.target)) {
      customPresetSelect.classList.remove('open');
    }
  });
}

// Setup preset event listeners
function setupPresetListeners() {
  // Setup custom dropdown
  setupCustomDropdown();
  
  // Preset select change - auto apply and reload
  presetSelect.addEventListener('change', async () => {
    const selectedPreset = presetSelect.value;
    deletePresetBtn.disabled = !selectedPreset;
    updateCustomDropdownSelection();
    
    if (selectedPreset && currentPresets[selectedPreset]) {
      // Load preset data into form (but DON'T set earning stats yet)
      await loadPresetIntoForm(currentPresets[selectedPreset], false);
      
      // Save as active preset
      await saveActivePreset(selectedPreset);
      
      // IMPORTANT: Check and add model to My Models to enforce subscription limit
      // Get current model from the page
      const currentModelUsername = modelNameEl?.textContent?.replace('@', '').toLowerCase();
      if (currentModelUsername && currentModelUsername !== 'not_detected' && currentModelUsername !== 'unknown') {
        const canAdd = await checkAndAddModel(currentModelUsername);
        if (!canAdd) {
          showToast('Model limit reached! Upgrade your plan.', 'error');
          // Reset preset selection
          presetSelect.value = '';
          updateCustomDropdownSelection();
          deletePresetBtn.disabled = true;
          await saveActivePreset('');
          return;
        }
      }
      
      // Auto-save settings with preserveEarningStats=true to prevent clearing
      // (we will set earning stats from preset after this)
      await saveSettings(true);
      
      // NOW set earning stats from preset AFTER saveSettings
      // This ensures preset data is the final state in localStorage
      if (currentPresets[selectedPreset].earningStats) {
        const success = await setEarningStatsToPage(currentPresets[selectedPreset].earningStats);
        if (success) {
          log('OF Stats: Preset earning stats saved successfully, waiting before reload...');
        }
      }
      
      // Longer delay to ensure all localStorage writes complete before reload
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Reload the OnlyFans page to apply changes
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url && tab.url.includes('onlyfans.com')) {
          chrome.tabs.reload(tab.id);
        }
      } catch (e) {
        log('Could not reload page:', e);
      }
    } else {
      // No preset selected - clear form to defaults and reload page
      clearFormToDefaults();
      await saveActivePreset('');
      
      // Save cleared settings
      await saveSettings();
      
      // Clear earning stats so they will regenerate randomly on reload
      await clearEarningStatsFromPage();
      
      // Reload the OnlyFans page to clear changes
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url && tab.url.includes('onlyfans.com')) {
          chrome.tabs.reload(tab.id);
        }
      } catch (e) {
        log('Could not reload page:', e);
      }
    }
  });
  
  // Save preset button - update existing or create new
  savePresetBtn.addEventListener('click', async () => {
    const selectedPreset = presetSelect.value;
    if (selectedPreset && currentPresets[selectedPreset]) {
      // Update existing preset
      await saveCurrentAsPreset(selectedPreset);
      showPresetSaveSuccess();
    } else {
      // Create new preset
      showSavePresetModal();
    }
  });
  
  // Delete preset button
  deletePresetBtn.addEventListener('click', () => {
    const selectedPreset = presetSelect.value;
    if (selectedPreset) {
      showDeleteModal(selectedPreset);
    }
  });
  
  // Modal cancel buttons
  presetModalCancel.addEventListener('click', () => {
    hideSavePresetModal();
  });
  
  deleteModalCancel.addEventListener('click', () => {
    hideDeleteModal();
  });
  
  // Modal save button
  presetModalSave.addEventListener('click', async () => {
    const name = presetNameInput.value.trim();
    if (name) {
      await saveCurrentAsPreset(name);
      hideSavePresetModal();
    }
  });
  
  // Modal delete confirm button
  deleteModalConfirm.addEventListener('click', async () => {
    const selectedPreset = presetSelect.value;
    if (selectedPreset) {
      await deletePreset(selectedPreset);
      hideDeleteModal();
    }
  });
  
  // Close modals on overlay click
  presetModalOverlay.addEventListener('click', (e) => {
    if (e.target === presetModalOverlay) {
      hideSavePresetModal();
    }
  });
  
  deleteModalOverlay.addEventListener('click', (e) => {
    if (e.target === deleteModalOverlay) {
      hideDeleteModal();
    }
  });
  
  // Enter key in preset name input
  presetNameInput.addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
      const name = presetNameInput.value.trim();
      if (name) {
        await saveCurrentAsPreset(name);
        hideSavePresetModal();
      }
    }
  });
  
  // Escape key to close modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (presetModalOverlay.classList.contains('active')) {
        hideSavePresetModal();
      }
      if (deleteModalOverlay.classList.contains('active')) {
        hideDeleteModal();
      }
    }
  });
}
