// Early injection script - runs at document_start before any content renders
(function() {
  'use strict';
  
  // Debug flag - set to false in production to disable all console logs
  const DEBUG = false;
  function log(...args) { if (DEBUG) log(...args); }
  function logError(...args) { if (DEBUG) logError(...args); }
  
  // Check if user is authenticated
  const authStatus = localStorage.getItem('ofStatsAuthStatus');
  const isAuthenticated = authStatus === 'authenticated';
  
  // If not authenticated, don't run any plugin functionality
  if (!isAuthenticated) {
    log('OF Stats Early: Not authenticated, plugin disabled');
    return;
  }

  // ==================== Badge data-collection neutralization (Phase 1) ====================
  // Profile Stats owns these features now (badge, fan trend, notes, alerts, AI verdict,
  // farmed models, percentile). SE keeps the badge rendering code as dead weight but its
  // sendMessage calls to the backend are stubbed here so nothing reaches the DB.
  // To re-enable (rollback): delete this IIFE.
  (function neutralizeBadgeWrites() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    const BADGE_ACTIONS = new Set([
      'reportFans', 'getFans', 'getFansTrend',
      'checkFarmedModel',
      'saveNote', 'deleteNote', 'getNotes', 'syncNotes', 'syncNoteTags', 'getNoteTags',
      'reportAlerts', 'getAlerts',
      'getAIVerdict',
      'getEngagementPercentile'
    ]);
    const STUB = {
      reportFans:              { recorded: false },
      getFans:                 { found: false, lastFans: null },
      getFansTrend:            { points: [] },
      checkFarmedModel:        { found: false, status: null },
      saveNote:                { ok: true },
      deleteNote:              { ok: true },
      getNotes:                { notes: [] },
      syncNotes:               { ok: true },
      syncNoteTags:            { ok: true },
      getNoteTags:             { tags: [] },
      reportAlerts:            { ok: true },
      getAlerts:               { alerts: [] },
      getAIVerdict:            { verdict: null },
      getEngagementPercentile: { percentile: null }
    };
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function(message) {
      if (message && typeof message === 'object' && BADGE_ACTIONS.has(message.action)) {
        const lastArg = arguments[arguments.length - 1];
        const stub = STUB[message.action] || null;
        if (typeof lastArg === 'function') {
          setTimeout(function() { try { lastArg(stub); } catch (e) {} }, 0);
          return undefined;
        }
        return Promise.resolve(stub);
      }
      return orig.apply(null, arguments);
    };
  })();

  
  // Check subscription status from localStorage
  // This is set by popup.js when subscription is checked
  let subscriptionActive = true;
  try {
    const subStatus = localStorage.getItem('ofStatsSubActive');
    if (subStatus === 'false') {
      subscriptionActive = false;
      log('OF Stats Early: Subscription not active, clearing cached data but keeping Profile Interceptor');
      // Clear all cached fake data
      localStorage.removeItem('ofStatsCache');
      localStorage.removeItem('ofStatsEarningStats');
      localStorage.removeItem('ofStatsEarningsData');
      // DON'T return here - we still need Profile Interceptor for fans tracking
    }
  } catch(e) {}
  
  // Get cached values from localStorage (SYNC - instant!)
  let cachedSettings = null;
  try {
    const cached = localStorage.getItem('ofStatsCache');
    if (cached) {
      cachedSettings = JSON.parse(cached);
    }
  } catch(e) {}

  // Pre-inject CSS to hide native .b-top-rated on statistics page immediately.
  // Must be as early as possible (before shouldRunMainLogic return) to prevent blue flash.
  if (cachedSettings && cachedSettings.enabled && cachedSettings.topCreators &&
      window.location.pathname.includes('/my/statistics/statements/earnings')) {
    if (!document.getElementById('of-stats-hide-native-top-rated')) {
      var earlyHideStyle = document.createElement('style');
      earlyHideStyle.id = 'of-stats-hide-native-top-rated';
      earlyHideStyle.textContent = '.b-top-rated:not(#of-stats-top-creators-rated){display:none!important}';
      (document.head || document.documentElement).appendChild(earlyHideStyle);
    }
  }

  // Early declaration of earningStatsData - load from localStorage IMMEDIATELY
  // This ensures preset data is available before any generation happens
  var earningStatsData = null;
  try {
    const savedEarningStats = localStorage.getItem('ofStatsEarningStats');
    if (savedEarningStats) {
      earningStatsData = JSON.parse(savedEarningStats);
      if (earningStatsData && earningStatsData.fromPreset) {
        log('OF Stats Early: Loaded earning stats from preset at startup - Gross: $' + (earningStatsData.gross || 0).toFixed(2));
      }
    }
  } catch(e) {}
  
  // Function to check if current page is our model's profile (where we should apply fake values)
  function isOwnProfilePage() {
    const path = window.location.pathname;
    
    // Check if we're on /my/ pages (definitely own page - stats, settings, etc.)
    if (path.startsWith('/my/')) return true;
    
    // Get our saved model username from settings
    const ourUsername = cachedSettings && cachedSettings.myModelUsername ? cachedSettings.myModelUsername.toLowerCase() : null;
    
    // Get username from URL
    const pathParts = path.split('/').filter(Boolean);
    if (pathParts.length > 0) {
      const firstPart = pathParts[0].toLowerCase();
      
      // System pages - not a profile page, show fake values
      const systemPages = ['my', 'notifications', 'messages', 'chats', 'settings', 'collections', 'bookmarks', 'lists', 'subscribers', 'subscriptions', 'search', 'explore'];
      if (systemPages.includes(firstPart)) {
        return true;
      }
      
      // This is a profile page (username in URL)
      // ONLY show fake values if this is OUR saved username
      if (ourUsername) {
        return firstPart === ourUsername;
      }
      
      // No saved username yet - don't show fake values on any profile page
      return false;
    }

    // Root page or other - allow fake values
    return true;
  }

  // Find the EARNINGS-page wrapper, skipping the subs page wrapper if both are mounted
  // (Vue keep-alive can leave both `/statements/earnings` and `/fans/subscriptions` DOMs alive).
  // The subs page module marks its wrapper with `data-of-stats-subs-active` so we can avoid it.
  function findEarningsWrapper() {
    var wrappers = document.querySelectorAll('.b-statistics-page-content__wrapper');
    for (var i = 0; i < wrappers.length; i++) {
      if (!wrappers[i].hasAttribute('data-of-stats-subs-active')) return wrappers[i];
    }
    return wrappers[0] || null;
  }

  // ==================== PROFILE DATA INTERCEPTOR ====================
  // Intercept API responses to extract hidden profile data (fans count, join date, etc.)
  // This MUST be injected into page context to intercept fetch (content scripts are isolated)
  // Due to CSP, we load an external file instead of inline script
  
  (function setupProfileInterceptor() {
    // Inject the script file into page context (external file to bypass CSP)
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('page-interceptor.js');
    script.onload = function() {
      log('OF Stats: Page interceptor loaded successfully');
      this.remove(); // Clean up DOM
    };
    script.onerror = function() {
      logError('OF Stats: Failed to load page interceptor');
    };
    (document.head || document.documentElement).appendChild(script);
    
    log('OF Stats: Profile interceptor script injected');
    


    
    
    
    
    // Watch for SPA navigation
    let lastUrl = location.href;
    function startNavigationObserver() {
      const target = document.body || document.documentElement;
      if (!target) {
        setTimeout(startNavigationObserver, 100);
        return;
      }
      new MutationObserver(function() {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          // Remove old badge on navigation
          const oldBadge = document.getElementById('of-stats-profile-badge');
          if (oldBadge) oldBadge.remove();
        }
      }).observe(target, { childList: true, subtree: true });
    }
    
    // Start observer when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startNavigationObserver);
    } else {
      startNavigationObserver();
    }
    
    log('OF Stats: Profile interceptor initialized');
  })();
  // ==================== END PROFILE DATA INTERCEPTOR ====================
  
  // Flag to track if we should run the main logic (fake values)
  // Only run if subscription is active AND settings are enabled
  const shouldRunMainLogic = subscriptionActive && cachedSettings && cachedSettings.enabled;
  
  // If no cached settings, disabled, or subscription expired, only export the function and return
  if (!shouldRunMainLogic) {
    // Export a function that can be called from content.js even if inject-early didn't run fully
    window.ofStatsApplyStatisticsEarningsPage = function(newSettings) {
      // Re-read settings
      cachedSettings = newSettings;
      if (!cachedSettings) {
        try {
          const cached = localStorage.getItem('ofStatsCache');
          if (cached) {
            cachedSettings = JSON.parse(cached);
          }
        } catch(e) {}
      }
      
      if (!cachedSettings || !cachedSettings.enabled) return;
      
      // Check if we're on the right page
      if (!window.location.pathname.includes('/my/statistics/statements/earnings')) return;
      
      // IMPORTANT: Prevent infinite reload loop
      // Check if we already tried to reload recently (within 3 seconds)
      const lastReloadAttempt = sessionStorage.getItem('ofStatsLastReloadAttempt');
      const now = Date.now();
      if (lastReloadAttempt && (now - parseInt(lastReloadAttempt)) < 3000) {
        log('OF Stats: Skipping reload to prevent infinite loop');
        return;
      }
      
      // Mark that we're about to reload
      sessionStorage.setItem('ofStatsLastReloadAttempt', now.toString());
      
      // The full function will be defined when inject-early runs with settings
      // For now, just reload the page to apply changes
      log('OF Stats: Reloading page to apply statistics/statements/earnings changes');
      window.location.reload();
    };
    return;
  }
  
  // Hide original data rows but NOT the loading spinner row
  // The infinite-loading-container shows the spinner - we want that visible
  if ((cachedSettings.earningsCount || cachedSettings.earningsCompleteCount) && window.location.pathname.includes('/my/statements/earnings')) {
    var hideStyle = document.createElement('style');
    hideStyle.id = 'of-stats-hide-earnings';
    // Hide only data rows (those with multiple td), not the loading row (which has colspan)
    hideStyle.textContent = 'table.b-table.m-responsive.m-earnings tbody tr:not([data-of-stats]):not(:has(.infinite-loading-container)) { visibility: hidden !important; height: 0 !important; overflow: hidden !important; }';
    document.documentElement.appendChild(hideStyle);
  }
  
  // Note: We'll handle Earnings section replacement via JS, not CSS
  // CSS :has() selector is not fully supported in all browsers
  
  // Hide earnings stats page elements until our data is applied (/my/stats/earnings page)
  if (window.location.pathname.includes('/my/stats/earnings')) {
    var hideStatsStyle = document.createElement('style');
    hideStatsStyle.id = 'of-stats-hide-stats';
    // Hide ALL category values, original month rows, and original chart until our data is applied
    // This prevents any flash of original values
    hideStatsStyle.textContent = `
      .b-stats-row__content:not([data-of-stats-ready]) .b-stats-row__val,
      .b-stats-row__content:not([data-of-stats-ready]) .b-stats-row__total-net span {
        visibility: hidden !important;
      }
      /* ALWAYS hide original month rows (not generated by us and not All time) */
      .b-stats-wrap .b-stats-row:not([data-of-stats-generated]):not([data-of-stats-alltime]) {
        display: none !important;
      }
      .b-chart__wrapper canvas:not([data-of-stats-overlay]) {
        visibility: hidden !important;
      }
      /* Expandable month rows styles */
      .b-stats-row[data-of-stats-generated] .b-stats-row__head {
        cursor: pointer;
      }
      .b-stats-row[data-of-stats-generated] .b-stats-row__arrow {
        transition: transform 0.2s ease;
      }
      .b-stats-row[data-of-stats-generated].m-expanded .b-stats-row__arrow {
        transform: rotate(180deg);
      }
      .b-stats-row[data-of-stats-generated] .b-stats-row__body {
        padding: 0;
      }
      .b-stats-row[data-of-stats-generated] .b-stats-row__chart-wrapper {
        position: relative;
        margin-bottom: 16px;
      }
      .b-stats-row[data-of-stats-generated] .b-chart__wrapper {
        min-height: 220px;
        height: 220px;
        overflow: visible;
        margin-top: -35px;
      }
      .b-stats-row[data-of-stats-generated] .b-chart__wrapper canvas {
        display: block;
        box-sizing: border-box;
        width: 608px;
        height: 220px;
      }
      /* Calendar button styling for months */
      .b-stats-row[data-of-stats-generated] .b-stats-row__chart-wrapper .g-btn.m-time-period {
        margin-top: 25px;
      }
      /* Active category styling for generated month rows - m-active class */
      .b-stats-wrap .b-stats-row[data-of-stats-generated] .b-stats-row__content .b-stats-row__label.m-border-line.m-active .b-stats-row__name.g-md-text {
        color: #000 !important;
        opacity: 1 !important;
        font-weight: 600 !important;
      }
      .b-stats-wrap .b-stats-row[data-of-stats-generated] .b-stats-row__content .b-stats-row__label.m-border-line:not(.m-active):not(.m-total) .b-stats-row__name.g-md-text {
        color: #8a96a3 !important;
        opacity: 0.6 !important;
        font-weight: 400 !important;
      }
      /* Active category styling for All time row - m-current class (like original site) */
      .b-stats-wrap .b-stats-row[data-of-stats-alltime] .b-stats-row__content .b-stats-row__label.m-border-line.m-current .b-stats-row__name.g-md-text {
        color: #000 !important;
        opacity: 1 !important;
        font-weight: 600 !important;
      }
      .b-stats-wrap .b-stats-row[data-of-stats-alltime] .b-stats-row__content .b-stats-row__label.m-border-line:not(.m-current):not(.m-total) .b-stats-row__name.g-md-text {
        color: #8a96a3 !important;
        opacity: 0.6 !important;
        font-weight: 400 !important;
      }
      /* Clickable category labels */
      .b-stats-row[data-of-stats-generated] .b-stats-row__label.m-border-line:not(.m-total),
      .b-stats-row[data-of-stats-alltime] .b-stats-row__label.m-border-line:not(.m-total) {
        cursor: pointer;
      }
      /* All time row chart wrapper - same as month charts */
      .b-stats-row[data-of-stats-alltime] .b-chart__wrapper {
        min-height: 200px;
      }
      .b-stats-row[data-of-stats-alltime] .b-chart__wrapper canvas[data-of-stats-overlay] {
        display: block;
        box-sizing: border-box;
        width: 608px;
        height: 200px;
      }
    `;
    document.documentElement.appendChild(hideStatsStyle);
    
    // Dynamic dark mode styles for generated category labels
    var darkModeStatsStyle = document.createElement('style');
    darkModeStatsStyle.id = 'of-stats-dark-mode-labels';
    function updateDarkModeLabels() {
      if (!document.body) return;
      var dark = isDarkMode();
      darkModeStatsStyle.textContent = dark ? '\
        .b-stats-wrap .b-stats-row[data-of-stats-generated] .b-stats-row__content .b-stats-row__label.m-border-line.m-active .b-stats-row__name.g-md-text { color: #fff !important; }\
        .b-stats-wrap .b-stats-row[data-of-stats-alltime] .b-stats-row__content .b-stats-row__label.m-border-line.m-current .b-stats-row__name.g-md-text { color: #fff !important; }\
      ' : '';
      // Sync theme class on Top Creators banner (Statements/Earnings page)
      var topCreatorsBanner = document.getElementById('of-stats-top-creators-rated');
      if (topCreatorsBanner) topCreatorsBanner.classList.toggle('of-theme-dark', dark);
    }
    document.documentElement.appendChild(darkModeStatsStyle);
    
    // Theme observer for /my/stats/earnings charts - redraw on dark/light switch
    // Deferred until body exists
    function setupStatsThemeObserver() {
      if (!document.body) {
        setTimeout(setupStatsThemeObserver, 50);
        return;
      }
      updateDarkModeLabels();
      // Also re-check after short delays to catch late body style application
      setTimeout(updateDarkModeLabels, 100);
      setTimeout(updateDarkModeLabels, 300);
      setTimeout(updateDarkModeLabels, 600);
      setTimeout(updateDarkModeLabels, 1000);
      var statsLastDarkMode = isDarkMode();
      function redrawStatsChartsOnThemeChange() {
        var currentDark = isDarkMode();
        if (currentDark !== statsLastDarkMode) {
          statsLastDarkMode = currentDark;
          updateDarkModeLabels();
          log('OF Stats: Theme changed on stats page, redrawing charts');
          
          var alltimeCanvases = document.querySelectorAll('canvas[data-of-stats-alltime-canvas]');
          var monthCanvases = document.querySelectorAll('canvas[data-of-stats-month-canvas]');
          
          if (alltimeCanvases.length === 0) {
            // Canvases were destroyed by OF re-render, re-apply everything
            log('OF Stats: No overlay canvases found after theme change, scheduling re-apply...');
            var reapplyAttempts = 0;
            function tryReapplyAfterThemeChange() {
              reapplyAttempts++;
              if (reapplyAttempts > 25) {
                log('OF Stats: Gave up re-applying after theme change');
                return;
              }
              var container = document.querySelector('.b-stats-wrap');
              var originalCanvas = document.querySelector('.b-chart__wrapper canvas');
              if (!container || !originalCanvas) {
                setTimeout(tryReapplyAfterThemeChange, 200);
                return;
              }
              log('OF Stats: DOM ready after theme change, re-applying (attempt ' + reapplyAttempts + ')');
              document.querySelectorAll('[data-of-stats-modified]').forEach(function(el) {
                el.removeAttribute('data-of-stats-modified');
              });
              container.removeAttribute('data-of-stats-months-applied');
              applyMonthlyEarningsEarly();
              applyEarningStats();
              updateDarkModeLabels();
              // Verify overlay was created, retry if not
              setTimeout(function() {
                var overlay = document.querySelector('canvas[data-of-stats-alltime-canvas]');
                if (!overlay) {
                  log('OF Stats: Overlay not created, retrying...');
                  setTimeout(tryReapplyAfterThemeChange, 300);
                } else {
                  log('OF Stats: Theme switch re-apply successful');
                  updateDarkModeLabels();
                }
              }, 150);
            }
            setTimeout(tryReapplyAfterThemeChange, 150);
            return;
          }
          
          // Redraw alltime overlay canvases (clear position cache for theme font change)
          alltimeCanvases.forEach(function(canvas) {
            canvas._fixedDatePositions = null;
            canvas._fixedDateLabels = null;
            var chartData = canvas._chartData;
            if (chartData) {
              var ctx = canvas.getContext('2d');
              if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
              drawAllTimeChartCanvasNoAnimation(canvas, chartData);
            }
          });
          // Redraw month chart canvases
          monthCanvases.forEach(function(canvas) {
            canvas._fixedDatePositions = null;
            canvas._fixedDateLabels = null;
            var chartData = canvas._chartData;
            if (chartData) {
              var ctx = canvas.getContext('2d');
              if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
              drawMonthChartCanvasNoAnimation(canvas, chartData);
            }
          });
        }
      }
      var statsThemeObserver = new MutationObserver(function() {
        redrawStatsChartsOnThemeChange();
      });
      statsThemeObserver.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
      statsThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
      // Also catch theme button click
      document.addEventListener('click', function(e) {
        var btn = e.target.closest('[data-name="SwitchTheme"]');
        if (btn) {
          [10, 30, 60, 100, 150, 250, 400].forEach(function(delay) {
            setTimeout(redrawStatsChartsOnThemeChange, delay);
          });
        }
      }, true);
    }
    setupStatsThemeObserver();
  }
  
  // Hide original Earnings section content until we replace it
  // Always hide when plugin is enabled - we generate data from /my/stats/earnings even without Earnings counts
  if (window.location.pathname.includes('/my/statistics/statements/earnings')) {
    // Check if chart generation is disabled (user clicked Reset)
    var statisticsChartDisabled = false;
    try {
      statisticsChartDisabled = localStorage.getItem('ofStatsStatisticsChartDisabled') === 'true';
    } catch(e) {}
    
    // Check if earnings counts are set
    var hasEarningsCounts = cachedSettings && (
      (parseInt(cachedSettings.earningsCount) || 0) > 0 || 
      (parseInt(cachedSettings.earningsCompleteCount) || 0) > 0
    );
    // Store globally for SPA navigation handlers
    window.ofStatsHasEarningsCounts = hasEarningsCounts;
    
    // Hide when plugin is enabled AND chart generation is NOT disabled
    if (cachedSettings && cachedSettings.enabled && !statisticsChartDisabled) {
      var hideEarningsStyle = document.createElement('style');
      hideEarningsStyle.id = 'of-stats-hide-earnings-content';
      // Only hide transactions table (.b-separate-section) if earnings counts are set
      var transactionsCSS = hasEarningsCounts ? `
        .b-statistics-page-content__wrapper[data-of-stats-applied] .b-separate-section:not([data-of-stats-generated]),
        [data-of-stats-original-hidden].b-separate-section {
          display: none !important;
        }
      ` : '';
      hideEarningsStyle.textContent = `
        /* Hide original Earnings section content (not header) until replaced.
           Scoped to wrappers NOT marked subs-active — without this scoping, the
           rule matches the Summary widget on /my/statistics/fans/subscriptions
           (same .b-useful-data class) and silently zeroes its height. */
        .b-statistics-page-content__wrapper:not([data-of-stats-subs-active]) .b-useful-data:not([data-of-stats-processed]) .b-statistics-columns,
        .b-statistics-page-content__wrapper:not([data-of-stats-subs-active]) .b-useful-data:not([data-of-stats-processed]) .b-useful-data__empty {
          visibility: hidden !important;
          height: 0 !important;
          overflow: hidden !important;
        }
        /* After processing: hide ALL native children except header and our generated wrapper */
        .b-statistics-page-content__wrapper:not([data-of-stats-subs-active]) .b-useful-data[data-of-stats-processed] > *:not(.b-useful-data__header):not([data-of-stats-earnings-generated]) {
          display: none !important;
        }
        /* Hide original chart and summary when our generated content exists.
           Same subs-active exclusion — keeps the Summary block visible on
           fans/subscriptions when Vue keep-alive reuses the wrapper. */
        .b-statistics-page-content__wrapper[data-of-stats-applied]:not([data-of-stats-subs-active]) .b-elements-determinant:not([data-of-stats-generated]),
        .b-statistics-page-content__wrapper[data-of-stats-applied]:not([data-of-stats-subs-active]) .b-chart:not([data-of-stats-generated]) {
          display: none !important;
        }
        /* Hide elements marked as original-hidden (except transactions if no earnings counts) */
        [data-of-stats-original-hidden]:not(.b-separate-section) {
          display: none !important;
        }
        ${transactionsCSS}
      `;
      document.documentElement.appendChild(hideEarningsStyle);
    }
  }
  
  // Helper to safely get className as string (handles SVGAnimatedString)
  function getClassStr(element) {
    if (!element) return '';
    var cn = element.className || '';
    return typeof cn === 'string' ? cn : (cn.baseVal || '');
  }
  
  // Listen for settings changes from content.js (Apply Changes button)
  window.addEventListener('ofStatsSettingsChanged', function(e) {
    if (e.detail) {
      cachedSettings = e.detail;
      log('OF Stats: cachedSettings updated from Apply Changes');
    }
  });
  
  // Store last hovered item for tooltip replacement
  let lastHoveredType = null; // 'fans' or 'following'
  
  // Store current active category for syncing between All time and months
  let currentActiveCategory = 'subscriptions';
  
  // Convert K/M notation to full number (42.5K -> 42500)
  function convertToFullNumber(value) {
    if (!value) return '';
    const str = value.toString().trim().toUpperCase();
    
    // Check for K (thousands)
    const kMatch = str.match(/^([\d.]+)\s*K$/i);
    if (kMatch) {
      return Math.round(parseFloat(kMatch[1]) * 1000).toString();
    }
    
    // Check for M (millions)
    const mMatch = str.match(/^([\d.]+)\s*M$/i);
    if (mMatch) {
      return Math.round(parseFloat(mMatch[1]) * 1000000).toString();
    }
    
    // Already a number - just extract digits
    return str.replace(/[^\d]/g, '');
  }
  
  // Function to replace tooltip content for sidebar Fans/Following counts.
  // The sidebar belongs to the logged-in user and appears on every OF page,
  // so the tooltip override is applied site-wide, not only on the own profile page.
  function replaceTooltip(tooltip) {
    if (!tooltip || !cachedSettings || !cachedSettings.enabled) return;
    // Skip our own custom tooltips
    if (tooltip.hasAttribute('data-of-stats-custom')) return;
    
    // Flag to prevent recursive observer calls
    let isReplacing = false;
    let ourValue = null; // Store our value to keep replacing
    
    // Function to determine tooltip type by finding which element is hovered
    function detectHoveredType() {
      // Primary: check which sidebar element is currently hovered
      const fansItem = document.querySelector('.l-sidebar__user-data__item:first-child');
      const followingItem = document.querySelector('.l-sidebar__user-data__item:nth-child(2)');
      
      if (fansItem && fansItem.matches(':hover')) return 'fans';
      if (followingItem && followingItem.matches(':hover')) return 'following';
      
      // Secondary: use tracked type but VALIDATE against tooltip position
      // This prevents stale lastHoveredType from corrupting unrelated tooltips
      if (lastHoveredType) {
        const tooltipRect = tooltip.getBoundingClientRect();
        const targetItem = lastHoveredType === 'fans' ? fansItem : followingItem;
        if (targetItem) {
          const itemRect = targetItem.getBoundingClientRect();
          const hDist = Math.abs(tooltipRect.left + tooltipRect.width/2 - (itemRect.left + itemRect.width/2));
          const vDist = Math.abs(tooltipRect.top - itemRect.top);
          if (hDist < 100 && vDist < 100) {
            return lastHoveredType;
          }
        }
        // Tooltip is far from expected sidebar item — stale lastHoveredType, ignore
        return null;
      }
      
      // Tertiary: check by tooltip position alone
      const tooltipRect = tooltip.getBoundingClientRect();
      if (fansItem) {
        const fansRect = fansItem.getBoundingClientRect();
        if (Math.abs(tooltipRect.left + tooltipRect.width/2 - (fansRect.left + fansRect.width/2)) < 50) {
          return 'fans';
        }
      }
      if (followingItem) {
        const followingRect = followingItem.getBoundingClientRect();
        if (Math.abs(tooltipRect.left + tooltipRect.width/2 - (followingRect.left + followingRect.width/2)) < 50) {
          return 'following';
        }
      }
      
      return null;
    }
    
    // Determine our value once
    function determineOurValue() {
      if (ourValue) return ourValue;
      
      const hoveredType = detectHoveredType();
      
      if (hoveredType === 'fans') {
        if (cachedSettings.fansTooltip) {
          ourValue = cachedSettings.fansTooltip;
        } else if (cachedSettings.fansCount) {
          ourValue = convertToFullNumber(cachedSettings.fansCount);
        }
      } else if (hoveredType === 'following') {
        if (cachedSettings.followingTooltip) {
          ourValue = cachedSettings.followingTooltip;
        } else if (cachedSettings.followingCount) {
          ourValue = convertToFullNumber(cachedSettings.followingCount);
        }
      }
      
      return ourValue;
    }
    
    // Function to actually replace the text
    function doReplace() {
      // Prevent recursion
      if (isReplacing) return;
      
      // Find the inner element where text is displayed
      const inner = tooltip.querySelector('.tooltip-inner');
      if (!inner) return;
      
      const text = inner.textContent.trim();
      const targetValue = determineOurValue();
      
      // If already our value, nothing to do
      if (text === targetValue) return;
      
      // Check if it's a number (tooltip shows exact count) or replace if original is trying to overwrite
      if (targetValue && /^\d+$/.test(text)) {
        // Save original width before change
        const originalWidth = tooltip.offsetWidth;
        
        isReplacing = true;
        inner.textContent = targetValue;
        isReplacing = false;
        
        // Recenter tooltip after content change
        recenterTooltip(tooltip, originalWidth);
      }
    }
    
    // Try to replace immediately
    doReplace();
    
    // Keep observing - OnlyFans may try to overwrite our value
    const tooltipObserver = new MutationObserver(function() {
      doReplace();
    });
    tooltipObserver.observe(tooltip, { childList: true, subtree: true, characterData: true });
    
    // Also try with small delays for async content
    setTimeout(doReplace, 10);
    setTimeout(doReplace, 50);
    setTimeout(doReplace, 100);
    setTimeout(doReplace, 200);
    
    // Disconnect observer when tooltip is removed from DOM
    const cleanupObserver = new MutationObserver(function(mutations) {
      if (!document.body.contains(tooltip)) {
        tooltipObserver.disconnect();
        cleanupObserver.disconnect();
      }
    });
    cleanupObserver.observe(document.body, { childList: true, subtree: true });
    
    // Fallback disconnect after 5 seconds
    setTimeout(function() {
      tooltipObserver.disconnect();
      cleanupObserver.disconnect();
    }, 5000);
  }
  
  // Function to recenter tooltip after text change
  function recenterTooltip(tooltip, originalWidth) {
    if (!tooltip) return;
    
    // Force reflow to get new width
    tooltip.offsetHeight;
    const newWidth = tooltip.offsetWidth;
    
    // Calculate width difference
    const widthDiff = newWidth - originalWidth;
    
    if (widthDiff !== 0) {
      // Get current transform - OnlyFans uses translate3d(X, Y, 0)
      const computedStyle = window.getComputedStyle(tooltip);
      const transform = computedStyle.transform;
      
      if (transform && transform !== 'none') {
        // Parse matrix or translate3d values
        // matrix(1, 0, 0, 1, X, Y) or translate3d(X, Y, Z)
        const matrixMatch = transform.match(/matrix.*\((.+)\)/);
        if (matrixMatch) {
          const values = matrixMatch[1].split(', ');
          // For matrix(a, b, c, d, tx, ty) - tx is at index 4, ty at index 5
          let tx = parseFloat(values[4]) || 0;
          let ty = parseFloat(values[5]) || 0;
          
          // Adjust X position by half of width difference
          tx = tx - (widthDiff / 2);
          
          // Apply new transform
          tooltip.style.transform = `translate3d(${tx}px, ${ty}px, 0px)`;
        }
      }
      
      // Recenter the arrow - it should be at center of tooltip
      const arrow = tooltip.querySelector('.tooltip-arrow');
      if (arrow) {
        // Arrow should be at (newWidth / 2) - 5px (5px is half arrow width)
        const arrowLeft = (newWidth / 2) - 5;
        arrow.style.left = arrowLeft + 'px';
      }
    }
  }
  
  // Track hover on fans/following
  document.addEventListener('mouseover', function(e) {
    const item = e.target.closest('.l-sidebar__user-data__item');
    if (item) {
      const allItems = document.querySelectorAll('.l-sidebar__user-data__item');
      const index = Array.from(allItems).indexOf(item);
      if (index === 0) lastHoveredType = 'fans';
      else if (index === 1) lastHoveredType = 'following';
    }
  }, true);
  
  // Force-create tooltip for fans/following when OF doesn't show one (<1K fans)
  // Only on own profile page
  var customFansTooltipEl = null;
  var customFansTooltipTimeout = null;
  
  function getCustomFansTooltipValue(type) {
    if (!cachedSettings || !cachedSettings.enabled) return null;
    if (type === 'fans') {
      if (cachedSettings.fansTooltip) return cachedSettings.fansTooltip;
      if (cachedSettings.fansCount) return convertToFullNumber(cachedSettings.fansCount);
    } else if (type === 'following') {
      if (cachedSettings.followingTooltip) return cachedSettings.followingTooltip;
      if (cachedSettings.followingCount) return convertToFullNumber(cachedSettings.followingCount);
    }
    return null;
  }
  
  function showCustomFansTooltip(targetItem, value) {
    hideCustomFansTooltip();
    
    // Center over the whole item block (same as native OF tooltip)
    var anchorEl = targetItem;
    
    var el = document.createElement('div');
    el.className = 'tooltip vue-tooltip-theme';
    el.setAttribute('role', 'tooltip');
    el.setAttribute('aria-hidden', 'false');
    el.setAttribute('x-placement', 'top');
    el.setAttribute('data-of-stats-custom', 'true');
    el.style.position = 'fixed';
    el.style.zIndex = '99999';
    
    var arrow = document.createElement('div');
    arrow.className = 'tooltip-arrow';
    // Force exact center: 50% minus half-arrow-width, clear any OF margin
    arrow.style.cssText = 'left: 50% !important; margin-left: -3px !important; margin-right: 0 !important; transform: none !important;';
    el.appendChild(arrow);
    
    var inner = document.createElement('div');
    inner.className = 'tooltip-inner';
    inner.textContent = value;
    el.appendChild(inner);
    
    document.body.appendChild(el);
    customFansTooltipEl = el;
    
    // getBoundingClientRect gives viewport coords — perfect for position:fixed
    var rect = anchorEl.getBoundingClientRect();
    var tooltipWidth = el.offsetWidth;
    var tooltipHeight = el.offsetHeight;
    
    // Center tooltip above the whole item block with 5px gap, nudged 3px left
    var left = rect.left + (rect.width / 2) - (tooltipWidth / 2) - 2;
    var top = rect.top - tooltipHeight - 5;
    
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }
  
  function hideCustomFansTooltip() {
    if (customFansTooltipEl && customFansTooltipEl.parentNode) {
      customFansTooltipEl.parentNode.removeChild(customFansTooltipEl);
    }
    customFansTooltipEl = null;
    if (customFansTooltipTimeout) {
      clearTimeout(customFansTooltipTimeout);
      customFansTooltipTimeout = null;
    }
  }
  
  // Track which user-data item the mouse is currently over
  var currentHoveredItem = null;
  
  document.addEventListener('mouseover', function(e) {
    // Sidebar Fans/Following belong to the logged-in user on every OF page,
    // so the custom tooltip should fire site-wide.
    var item = e.target.closest('.l-sidebar__user-data__item');
    
    // Mouse moved to something outside user-data items
    if (!item) {
      if (currentHoveredItem) {
        currentHoveredItem = null;
        hideCustomFansTooltip();
      }
      return;
    }
    
    // Same item — do nothing
    if (item === currentHoveredItem) return;
    
    // New item — clean up previous
    hideCustomFansTooltip();
    currentHoveredItem = item;
    
    var allItems = document.querySelectorAll('.l-sidebar__user-data__item');
    var index = Array.from(allItems).indexOf(item);
    var type = index === 0 ? 'fans' : (index === 1 ? 'following' : null);
    if (!type) return;
    
    var value = getCustomFansTooltipValue(type);
    if (!value) return;
    
    // Wait for OF to potentially create its own tooltip
    customFansTooltipTimeout = setTimeout(function() {
      // Double check we're still hovering the same item
      if (currentHoveredItem !== item) return;
      
      // Check if OF already created a native tooltip
      var existingTooltip = document.querySelector('.tooltip.vue-tooltip-theme:not([data-of-stats-custom])');
      if (existingTooltip) return; // OF handled it, replaceTooltip will handle the value
      
      // OF didn't create one — show our custom tooltip
      showCustomFansTooltip(item, value);
    }, 150);
  }, true);
  
  document.addEventListener('mouseout', function(e) {
    var item = e.target.closest('.l-sidebar__user-data__item');
    if (!item || item !== currentHoveredItem) return;
    
    // Check if mouse moved to another element inside the same item
    var related = e.relatedTarget;
    if (related && item.contains(related)) return;
    
    // Mouse truly left the item
    currentHoveredItem = null;
    lastHoveredType = null;
    hideCustomFansTooltip();
  }, true);
  
  // Get current balance value as integer (no decimals, no commas)
  // Cache for found balance from DOM (to use when section is collapsed/expanded)
  // Use window object to persist across potential re-initializations
  if (typeof window.ofStatsCachedDOMBalance === 'undefined') {
    window.ofStatsCachedDOMBalance = null;
  }
  
  function getCurrentBalanceInteger() {
    try {
      // First try to get from cached settings (user-defined value has highest priority)
      if (cachedSettings && cachedSettings.currentBalance) {
        // Remove $, commas, and everything after decimal point
        var cleanValue = cachedSettings.currentBalance.toString()
          .replace(/[$,]/g, '')
          .split('.')[0]
          .trim();
        var intValue = parseInt(cleanValue);
        if (!isNaN(intValue) && intValue > 0) {
          return intValue;
        }
      }
      
      // Fallback 1: read from DOM - /my/statements/earnings page
      var balanceEl = document.querySelector('.b-statements__current-balance__value');
      if (balanceEl) {
        var text = balanceEl.textContent || '';
        var cleanValue2 = text.replace(/[$,]/g, '').split('.')[0].trim();
        var intValue2 = parseInt(cleanValue2);
        if (!isNaN(intValue2) && intValue2 > 0) {
          window.ofStatsCachedDOMBalance = intValue2; // Cache found value
          return intValue2;
        }
      }
      
      // Fallback 2: read from DOM - /my/statistics/statements/earnings page
      var balanceEl2 = document.querySelector('.b-statements-balances__col.m-current .b-statements-balances__sum');
      if (balanceEl2) {
        var text2 = balanceEl2.textContent || '';
        var cleanValue3 = text2.replace(/[$,]/g, '').split('.')[0].trim();
        var intValue3 = parseInt(cleanValue3);
        if (!isNaN(intValue3) && intValue3 > 0) {
          window.ofStatsCachedDOMBalance = intValue3; // Cache found value
          return intValue3;
        }
      }
      
      // Fallback 3: use cached DOM balance if we found it before
      if (window.ofStatsCachedDOMBalance && window.ofStatsCachedDOMBalance > 0) {
        return window.ofStatsCachedDOMBalance;
      }
    } catch(e) {
      log('OF Stats: Error getting balance:', e);
    }
    return 0;
  }
  
  // Format integer with commas for thousands (manual implementation for reliability)
  function formatIntegerWithCommas(num) {
    // Ensure num is a valid number
    var n = parseInt(num, 10);
    if (isNaN(n)) return '0';
    // Manual comma insertion (works reliably in all contexts)
    var str = n.toString();
    var result = '';
    var count = 0;
    for (var i = str.length - 1; i >= 0; i--) {
      if (count > 0 && count % 3 === 0) {
        result = ',' + result;
      }
      result = str[i] + result;
      count++;
    }
    return result;
  }
  
  // Create and show withdrawal modal
  function showWithdrawalModal() {
    // Remove existing modal if any
    var existingModal = document.getElementById('of-stats-withdrawal-modal');
    if (existingModal) existingModal.remove();
    var existingBackdrop = document.getElementById('of-stats-modal-backdrop');
    if (existingBackdrop) existingBackdrop.remove();
    
    // Try to refresh balance from DOM before showing modal
    // This handles cases where user switched dropdown options and DOM was recreated
    var balanceEl = document.querySelector('.b-statements__current-balance__value');
    if (balanceEl) {
      var text = balanceEl.textContent || '';
      var cleanValue = text.replace(/[$,]/g, '').split('.')[0].trim();
      var intValue = parseInt(cleanValue);
      if (!isNaN(intValue) && intValue > 0) {
        window.ofStatsCachedDOMBalance = intValue;
      }
    }
    var balanceEl2 = document.querySelector('.b-statements-balances__col.m-current .b-statements-balances__sum');
    if (balanceEl2) {
      var text2 = balanceEl2.textContent || '';
      var cleanValue2 = text2.replace(/[$,]/g, '').split('.')[0].trim();
      var intValue2 = parseInt(cleanValue2);
      if (!isNaN(intValue2) && intValue2 > 0) {
        window.ofStatsCachedDOMBalance = intValue2;
      }
    }
    
    var maxAmount = getCurrentBalanceInteger();
    var maxAmountFormatted = formatIntegerWithCommas(maxAmount);
    
    log('OF Stats: showWithdrawalModal - maxAmount:', maxAmount, 'formatted:', maxAmountFormatted, 'cachedDOMBalance:', window.ofStatsCachedDOMBalance, 'cachedSettings.currentBalance:', cachedSettings ? cachedSettings.currentBalance : 'no settings');
    
    // Make original page button disabled/grey when modal is open (like original OF behavior)
    // Only target the main page button, not buttons inside modals
    document.querySelectorAll('button[data-of-stats-processed]').forEach(function(btn) {
      if (isWithdrawalButton(btn.textContent)) {
        // Remove all inline styles so OnlyFans CSS can apply disabled styles
        btn.removeAttribute('style');
        btn.setAttribute('disabled', 'disabled');
      }
    });
    
    // Create backdrop
    var backdrop = document.createElement('div');
    backdrop.id = 'of-stats-modal-backdrop';
    backdrop.className = 'modal-backdrop fade show';
    backdrop.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1040;';
    
    // Create modal
    var modal = document.createElement('div');
    modal.id = 'of-stats-withdrawal-modal';
    modal.className = 'modal fade show';
    modal.style.cssText = 'display: block; position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 1050; overflow: auto;';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    
    var lang = getPageLanguage();
    var modalTitle = lang === 'ru' ? 'Выплаты вручную' : lang === 'es' ? 'Pagos manuales' : lang === 'de' ? 'Manuelle Auszahlungen' : 'Manual payouts';
    var modalPlaceholder = lang === 'ru' ? 'Сумма выво...' : lang === 'es' ? 'Monto de retiro' : lang === 'de' ? 'Auszahlungsbetrag' : 'Withdrawal amount';
    var modalMinimum = lang === 'ru' ? 'Минимум $20 USD' : lang === 'es' ? 'Mínimo $20 USD' : lang === 'de' ? 'Mindestens $20 USD' : 'Minimum $20 USD';
    var modalMax = lang === 'ru' ? 'Максимум' : lang === 'es' ? 'Máx' : lang === 'de' ? 'Max' : 'Max';
    var modalCancel = lang === 'ru' ? 'Отменить' : lang === 'es' ? 'Cancelar' : lang === 'de' ? 'Abbrechen' : 'Cancel';
    var modalSubmit = lang === 'ru' ? 'Запрос на вывод' : lang === 'es' ? 'Solicitar retiro' : lang === 'de' ? 'Auszahlung anfordern' : 'Request withdrawal';
    modal.innerHTML = '<div class="modal-dialog modal-sm modal-dialog-centered"><span tabindex="0"></span><div id="ModalPayouts___BV_modal_content_" tabindex="-1" class="modal-content"><header id="ModalPayouts___BV_modal_header_" class="modal-header"><h4 class="modal-title"> ' + modalTitle + ' </h4></header><div id="ModalPayouts___BV_modal_body_" class="modal-body m-reset-body-padding-bottom"><form id="of-stats-withdrawal-form"><div class="b-inline-form d-flex align-items-start"><div class="g-input__wrapper mr-2 flex-fill-1 m-reset-bottom-gap" step="1"><div class="g-input__wrapper input-text-field m-empty m-reset-bottom-gap"><div class="" id="of-stats-input-wrapper"><div class="v-input form-control g-input mb-0 theme--light v-text-field v-text-field--is-booted v-text-field--enclosed v-text-field--outlined v-text-field--placeholder m-placeholder-gap" id="of-stats-v-input"><div class="v-input__control"><div class="v-input__slot"><fieldset aria-hidden="true"><legend style="width: 0px;"><span class="notranslate">\u200B</span></legend></fieldset><div class="v-text-field__slot" id="of-stats-text-slot"><input at-attr="input" inputmode="decimal" autocomplete="tip-input" name="" required="required" id="of-stats-tip-input" placeholder="' + modalPlaceholder + '" type="text"></div></div><div class="v-text-field__details"><div class="v-messages theme--light"><div class="v-messages__wrapper"></div></div></div></div><div class="v-input__append-outer"><div class="g-input__help"><div>' + modalMinimum + '</div></div></div></div></div></div></div><button type="button" class="g-btn m-lg m-rounded" id="of-stats-max-btn"><span class="g-spacer-r">' + modalMax + '</span><span class=""> $' + maxAmountFormatted + ' </span></button></div><div class="modal-footer"><button type="button" class="g-btn m-flat m-btn-gaps m-reset-width" id="of-stats-cancel-btn"> ' + modalCancel + ' </button><button type="submit" class="g-btn m-flat m-btn-gaps m-reset-width" id="of-stats-submit-btn" disabled="disabled"> ' + modalSubmit + ' </button></div></form></div></div><span tabindex="0"></span></div>';
    
    document.body.appendChild(backdrop);
    document.body.appendChild(modal);
    document.body.classList.add('modal-open');
    
    var inputEl = document.getElementById('of-stats-tip-input');
    var submitBtn = document.getElementById('of-stats-submit-btn');
    var maxBtn = document.getElementById('of-stats-max-btn');
    var textSlot = document.getElementById('of-stats-text-slot');
    var vInput = document.getElementById('of-stats-v-input');
    var inputWrapper = document.getElementById('of-stats-input-wrapper');
    var cancelBtn = document.getElementById('of-stats-cancel-btn');
    
    log('OF Stats: Modal elements:', inputEl, submitBtn, maxBtn, textSlot, vInput, inputWrapper, cancelBtn);
    
    // Function to add $ prefix when there's a value
    var updateInputState = function() {
      try {
        var currentInputEl = document.getElementById('of-stats-tip-input');
        var currentSubmitBtn = document.getElementById('of-stats-submit-btn');
        var currentTextSlot = document.getElementById('of-stats-text-slot');
        var currentInputWrapper = document.getElementById('of-stats-input-wrapper');
        var currentVInput = document.getElementById('of-stats-v-input');
        
        if (!currentInputEl || !currentSubmitBtn) {
          log('OF Stats: updateInputState - elements not found');
          return;
        }
        
        var hasValue = currentInputEl.value.trim().length > 0;
        var existingPrefix = currentTextSlot ? currentTextSlot.querySelector('.v-text-field__prefix') : null;
        log('OF Stats: updateInputState called, hasValue:', hasValue);
        
        var styleEl = document.getElementById('of-stats-submit-style');
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = 'of-stats-submit-style';
          styleEl.textContent = '#of-stats-submit-btn:not([disabled]):not(.disabled) { color: #00aff0 !important; opacity: 1 !important; pointer-events: auto !important; cursor: pointer !important; background-color: transparent !important; } #of-stats-submit-btn:not([disabled]):not(.disabled):hover { background-color: rgba(0, 145, 234, 0.06) !important; color: #0091ea !important; } #of-stats-submit-btn[disabled], #of-stats-submit-btn.disabled { color: #8a96a3 !important; opacity: 0.4 !important; pointer-events: none !important; cursor: default !important; }';
          document.head.appendChild(styleEl);
        }
        
        if (hasValue) {
          // Add $ prefix if not exists
          if (currentTextSlot && !existingPrefix) {
            var prefix = document.createElement('div');
            prefix.className = 'v-text-field__prefix';
            prefix.textContent = '$';
            currentTextSlot.prepend(prefix);
          }
          // Update classes for filled state
          if (currentInputWrapper) currentInputWrapper.className = 'm-filled';
          if (currentVInput) currentVInput.className = 'v-input form-control g-input mb-0 v-input--is-label-active v-input--is-dirty theme--light v-text-field v-text-field--prefix v-text-field--is-booted v-text-field--enclosed v-text-field--outlined v-text-field--placeholder m-placeholder-gap';
          // Enable submit button - убираем всё что делает её неактивной, стили через CSS
          currentSubmitBtn.removeAttribute('disabled');
          currentSubmitBtn.removeAttribute('aria-disabled');
          currentSubmitBtn.classList.remove('disabled');
          currentSubmitBtn.removeAttribute('style');
          currentSubmitBtn.style.cssText = '';
          log('OF Stats: Submit button ENABLED via CSS');
        } else {
          // Remove $ prefix
          if (existingPrefix) {
            existingPrefix.remove();
          }
          // Reset classes
          if (currentInputWrapper) currentInputWrapper.className = '';
          if (currentVInput) currentVInput.className = 'v-input form-control g-input mb-0 theme--light v-text-field v-text-field--is-booted v-text-field--enclosed v-text-field--outlined v-text-field--placeholder m-placeholder-gap';
          // Disable submit button - добавляем всё что делает её неактивной, стили через CSS 
          currentSubmitBtn.setAttribute('disabled', 'disabled');
          currentSubmitBtn.classList.add('disabled');
          currentSubmitBtn.removeAttribute('style');
          currentSubmitBtn.style.cssText = '';
          log('OF Stats: Submit button DISABLED via CSS');
        }
      } catch (e) {
        logError('OF Stats: updateInputState error:', e);
      }
    };
    
    // Set initial disabled state for submit button (стили через CSS)
    submitBtn.classList.add('disabled');
    log('OF Stats: Initial disabled state set');
    
    // Listen for input changes
    inputEl.addEventListener('input', updateInputState);
    
    // Обработчики фокуса — синяя рамка при клике на поле ввода (как на оригинальном сайте)
    inputEl.addEventListener('focus', function() {
      if (vInput) {
        vInput.classList.add('v-input--is-focused');
        vInput.classList.add('primary--text');
      }
      // Синяя рамка через fieldset
      var fieldset = modal.querySelector('#of-stats-v-input fieldset');
      if (fieldset) {
        fieldset.style.borderColor = '#00aff0';
      }
    });
    inputEl.addEventListener('blur', function() {
      if (vInput) {
        vInput.classList.remove('v-input--is-focused');
        vInput.classList.remove('primary--text');
      }
      var fieldset = modal.querySelector('#of-stats-v-input fieldset');
      if (fieldset) {
        fieldset.style.borderColor = '';
      }
    });
    
    // Close modal function
    var closeModal = function() {
      modal.remove();
      backdrop.remove();
      document.body.classList.remove('modal-open');
      // Restore original page button to active state
      document.querySelectorAll('button[data-of-stats-processed]').forEach(function(btn) {
        if (isWithdrawalButton(btn.textContent)) {
          btn.removeAttribute('disabled');
          // Remove inline styles - button will use OnlyFans default active styles
          btn.removeAttribute('style');
        }
      });
    };
    
    // Close on backdrop click
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeModal();
    });
    
    // Cancel button
    cancelBtn.addEventListener('click', closeModal);
    
    // Max button - fill input with max amount and disable button
    // Используем делегирование событий на случай если кнопка пересоздаётся
    modal.addEventListener('click', function(e) {
      // Проверяем что клик был по кнопке MAX или её дочерним элементам
      var target = e.target;
      var maxButton = target.closest('#of-stats-max-btn');
      if (!maxButton) return;
      
      log('OF Stats: MAX button clicked (delegated)');
      
      // Получаем актуальные элементы из DOM
      var currentInputEl = document.getElementById('of-stats-tip-input');
      var currentSubmitBtn = document.getElementById('of-stats-submit-btn');
      
      if (currentInputEl) {
        currentInputEl.value = maxAmount;
      }
      
      // Disable the Max button after click
      maxButton.setAttribute('disabled', 'disabled');
      
      // ПРИНУДИТЕЛЬНО делаем Request withdrawal активной
      if (currentSubmitBtn) {
        // Убираем ВСЁ что делает кнопку неактивной
        currentSubmitBtn.removeAttribute('disabled');
        currentSubmitBtn.removeAttribute('aria-disabled');
        currentSubmitBtn.classList.remove('disabled');
        currentSubmitBtn.removeAttribute('style');
        currentSubmitBtn.style.cssText = '';
        // Ставим точные такие же классы как у Cancel
        currentSubmitBtn.className = 'g-btn m-flat m-btn-gaps m-reset-width';
        
        // Добавляем CSS правило
        var styleEl = document.getElementById('of-stats-submit-style');
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = 'of-stats-submit-style';
          document.head.appendChild(styleEl);
        }
        styleEl.textContent = '#of-stats-submit-btn:not([disabled]):not(.disabled) { color: #00aff0 !important; opacity: 1 !important; background: none !important; background-color: transparent !important; pointer-events: auto !important; cursor: pointer !important; } #of-stats-submit-btn:not([disabled]):not(.disabled):hover { background-color: rgba(0, 145, 234, 0.06) !important; color: #0091ea !important; }';
        
        log('OF Stats: Submit button activated - className:', currentSubmitBtn.className, 'disabled:', currentSubmitBtn.disabled, 'style:', currentSubmitBtn.getAttribute('style'));
      }
      
      // Update input state (add $ prefix)
      updateInputState();
    });
    
    // Form submit
    document.getElementById('of-stats-withdrawal-form').addEventListener('submit', function(e) {
      e.preventDefault();
      var amount = inputEl.value;
      log('OF Stats: Withdrawal requested for $' + amount);
      closeModal();
    });
    
    log('OF Stats: Withdrawal modal opened with max $' + maxAmount);
  }
  
  // Function to activate withdrawal button
  function activateWithdrawButton(button) {
    if (!button || !cachedSettings || !cachedSettings.enabled) return;
    
    // Skip if already processed
    if (button.getAttribute('data-of-stats-processed')) return;
    button.setAttribute('data-of-stats-processed', 'true');
    
    // Just remove disabled, let OnlyFans CSS handle the active styling
    button.removeAttribute('disabled');
    
    // Clone to remove existing event listeners
    var newBtn = button.cloneNode(true);
    button.parentNode.replaceChild(newBtn, button);
    
    // Add our click handler
    newBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      showWithdrawalModal();
    }, true);
    
    log('OF Stats: Withdrawal button activated');
  }
  
  // Function to replace element content immediately
  function replaceContent(element) {
    if (!element || !cachedSettings) return;
    
    const className = element.className || '';
    // className может быть объектом SVGAnimatedString, пробразуем в строку
    const classStr = typeof className === 'string' ? className : (className.baseVal || '');
    
    // If this is a profile count span, update only if its parent button is Fans
    // AND we're on our own profile page
    if (classStr.indexOf('b-profile__sections__count') !== -1) {
      try {
        const parentBtn = element.closest('button.b-profile__sections__item');
        if (parentBtn && parentBtn.getAttribute) {
          const label = (parentBtn.getAttribute('aria-label') || '').toLowerCase();
          // Only replace fans count on OUR profile page
          if (label.indexOf('fans') !== -1 && cachedSettings.fansCount && isOwnProfilePage()) {
            element.textContent = cachedSettings.fansCount.trim();
          }
        }
      } catch (e) {}
    }
    
    // Current Balance - /my/statements/earnings page
    if (classStr.indexOf('current-balance__value') !== -1 || classStr.indexOf('current-balance_value') !== -1) {
      if (cachedSettings.currentBalance) {
        const formatted = formatNumber(cachedSettings.currentBalance);
        element.textContent = '$' + formatted;
      }
    }
    
    // Pending Balance - /my/statements/earnings page
    if (classStr.indexOf('pending-balance__value') !== -1 || classStr.indexOf('pending-balance_value') !== -1) {
      if (cachedSettings.pendingBalance) {
        const formatted = formatNumber(cachedSettings.pendingBalance);
        element.textContent = '$' + formatted;
      }
    }
    
    // Balance sums on /my/statistics/statements/earnings page
    if (classStr.indexOf('b-statements-balances__sum') !== -1) {
      // Find parent column to determine which balance this is
      const parentCol = element.closest('.b-statements-balances__col');
      if (parentCol) {
        if (parentCol.classList.contains('m-current')) {
          // Current balance
          if (cachedSettings.currentBalance) {
            const formatted = formatNumber(cachedSettings.currentBalance);
            element.textContent = ' $' + formatted + ' ';
            element.classList.remove('m-zero-value');
          }
        } else {
          // Pending balance (column without m-current class)
          if (cachedSettings.pendingBalance) {
            const formatted = formatNumber(cachedSettings.pendingBalance);
            element.textContent = ' $' + formatted + ' ';
            element.classList.remove('m-zero-value');
          }
        }
      }
    }
    
    // Fans/Following counts in the left sidebar (logged-in user's data) — applied site-wide.
    if (classStr.indexOf('user-data__item__count') !== -1) {
      // Find which one it is by checking parent
      const parent = element.closest('.l-sidebar__user-data__item');
      if (parent) {
        const allItems = document.querySelectorAll('.l-sidebar__user-data__item');
        const index = Array.from(allItems).indexOf(parent);
        
        if (index === 0 && cachedSettings.fansCount) {
          element.textContent = ' ' + cachedSettings.fansCount + ' ';
          // Also update aria-label for tooltip
          const ariaValue = cachedSettings.fansCount.replace(/[^\d]/g, '') || cachedSettings.fansCount;
          parent.setAttribute('aria-label', ariaValue);
        } else if (index === 1 && cachedSettings.followingCount) {
          element.textContent = ' ' + cachedSettings.followingCount + ' ';
          // Also update aria-label for tooltip
          const ariaValue = cachedSettings.followingCount.replace(/[^\d]/g, '') || cachedSettings.followingCount;
          parent.setAttribute('aria-label', ariaValue);
        }
      }
    }
    
    // Profile page: replace Fans count inside profile sections (button with aria-label="Fans")
    // Only on our own profile page
    try {
      // If the element is a profile sections button, check aria-label
      if (element.tagName === 'BUTTON' && element.getAttribute && element.getAttribute('aria-label') && isOwnProfilePage()) {
        const label = (element.getAttribute('aria-label') || '').toLowerCase();
        if (label.indexOf('fans') !== -1) {
          const span = element.querySelector('span.b-profile__sections__count');
          if (span && cachedSettings.fansCount) {
            span.textContent = cachedSettings.fansCount.trim();
          }
        }
      }
    } catch (e) {}
    
    // Earning stats page: replace category values immediately
    if (isEarningStatsPage()) {
      // Check if this is a category row value (.b-stats-row__val)
      if (classStr.indexOf('b-stats-row__val') !== -1) {
        replaceEarningStatsValue(element);
      }
      // Check if this is total net value
      if (classStr.indexOf('b-stats-row__total-net') !== -1) {
        var span = element.querySelector('span');
        if (span) replaceEarningStatsValue(span);
      }
    }
  }
  
  // Check if we're on earning stats page
  function isEarningStatsPage() {
    return window.location.pathname.includes('/my/stats/earnings');
  }
  
  // Replace earning stats values immediately using cached/generated data
  function replaceEarningStatsValue(element) {
    if (!element || element.getAttribute('data-of-stats-modified')) return;
    
    // Get or generate stats data
    var stats = getOrGenerateEarningStatsEarly();
    if (!stats) return;
    
    // Find which category this element belongs to
    var parent = element.closest('.b-stats-row__label');
    if (!parent) {
      // Maybe it's in All time row
      var row = element.closest('.b-stats-row');
      if (row) {
        var monthEl = row.querySelector('.b-stats-row__month');
        if (monthEl && isAllTimeText(monthEl.textContent)) {
          var netSpan = row.querySelector('.b-stats-row__total-net span');
          if (netSpan === element && !element.getAttribute('data-of-stats-modified')) {
            element.textContent = ' $' + formatCurrencyEarly(stats.net) + ' ';
            element.setAttribute('data-of-stats-modified', 'true');
            markContentReady();
          }
        }
      }
      return;
    }
    
    var parentClass = getClassStr(parent);
    
    // Category mapping
    var categoryMap = {
      'm-subscriptions': 'subscriptions',
      'm-tips': 'tips', 
      'm-posts': 'posts',
      'm-messages': 'messages',
      'm-referrals': 'referrals',
      'm-calls': 'streams'
    };
    
    // Check for total items (Gross/Net)
    if (parentClass.indexOf('m-total-item') !== -1) {
      var nameEl = parent.querySelector('.b-stats-row__name');
      if (nameEl) {
        var name = nameEl.textContent.trim().toLowerCase();
        if (isGrossLabel(name) && !element.getAttribute('data-of-stats-modified')) {
          element.textContent = ' $' + formatCurrencyEarly(stats.gross) + ' ';
          element.setAttribute('data-of-stats-modified', 'true');
          element.style.cursor = 'pointer';
          element.title = 'Click to regenerate stats';
          nameEl.textContent = getLocalizedGrossLabel();
          markContentReady();
        } else if (isNetLabel(name) && !element.getAttribute('data-of-stats-modified')) {
          element.textContent = ' $' + formatCurrencyEarly(stats.net) + ' ';
          element.setAttribute('data-of-stats-modified', 'true');
          nameEl.textContent = getLocalizedNetLabel();
          markContentReady();
        }
      }
      return;
    }
    
    // Find which category
    var catName = null;
    for (var cls in categoryMap) {
      if (parentClass.indexOf(cls) !== -1) {
        catName = categoryMap[cls];
        break;
      }
    }
    
    if (catName && stats.categories && stats.categories[catName]) {
      var catData = stats.categories[catName];
      var vals = parent.querySelectorAll('.b-stats-row__val');
      var idx = Array.from(vals).indexOf(element);
      
      if (idx === 0 && !element.getAttribute('data-of-stats-modified')) {
        // First val is Gross
        element.textContent = ' $' + formatCurrencyEarly(catData.gross) + ' ';
        element.setAttribute('data-of-stats-modified', 'true');
        markContentReady();
      } else if (idx === 1 && !element.getAttribute('data-of-stats-modified')) {
        // Second val is Net
        element.textContent = ' $' + formatCurrencyEarly(catData.net) + ' ';
        element.setAttribute('data-of-stats-modified', 'true');
        markContentReady();
      }
    }
  }
  
  // Mark content container as ready to show (removes CSS hiding)
  function markContentReady() {
    var contentContainer = document.querySelector('.b-stats-row__content');
    if (contentContainer && !contentContainer.getAttribute('data-of-stats-ready')) {
      contentContainer.setAttribute('data-of-stats-ready', 'true');
    }
  }
  
  // Early version of getOrGenerateEarningStats for immediate replacement
  function getOrGenerateEarningStatsEarly() {
    // Try to get from memory first, but validate against current balance
    if (typeof earningStatsData !== 'undefined' && earningStatsData) {
      // If data was loaded from a preset, use it without validation
      if (earningStatsData.fromPreset) {
        return earningStatsData;
      }
      
      // Check if current month is still valid
      var minRequired = 0;
      try {
        if (cachedSettings && cachedSettings.currentBalance) {
          minRequired += parseFloat(String(cachedSettings.currentBalance).replace(/[^0-9.]/g, '')) || 0;
        }
        if (cachedSettings && cachedSettings.pendingBalance) {
          minRequired += parseFloat(String(cachedSettings.pendingBalance).replace(/[^0-9.]/g, '')) || 0;
        }
      } catch(e) {}
      
      if (minRequired > 0 && earningStatsData.months && earningStatsData.months.length > 0) {
        var currentMonthNet = earningStatsData.months[0].net || 0;
        if (currentMonthNet < minRequired) {
          log('OF Stats Early: Cached current month ($' + currentMonthNet.toFixed(2) + ') < balance ($' + minRequired.toFixed(2) + '), will regenerate');
          earningStatsData = null;
          localStorage.removeItem('ofStatsEarningStats');
        } else {
          return earningStatsData;
        }
      } else {
        return earningStatsData;
      }
    }
    
    // Try localStorage
    try {
      var saved = localStorage.getItem('ofStatsEarningStats');
      if (saved) {
        var parsed = JSON.parse(saved);
        
        // If data was loaded from a preset, use it without validation
        if (parsed.fromPreset) {
          log('OF Stats Early: Using earning stats from preset - Gross: $' + (parsed.gross || 0).toFixed(2) + ', Net: $' + (parsed.net || 0).toFixed(2));
          earningStatsData = parsed;
          return earningStatsData;
        }
        
        // Validate against current balance before using
        var minRequired = 0;
        try {
          if (cachedSettings && cachedSettings.currentBalance) {
            minRequired += parseFloat(String(cachedSettings.currentBalance).replace(/[^0-9.]/g, '')) || 0;
          }
          if (cachedSettings && cachedSettings.pendingBalance) {
            minRequired += parseFloat(String(cachedSettings.pendingBalance).replace(/[^0-9.]/g, '')) || 0;
          }
        } catch(e) {}
        
        if (minRequired > 0 && parsed.months && parsed.months.length > 0) {
          var currentMonthNet = parsed.months[0].net || 0;
          if (currentMonthNet < minRequired) {
            log('OF Stats Early: Stored current month ($' + currentMonthNet.toFixed(2) + ') < balance ($' + minRequired.toFixed(2) + '), will regenerate');
            localStorage.removeItem('ofStatsEarningStats');
            // Continue to generate new data
          } else {
            earningStatsData = parsed;
            return earningStatsData;
          }
        } else {
          earningStatsData = parsed;
          return earningStatsData;
        }
      }
    } catch(e) {}
    
    // On /my/stats/earnings page, always generate initial data if none exists
    // This ensures the first load shows values instead of $0.00
    if (isEarningStatsPage()) {
      log('OF Stats Early: No valid data found on earnings stats page, generating initial data...');
      
      // Get minimum balance requirement (Current + Pending balance)
      var minRequired = 0;
      try {
        if (cachedSettings && cachedSettings.currentBalance) {
          minRequired += parseFloat(String(cachedSettings.currentBalance).replace(/[^0-9.]/g, '')) || 0;
        }
        if (cachedSettings && cachedSettings.pendingBalance) {
          minRequired += parseFloat(String(cachedSettings.pendingBalance).replace(/[^0-9.]/g, '')) || 0;
        }
      } catch(e) {}
      
      // Generate random initial gross (1K-10K range, but at least 1.5x of min required for proper distribution)
      var minGross = Math.max(1000, (minRequired / 0.8) * 1.5);
      var maxGross = Math.max(10000, minGross * 2);
      var gross = minGross + Math.random() * (maxGross - minGross);
      gross = Math.floor(gross) + Math.random() * 0.99; // Add cents
      
      var net = gross * 0.8;
      
      // Distribute earnings across categories
      var messagesPercent = 0.73 + Math.random() * 0.04;
      var postsPercent = 0.02 + Math.random() * 0.02;
      var tipsPercent = 1 - messagesPercent - postsPercent;
      
      var categories = {
        subscriptions: { gross: 0, net: 0 },
        tips: { gross: gross * tipsPercent, net: net * tipsPercent },
        posts: { gross: gross * postsPercent, net: net * postsPercent },
        messages: { gross: gross * messagesPercent, net: net * messagesPercent },
        referrals: { gross: 0, net: 0 },
        streams: { gross: 0, net: 0 }
      };
      
      // Generate months data
      var months = generateMonthlyEarningsEarly(net, minRequired);
      
      earningStatsData = {
        gross: gross,
        net: net,
        categories: categories,
        months: months
      };
      
      // Save to localStorage so subsequent calls use this data
      try {
        localStorage.setItem('ofStatsEarningStats', JSON.stringify(earningStatsData));
      } catch(e) {}
      
      log('OF Stats Early: Generated initial stats - Gross: $' + gross.toFixed(2) + ', Net: $' + net.toFixed(2) + ', MinRequired: $' + minRequired.toFixed(2));
      return earningStatsData;
    }
    
    // For other pages (like /my/statistics/statements/earnings), generate temporary stats from transactions
    if (cachedSettings && (parseInt(cachedSettings.earningsCount) > 0 || parseInt(cachedSettings.earningsCompleteCount) > 0)) {
      var pendingCount = parseInt(cachedSettings.earningsCount) || 0;
      var completeCount = parseInt(cachedSettings.earningsCompleteCount) || 0;
      
      // Generate basic month data from transactions
      var transactions = getOrGenerateEarningsData(pendingCount, completeCount);
      if (transactions && transactions.length > 0) {
        // Calculate totals from transactions
        var totalNet = 0;
        transactions.forEach(function(t) {
          totalNet += t.net || 0;
        });
        
        // Generate 2 months data for Gross calculation
        var now = new Date();
        var currentMonth = now.getMonth();
        var currentYear = now.getFullYear();
        var prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
        var prevYear = currentMonth === 0 ? currentYear - 1 : currentYear;
        
        // Split net between 2 months (60/40 current/previous)
        var currentMonthNet = totalNet * 0.6;
        var prevMonthNet = totalNet * 0.4;
        
        // Generate category breakdown with fixed percentages for consistency
        var subsPercent = 0.35;
        var tipsPercent = 0.25;
        var messagesPercent = 0.25;
        var postsPercent = 0.10;
        var remainingPercent = 0.05;
        
        // Create temporary stats object (NOT saved to localStorage)
        var tempStats = {
          months: [
            {
              month: currentMonth,
              year: currentYear,
              net: currentMonthNet,
              categories: {
                subscriptions: currentMonthNet * subsPercent,
                tips: currentMonthNet * tipsPercent,
                messages: currentMonthNet * messagesPercent,
                posts: currentMonthNet * postsPercent,
                streams: currentMonthNet * remainingPercent,
                referrals: 0
              }
            },
            {
              month: prevMonth,
              year: prevYear,
              net: prevMonthNet,
              categories: {
                subscriptions: prevMonthNet * subsPercent,
                tips: prevMonthNet * tipsPercent,
                messages: prevMonthNet * messagesPercent,
                posts: prevMonthNet * postsPercent,
                streams: prevMonthNet * remainingPercent,
                referrals: 0
              }
            }
          ]
        };
        
        log('OF Stats: Created temporary earning stats from transactions (Net: $' + totalNet.toFixed(2) + ')');
        return tempStats;
      }
    }
    
    return null;
  }
  
  // Early version of generateMonthlyEarnings for initial data generation
  function generateMonthlyEarningsEarly(totalNet, minCurrentMonth) {
    var months = [];
    var now = new Date();
    var currentYear = now.getFullYear();
    var currentMonth = now.getMonth();
    
    // Generate 15-25 months of data
    var numMonths = 15 + Math.floor(Math.random() * 11);
    
    // Generate weights for each month (newer months get more weight)
    var weights = [];
    var totalWeight = 0;
    for (var i = 0; i < numMonths; i++) {
      var progressRatio = (numMonths - 1 - i) / (numMonths - 1);
      var weight = Math.pow(progressRatio, 2.2) + 0.05;
      weight *= (0.8 + Math.random() * 0.4);
      weights.push(weight);
      totalWeight += weight;
    }
    
    // Generate month data
    for (var i = 0; i < numMonths; i++) {
      var monthDate = new Date(currentYear, currentMonth - i, 1);
      var monthValue = (totalNet * weights[i] / totalWeight);
      
      // Current month: ensure MORE than minCurrentMonth (add 10-50% buffer)
      if (i === 0 && minCurrentMonth > 0) {
        var minWithBuffer = minCurrentMonth * (1.1 + Math.random() * 0.4); // 110-150% of min
        monthValue = Math.max(monthValue, minWithBuffer);
      }
      
      // For oldest months, cap at $1000
      var monthsFromStart = numMonths - 1 - i;
      if (monthsFromStart < 3) {
        monthValue = Math.min(monthValue, 300 + Math.random() * 700);
      } else if (monthsFromStart < 6) {
        monthValue = Math.min(monthValue, 800 + Math.random() * 1200);
      }
      
      monthValue = Math.max(monthValue, 50 + Math.random() * 100);
      
      // Generate category breakdown
      var messagesShare = 0.70 + Math.random() * 0.10;
      var postsShare = 0.02 + Math.random() * 0.02;
      var tipsShare = 1 - messagesShare - postsShare;
      
      months.push({
        date: monthDate,
        year: monthDate.getFullYear(),
        month: monthDate.getMonth(),
        net: monthValue,
        categories: {
          subscriptions: 0,
          tips: tipsShare * monthValue,
          posts: postsShare * monthValue,
          messages: messagesShare * monthValue,
          referrals: 0,
          streams: 0
        }
      });
    }
    
    // Normalize to match total net, but preserve minCurrentMonth for current month
    var generatedTotal = months.reduce(function(sum, m) { return sum + m.net; }, 0);
    var adjustFactor = totalNet / generatedTotal;
    
    months.forEach(function(m, idx) {
      m.net *= adjustFactor;
      Object.keys(m.categories).forEach(function(cat) {
        m.categories[cat] *= adjustFactor;
      });
    });
    
    // After normalization, ensure current month is MORE than minCurrentMonth (with buffer)
    var minWithBufferFinal = minCurrentMonth * (1.1 + Math.random() * 0.4); // 110-150% of min
    if (minCurrentMonth > 0 && months.length > 0 && months[0].net < minWithBufferFinal) {
      var newNet = minWithBufferFinal;
      // Redistribute across categories proportionally
      var catTotal = 0;
      Object.keys(months[0].categories).forEach(function(cat) {
        catTotal += months[0].categories[cat];
      });
      if (catTotal > 0) {
        var catScale = newNet / catTotal;
        Object.keys(months[0].categories).forEach(function(cat) {
          months[0].categories[cat] *= catScale;
        });
      }
      months[0].net = newNet;
    }
    
    return months;
  }
  
  // Early version of formatCurrency for immediate replacement
  function formatCurrencyEarly(num) {
    if (typeof num !== 'number') num = parseFloat(num) || 0;
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  
  // Month names for early display
  var monthNamesEarly = ['January', 'February', 'March', 'April', 'May', 'June', 
                         'July', 'August', 'September', 'October', 'November', 'December'];
  var monthNamesEarlyRu = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
                           'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  var monthNamesShortRu = ['янв.', 'февр.', 'март', 'апр.', 'май', 'июнь', 'июль', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
  var monthNamesEarlyEs = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var monthNamesShortEs = ['ene.', 'feb.', 'mar.', 'abr.', 'may.', 'jun.', 'jul.', 'ago.', 'sep.', 'oct.', 'nov.', 'dic.'];
  var monthNamesEarlyDe = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  var monthNamesShortDe = ['Jan.', 'Feb.', 'Mär.', 'Apr.', 'Mai', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];
  
  // Create expandable month row HTML (early version)
  function createExpandableMonthRowEarly(monthData) {
    var lang = getPageLanguage();
    var monthName = lang === 'ru' ? monthNamesEarlyRu[monthData.month] : lang === 'es' ? monthNamesEarlyEs[monthData.month] : lang === 'de' ? monthNamesEarlyDe[monthData.month] : monthNamesEarly[monthData.month];
    var monthNameShort = lang === 'ru' ? monthNamesShortRu[monthData.month] : lang === 'es' ? monthNamesShortEs[monthData.month] : lang === 'de' ? monthNamesShortDe[monthData.month] : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][monthData.month];
    var yearStr = monthData.year.toString();
    var netValue = monthData.net;
    var netStr = formatCurrencyEarly(netValue);
    
    // Calculate gross from net (net is ~80% of gross)
    var grossValue = netValue / 0.8;
    var grossStr = formatCurrencyEarly(grossValue);
    
    // Get category data
    var categories = monthData.categories || {};
    var subsNet = categories.subscriptions || 0;
    var tipsNet = categories.tips || 0;
    var postsNet = categories.posts || 0;
    var messagesNet = categories.messages || 0;
    var streamsNet = categories.streams || 0;
    
    // Calculate gross for each category
    var subsGross = subsNet / 0.8;
    var tipsGross = tipsNet / 0.8;
    var postsGross = postsNet / 0.8;
    var messagesGross = messagesNet / 0.8;
    var streamsGross = streamsNet / 0.8;
    
    // Check if values are zero for m-zero-value class
    var subsZero = subsNet === 0 ? ' m-zero-value' : '';
    var tipsZero = tipsNet === 0 ? ' m-zero-value' : '';
    var postsZero = postsNet === 0 ? ' m-zero-value' : '';
    var messagesZero = messagesNet === 0 ? ' m-zero-value' : '';
    var streamsZero = streamsNet === 0 ? ' m-zero-value' : '';
    
    // Calculate first and last day of month for calendar button
    var daysInMonth = new Date(monthData.year, monthData.month + 1, 0).getDate();
    var fromDate = monthNameShort + ' 1, ' + yearStr;
    var toDate = monthNameShort + ' ' + daysInMonth + ', ' + yearStr;
    
    var row = document.createElement('div');
    row.className = 'b-stats-row';
    row.setAttribute('data-of-stats-generated', 'true');
    row.setAttribute('data-month-year', monthData.month + '-' + monthData.year);
    
    row.innerHTML = '<div class="b-stats-row__head">' +
      '<div class="b-stats-row__month"> ' + monthName + ', ' + yearStr + ' </div>' +
      '<div class="b-stats-row__total-net g-semibold"><span class="" data-of-stats-modified="true"> $' + netStr + ' </span></div>' +
      '<svg class="b-stats-row__arrow g-icon" data-icon-name="icon-arrow-down" aria-hidden="true"><use href="#icon-arrow-down" xlink:href="#icon-arrow-down"></use></svg>' +
      '</div>' +
      '<div class="b-stats-row__body" style="display: none;">' +
        '<div>' +
          '<div class="b-chart__wrapper" style="position: relative; margin-top: -15px;" data-of-month-chart="true">' +
            '<canvas class="b-chart__multiple-line" height="220" width="608" style="display: block; box-sizing: border-box; height: 220px; width: 608px;" data-of-stats-month-canvas="' + monthData.month + '-' + monthData.year + '" data-of-stats-overlay="true"></canvas>' +
          '</div>' +
        '</div>' +
        '<button class="g-btn m-border m-rounded m-block m-no-uppercase m-icon-absolute m-time-period m-lg">' +
          '<svg class="m-half-left g-icon" data-icon-name="icon-calendar" aria-hidden="true"><use href="#icon-calendar" xlink:href="#icon-calendar"></use></svg>' +
          '<span class="b-btn-text"> ' + (lang === 'ru' ? 'От ' : lang === 'es' ? 'Desde ' : lang === 'de' ? 'Von ' : 'From ') + '<span class="b-date-value">' + fromDate + '</span> ' + (lang === 'ru' ? 'К ' : lang === 'es' ? 'Hasta ' : lang === 'de' ? 'Bis ' : 'To ') + '<span class="b-date-value">' + toDate + '</span></span>' +
        '</button>' +
        '<div class="b-stats-row__content" data-of-stats-ready="true">' +
          '<div class="b-stats-row__label m-border-line m-subscriptions m-active">' +
            '<span class="b-stats-row__name g-md-text m-dots m-break-word"> ' + (lang === 'ru' ? 'Подписки' : lang === 'es' ? 'Suscripciones' : lang === 'de' ? 'Abonnements' : 'Subscriptions') + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + subsZero + '" data-of-stats-modified="true"> $' + formatCurrencyEarly(subsGross) + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + subsZero + '" data-of-stats-modified="true"> $' + formatCurrencyEarly(subsNet) + ' </span>' +
          '</div>' +
          '<div class="b-stats-row__label m-border-line m-tips">' +
            '<span class="b-stats-row__name g-md-text m-dots m-break-word"> ' + (lang === 'ru' ? 'Чаевые' : lang === 'es' ? 'Propinas' : lang === 'de' ? 'Trinkgelder' : 'Tips') + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + tipsZero + '" data-of-stats-modified="true"> $' + formatCurrencyEarly(tipsGross) + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + tipsZero + '" data-of-stats-modified="true"> $' + formatCurrencyEarly(tipsNet) + ' </span>' +
          '</div>' +
          '<div class="b-stats-row__label m-border-line m-posts">' +
            '<span class="b-stats-row__name g-md-text m-dots m-break-word"> ' + (lang === 'ru' ? 'Посты' : lang === 'es' ? 'Publicaciones' : lang === 'de' ? 'Beiträge' : 'Posts') + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + postsZero + '" data-of-stats-modified="true"> $' + formatCurrencyEarly(postsGross) + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + postsZero + '" data-of-stats-modified="true"> $' + formatCurrencyEarly(postsNet) + ' </span>' +
          '</div>' +
          '<div class="b-stats-row__label m-border-line m-messages">' +
            '<span class="b-stats-row__name g-md-text m-dots m-break-word"> ' + (lang === 'ru' ? 'Сообщения' : lang === 'es' ? 'Mensajes' : lang === 'de' ? 'Nachrichten' : 'Messages') + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + messagesZero + '" data-of-stats-modified="true"> $' + formatCurrencyEarly(messagesGross) + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + messagesZero + '" data-of-stats-modified="true"> $' + formatCurrencyEarly(messagesNet) + ' </span>' +
          '</div>' +
          '<div class="b-stats-row__label m-border-line m-referrals">' +
            '<span class="b-stats-row__name g-md-text m-dots m-break-word"> ' + (lang === 'ru' ? 'Рефералы' : lang === 'es' ? 'Referidos' : lang === 'de' ? 'Empfehlungen' : 'Referrals') + ' </span>' +
            '<span class="b-stats-row__val g-semibold m-zero-value" data-of-stats-modified="true"> $0.00 </span>' +
            '<span class="b-stats-row__val g-semibold m-zero-value" data-of-stats-modified="true"> $0.00 </span>' +
          '</div>' +
          '<div class="b-stats-row__label m-border-line m-calls">' +
            '<span class="b-stats-row__name g-md-text m-dots m-break-word"> ' + (lang === 'ru' ? 'Потоки' : lang === 'es' ? 'Transmisiones' : lang === 'de' ? 'Streams' : 'Streams') + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + streamsZero + '" data-of-stats-modified="true"> $' + formatCurrencyEarly(streamsGross) + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + streamsZero + '" data-of-stats-modified="true"> $' + formatCurrencyEarly(streamsNet) + ' </span>' +
          '</div>' +
          '<div class="b-stats-row__label m-border-line m-total">' +
            '<span class="b-stats-row__name g-md-text"> ' + (lang === 'ru' ? 'Итого' : lang === 'es' ? 'Total' : lang === 'de' ? 'Gesamt' : 'Total') + ' </span>' +
            '<div class="b-stats-row__label m-total-item pt-0 pb-0">' +
              '<span class="b-stats-row__name g-md-text"> ' + (lang === 'ru' ? 'Валовой' : lang === 'es' ? 'Bruto' : lang === 'de' ? 'Brutto' : 'Gross') + ' </span>' +
              '<span class="b-stats-row__val g-semibold" data-of-stats-modified="true"> $' + grossStr + ' </span>' +
            '</div>' +
            '<div class="b-stats-row__label m-total-item pt-0 pb-0">' +
              '<span class="b-stats-row__name g-md-text"> ' + (lang === 'ru' ? 'Чистая' : lang === 'es' ? 'Neto' : lang === 'de' ? 'Netto' : 'Net') + ' </span>' +
              '<span class="b-stats-row__val g-semibold" data-of-stats-modified="true"> $' + netStr + ' </span>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    
    // Add click handler to expand/collapse
    var head = row.querySelector('.b-stats-row__head');
    if (head) {
      head.style.cursor = 'pointer';
      head.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        toggleMonthRowEarly(row);
      });
    }
    
    // Use event delegation on the content area for category clicks
    var monthContent = row.querySelector('.b-stats-row__content');
    if (monthContent) {
      monthContent.addEventListener('click', function(e) {
        var label = e.target.closest('.b-stats-row__label.m-border-line:not(.m-total)');
        if (label) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          switchActiveCategory(row, label);
        }
      }, true); // capture phase
    }
    
    // Map current active category to class name
    var categoryClassMap = {
      'subscriptions': 'm-subscriptions',
      'tips': 'm-tips',
      'posts': 'm-posts',
      'messages': 'm-messages',
      'referrals': 'm-referrals',
      'streams': 'm-calls'
    };
    var activeClass = categoryClassMap[currentActiveCategory] || 'm-subscriptions';
    
    // Add cursor and handlers on labels, set initial styles based on current active category
    var categoryLabels = row.querySelectorAll('.b-stats-row__label.m-border-line:not(.m-total)');
    categoryLabels.forEach(function(label) {
      // Set initial styles based on current global active category
      var nameEl = label.querySelector('.b-stats-row__name');
      var isActive = label.classList.contains(activeClass);
      if (nameEl) {
        if (isActive) {
          label.classList.add('m-active');
          nameEl.style.color = '#000';
          nameEl.style.opacity = '1';
        } else {
          label.classList.remove('m-active');
          nameEl.style.color = '#8a96a3';
          nameEl.style.opacity = '0.6';
        }
      }
      label.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        switchActiveCategory(row, label);
      }, true); // capture phase
    });
    
    return row;
  }
  
  // Switch active category and redraw chart with new active line
  function switchActiveCategory(row, clickedLabel) {
    log('OF Stats: switchActiveCategory called, clickedLabel:', clickedLabel.className);
    
    // Remove m-active from all category labels and reset styles
    var allLabels = row.querySelectorAll('.b-stats-row__label.m-border-line:not(.m-total)');
    allLabels.forEach(function(label) {
      label.classList.remove('m-active');
      // Reset style to inactive - just color change, no font weight
      var nameEl = label.querySelector('.b-stats-row__name');
      if (nameEl) {
        nameEl.style.color = '#8a96a3';
        nameEl.style.opacity = '0.6';
      }
    });
    
    // Add m-active to clicked label and apply active styles - just black color
    clickedLabel.classList.add('m-active');
    var activeNameEl = clickedLabel.querySelector('.b-stats-row__name');
    if (activeNameEl) {
      activeNameEl.style.color = '#000';
      activeNameEl.style.opacity = '1';
    }
    log('OF Stats: m-active added to:', clickedLabel.className);
    
    // Determine which category was clicked
    var categoryMap = {
      'm-subscriptions': 'subscriptions',
      'm-tips': 'tips',
      'm-posts': 'posts',
      'm-messages': 'messages',
      'm-referrals': 'referrals',
      'm-calls': 'streams'
    };
    
    var activeCategory = 'subscriptions'; // default
    var labelClass = clickedLabel.className || '';
    for (var cls in categoryMap) {
      if (labelClass.indexOf(cls) !== -1) {
        activeCategory = categoryMap[cls];
        break;
      }
    }
    
    // Save active category globally for syncing
    currentActiveCategory = activeCategory;
    
    // Also update All time row to use same category
    var container = row.closest('.b-stats-wrap');
    if (container) {
      var allTimeRow = container.querySelector('.b-stats-row[data-of-stats-alltime]');
      if (allTimeRow) {
        applyActiveCategoryToAllTime(allTimeRow, activeCategory);
      }
    }
    
    // Redraw chart with new active category (no animation on switch)
    var canvas = row.querySelector('canvas[data-of-stats-month-canvas]');
    if (canvas) {
      // Store active category on canvas for redraw
      canvas.setAttribute('data-active-category', activeCategory);
      
      // Use no-animation version for quick switch
      var chartData = canvas._chartData;
      if (chartData) {
        var ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawMonthChartCanvasNoAnimation(canvas, chartData);
      }
    }
  }
  
  // Apply active category to All time row (sync from month)
  function applyActiveCategoryToAllTime(allTimeRow, activeCategory) {
    var categoryClassMap = {
      'subscriptions': 'm-subscriptions',
      'tips': 'm-tips',
      'posts': 'm-posts',
      'messages': 'm-messages',
      'referrals': 'm-referrals',
      'streams': 'm-calls'
    };
    
    var targetClass = categoryClassMap[activeCategory] || 'm-subscriptions';
    
    // Update category labels in All time row
    var allLabels = allTimeRow.querySelectorAll('.b-stats-row__label.m-border-line:not(.m-total)');
    allLabels.forEach(function(label) {
      label.classList.remove('m-current');
      if (label.classList.contains(targetClass)) {
        label.classList.add('m-current');
      }
    });
    
    // Redraw All time chart with new category (only if expanded)
    if (allTimeRow.classList.contains('m-expanded')) {
      var canvas = allTimeRow.querySelector('.b-chart__wrapper canvas[data-of-stats-overlay]');
      if (canvas) {
        canvas.setAttribute('data-active-category', activeCategory);
        var chartData = canvas._chartData;
        if (chartData) {
          var ctx = canvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
          drawAllTimeChartCanvasNoAnimation(canvas, chartData);
        }
      }
    }
  }
  
  // Toggle month row expansion (early version)
  // Cannot close all - can only switch between rows
  function toggleMonthRowEarly(row) {
    var isExpanded = row.classList.contains('m-expanded');
    var body = row.querySelector('.b-stats-row__body');
    
    // If already expanded, do nothing (can't close last open row)
    if (isExpanded) {
      return;
    }
    
    // Collapse All time row and other expanded months first
    var container = row.closest('.b-stats-wrap');
    if (container) {
      container.querySelectorAll('.b-stats-row.m-expanded').forEach(function(expandedRow) {
        expandedRow.classList.remove('m-expanded');
        var expandedBody = expandedRow.querySelector('.b-stats-row__body');
        if (expandedBody) expandedBody.style.display = 'none';
        
        // Destroy previous month chart instance when collapsing
        var prevCanvas = expandedBody ? expandedBody.querySelector('canvas[data-of-stats-month-canvas]') : null;
        if (prevCanvas) {
          prevCanvas.removeAttribute('data-chart-drawn');
          if (prevCanvas._chartInstance) {
            prevCanvas._chartInstance.destroy();
            prevCanvas._chartInstance = null;
          }
          var ctx = prevCanvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, prevCanvas.width, prevCanvas.height);
        }
        
        // Also reset All time canvas when collapsing All time row
        var allTimeCanvas = expandedBody ? expandedBody.querySelector('canvas[data-of-stats-overlay]') : null;
        if (allTimeCanvas) {
          allTimeCanvas.removeAttribute('data-chart-drawn');
          if (allTimeCanvas._chartInstance) {
            allTimeCanvas._chartInstance.destroy();
            allTimeCanvas._chartInstance = null;
          }
          var ctxAll = allTimeCanvas.getContext('2d');
          if (ctxAll) ctxAll.clearRect(0, 0, allTimeCanvas.width, allTimeCanvas.height);
        }
      });
    }
    
    // Expand this row
    row.classList.add('m-expanded');
    if (body) {
      body.style.display = 'block';
      
      // Apply current active category from All time to this month
      applyActiveCategoryToMonth(row, currentActiveCategory);
      
      // Draw chart for this month (always redraw for animation)
      var canvas = body.querySelector('canvas[data-of-stats-month-canvas]');
      if (canvas) {
        // Set active category before drawing
        canvas.setAttribute('data-active-category', currentActiveCategory);
        
        // Remove previous drawn attribute to force redraw with animation
        canvas.removeAttribute('data-chart-drawn');
        // Clear any previous content
        if (canvas._chartInstance) {
          canvas._chartInstance.destroy();
          canvas._chartInstance = null;
        }
        var ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Draw fresh with animation
        drawMonthChartEarly(canvas, row);
      }
    }
  }
  
  // Draw chart for a specific month (early version) - uses Chart.js like All time
  function drawMonthChartEarly(canvas, row) {
    if (!canvas) return;
    
    // Always clear and redraw for animation
    if (canvas._chartInstance) {
      canvas._chartInstance.destroy();
      canvas._chartInstance = null;
    }
    var ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    var monthKey = canvas.getAttribute('data-of-stats-month-canvas');
    if (!monthKey) return;
    
    var stats = getOrGenerateEarningStatsEarly();
    if (!stats || !stats.months) return;
    
    var parts = monthKey.split('-');
    var targetMonth = parseInt(parts[0]);
    var targetYear = parseInt(parts[1]);
    
    var monthData = null;
    for (var i = 0; i < stats.months.length; i++) {
      if (stats.months[i].month === targetMonth && stats.months[i].year === targetYear) {
        monthData = stats.months[i];
        break;
      }
    }
    
    if (!monthData) {
      log('OF Stats: Month data not found for', targetMonth, targetYear, 'in stats.months:', stats.months.map(function(m) { return m.month + '-' + m.year; }));
      return;
    }
    
    // Generate daily cumulative data for this month (like All time chart)
    var now = new Date();
    var isCurrentMonth = (targetYear === now.getFullYear() && targetMonth === now.getMonth());
    var currentDay = now.getDate();
    
    // Always use full month for chart display
    var daysInMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
    
    // For current month, data is only generated up to today
    var daysWithData = isCurrentMonth ? currentDay : daysInMonth;
    
    var categories = monthData.categories || {};
    
    // Ensure we have at least some data
    var hasAnyData = Object.keys(categories).some(function(cat) {
      return categories[cat] > 0;
    });
    
    if (!hasAnyData) {
      log('OF Stats: No category data for month', targetMonth, targetYear);
      // Still draw an empty chart for consistency
    }
    
    // Generate daily breakdown per category
    var dailyCategories = {
      subscriptions: [],
      tips: [],
      messages: [],
      posts: [],
      streams: [],
      referrals: []
    };
    
    // Distribute each category across days with cumulative growth (only up to daysWithData)
    Object.keys(dailyCategories).forEach(function(cat) {
      var totalForCat = categories[cat] || 0;
      var cumulative = 0;
      var remaining = totalForCat;
      
      // Generate data up to daysWithData
      for (var d = 0; d < daysWithData; d++) {
        var dayShare;
        if (d === daysWithData - 1) {
          dayShare = remaining;
        } else {
          var avgDaily = remaining / (daysWithData - d);
          // More variation for realistic growth
          dayShare = avgDaily * (0.2 + Math.random() * 1.6);
          dayShare = Math.max(0, Math.min(dayShare, remaining * 0.4));
        }
        cumulative += dayShare;
        remaining -= dayShare;
        dailyCategories[cat].push(cumulative);
      }
      
      // For current month: add flat line from today to end of month
      if (isCurrentMonth && daysWithData < daysInMonth) {
        var lastValue = cumulative; // Value at current day
        for (var d = daysWithData; d < daysInMonth; d++) {
          dailyCategories[cat].push(lastValue); // Flat line - same value
        }
      }
    });
    
    // Generate labels (day numbers) - always full month
    var labels = [];
    var langChart = getPageLanguage();
    var monthNamesShort = langChart === 'ru' ? ['янв.', 'февр.', 'март', 'апр.', 'май', 'июнь', 'июль', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.']
      : langChart === 'es' ? ['ene.', 'feb.', 'mar.', 'abr.', 'may.', 'jun.', 'jul.', 'ago.', 'sep.', 'oct.', 'nov.', 'dic.']
      : langChart === 'de' ? ['Jan.', 'Feb.', 'Mär.', 'Apr.', 'Mai', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.']
      : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (var d = 1; d <= daysInMonth; d++) {
      labels.push(d.toString().padStart(2, '0') + ' ' + monthNamesShort[targetMonth] + ' ' + (targetYear % 100).toString().padStart(2, '0'));
    }
    
    // Prepare chart data in same format as All time
    var chartData = {
      labels: labels,
      datasets: dailyCategories
    };
    
    // Set canvas dimensions
    canvas.width = 608;
    canvas.height = 220;
    canvas.style.width = '608px';
    canvas.style.height = '220px';
    
    // Mark as drawn
    canvas.setAttribute('data-chart-drawn', 'true');
    
    // Use Chart.js via custom event (same as All time)
    triggerMonthChartDraw(canvas, chartData);
    
    log('OF Stats: Month chart triggered for', monthNamesShort[targetMonth], targetYear);
  }
  
  // Trigger month chart drawing (same approach as All time)
  function triggerMonthChartDraw(canvas, chartData) {
    // Store chartData on canvas for redraw when switching categories
    canvas._chartData = chartData;
    // For month charts, use same canvas drawing as All time
    drawMonthChartCanvas(canvas, chartData);
  }
  
  // Canvas drawing for month charts - identical to All time chart
  function drawMonthChartCanvas(canvas, chartData) {
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    var width = canvas.width;
    var height = canvas.height;
    
    // Chart colors - same as All time
    var colors = {
      subscriptions: '#2196f3', // Blue - main line
      messages: '#ff7043',
      tips: '#00bcd4',
      posts: '#ec407a',
      streams: '#ffa000',
      referrals: '#9575cd'     // Purple
    };
    
    // Padding - minimal top spacing, bottom for X-axis labels
    var padding = { top: 0, right: 10, bottom: 40, left: 10 };
    var chartWidth = width - padding.left - padding.right;
    var chartHeight = height - padding.top - padding.bottom;
    
    // Find max value from full data
    var maxValue = 0;
    var categories = ['subscriptions', 'messages', 'tips', 'posts', 'streams', 'referrals'];
    categories.forEach(function(cat) {
      var data = chartData.datasets[cat];
      if (data && data.length > 0) {
        var catMax = Math.max.apply(null, data);
        if (catMax > maxValue) maxValue = catMax;
      }
    });
    if (maxValue === 0) maxValue = 100;
    maxValue *= 1.15; // 15% grace like Chart.js - data won't touch top grid line
    
    var numPoints = chartData.labels.length;
    var xStep = chartWidth / (numPoints - 1);
    
    // Get active category - determines which line is bold
    var activeCategory = canvas.getAttribute('data-active-category') || 'subscriptions';
    
    // Prepare line data - active category LAST so it draws on top
    var drawOrder = ['tips', 'messages', 'posts', 'streams', 'referrals', 'subscriptions'];
    // Reorder: move active category to end so it draws on top
    drawOrder = drawOrder.filter(function(c) { return c !== activeCategory; });
    drawOrder.push(activeCategory);
    
    var linesToDraw = [];
    
    drawOrder.forEach(function(cat) {
      var data = chartData.datasets[cat];
      if (!data || data.length === 0) return;
      
      var points = [];
      for (var i = 0; i < data.length; i++) {
        var x = padding.left + i * xStep;
        var y = padding.top + chartHeight * (1 - data[i] / maxValue);
        points.push({ x: x, y: y });
      }
      
      // Active category line is slightly thicker and opaque, others thin and very transparent
      var isMain = cat === activeCategory;
      linesToDraw.push({
        points: points,
        color: colors[cat],
        lineWidth: isMain ? 1.8 : 2.5,
        alpha: isMain ? 1 : 0.25
      });
    });
    
    // Animation variables - vertical grow like Chart.js
    var animationDuration = 800;
    var startTime = null;
    
    function easeOutQuart(t) {
      return 1 - Math.pow(1 - t, 4);
    }
    
    // Calculate baseline Y (bottom of chart)
    var baselineY = padding.top + chartHeight;
    
    function animate(currentTime) {
      if (!startTime) startTime = currentTime;
      var elapsed = currentTime - startTime;
      var progress = Math.min(elapsed / animationDuration, 1);
      var easedProgress = easeOutQuart(progress);
      
      // Clear canvas
      ctx.clearRect(0, 0, width, height);
      
      // Draw grid lines (4 horizontal lines - matches All time Chart.js with maxTicksLimit:4)
      // 4 ticks = 4 lines dividing into 3 intervals: top line, 2 middle lines, bottom line
      ctx.strokeStyle = getChartGridColor();
      ctx.lineWidth = 1;
      for (var i = 0; i < 4; i++) {
        var gridY = padding.top + (chartHeight * i / 3);
        ctx.beginPath();
        ctx.moveTo(padding.left, gridY);
        ctx.lineTo(width - padding.right, gridY);
        ctx.stroke();
      }
      
      // Draw animated lines - vertical grow from baseline
      linesToDraw.forEach(function(line) {
        ctx.beginPath();
        ctx.strokeStyle = line.color;
        ctx.lineWidth = line.lineWidth;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.globalAlpha = line.alpha;
        
        // Calculate animated points (grow vertically from baseline)
        var animatedPoints = line.points.map(function(p) {
          var animatedY = baselineY + (p.y - baselineY) * easedProgress;
          return { x: p.x, y: animatedY };
        });
        
        ctx.moveTo(animatedPoints[0].x, animatedPoints[0].y);
        for (var i = 0; i < animatedPoints.length - 1; i++) {
          var p0 = animatedPoints[i === 0 ? i : i - 1];
          var p1 = animatedPoints[i];
          var p2 = animatedPoints[i + 1];
          var p3 = animatedPoints[i + 2 < animatedPoints.length ? i + 2 : i + 1];
          var tension = 0.35;
          var cp1x = p1.x + (p2.x - p0.x) * tension;
          var cp1y = p1.y + (p2.y - p0.y) * tension;
          var cp2x = p2.x - (p3.x - p1.x) * tension;
          var cp2y = p2.y - (p3.y - p1.y) * tension;
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      });
      
      // Draw X-axis labels - theme-aware color, 5 evenly spaced
      ctx.globalAlpha = easedProgress;
      ctx.fillStyle = getChartLabelColor();
      ctx.font = getChartDateFont();
      ctx.textBaseline = 'top';
      
      // Position: bottom of chart area + offset for label spacing
      var labelY = chartHeight + padding.top + 15;
      
      // 5 label positions
      var labelIndices = [0, Math.floor(numPoints * 0.25), Math.floor(numPoints * 0.5), Math.floor(numPoints * 0.75), numPoints - 1];
      
      // === РќРђРЎРўР РћР™РљРђ ===
      var minLeftPosition = 67;
      
      var labelData = labelIndices.map(function(idx, i) {
        var label = chartData.labels[idx] || '';
        var dataPointX = padding.left + idx * xStep;
        var labelWidth = ctx.measureText(label).width;
        return { label: label, dataPointX: dataPointX, width: labelWidth, index: i };
      });
      
      var positions;
      if (canvas._fixedDatePositions) {
        positions = canvas._fixedDatePositions;
      } else {
        positions = new Array(5);
        var lastLabelLeft = (width - padding.right) - labelData[4].width;
        var labelSpace = (lastLabelLeft - minLeftPosition) / 4;
        for (var i = 0; i < 4; i++) {
          positions[i] = minLeftPosition + labelSpace * i;
        }
        positions[4] = width - padding.right;
        
        canvas._fixedDatePositions = positions.slice();
        canvas._fixedDateLabels = labelData.map(function(ld) { return ld.label; });
      }
      
      var labelsToUse = canvas._fixedDateLabels || labelData.map(function(ld) { return ld.label; });
      labelsToUse.forEach(function(label, i) {
        var x = positions[i];
        ctx.textAlign = (i === 4) ? 'right' : 'left';
        ctx.fillText(label, x, labelY);
      });
      ctx.globalAlpha = 1;
      
      // Continue animation
      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    }
    
    // Start animation
    requestAnimationFrame(animate);
  }
  
  // Draw month chart without animation (for category switching)
  function drawMonthChartCanvasNoAnimation(canvas, chartData) {
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    var width = canvas.width;
    var height = canvas.height;
    
    var colors = {
      subscriptions: '#2196f3',
      messages: '#ff7043',
      tips: '#00bcd4',
      posts: '#ec407a',
      streams: '#ffa000',
      referrals: '#9575cd'
    };
    
    var padding = { top: 0, right: 10, bottom: 40, left: 10 };
    var chartWidth = width - padding.left - padding.right;
    var chartHeight = height - padding.top - padding.bottom;
    
    var maxValue = 0;
    var categories = ['subscriptions', 'messages', 'tips', 'posts', 'streams', 'referrals'];
    categories.forEach(function(cat) {
      var data = chartData.datasets[cat];
      if (data && data.length > 0) {
        var catMax = Math.max.apply(null, data);
        if (catMax > maxValue) maxValue = catMax;
      }
    });
    if (maxValue === 0) maxValue = 100;
    maxValue *= 1.15;
    
    var numPoints = chartData.labels.length;
    var xStep = chartWidth / (numPoints - 1);
    
    var activeCategory = canvas.getAttribute('data-active-category') || 'subscriptions';
    
    var drawOrder = ['tips', 'messages', 'posts', 'streams', 'referrals', 'subscriptions'];
    drawOrder = drawOrder.filter(function(c) { return c !== activeCategory; });
    drawOrder.push(activeCategory);
    
    ctx.clearRect(0, 0, width, height);
    
    // Draw grid
    ctx.strokeStyle = getChartGridColor();
    ctx.lineWidth = 1;
    for (var i = 0; i < 4; i++) {
      var gridY = padding.top + (chartHeight * i / 3);
      ctx.beginPath();
      ctx.moveTo(padding.left, gridY);
      ctx.lineTo(width - padding.right, gridY);
      ctx.stroke();
    }
    
    // Draw lines
    drawOrder.forEach(function(cat) {
      var data = chartData.datasets[cat];
      if (!data || data.length === 0) return;
      
      var points = [];
      for (var i = 0; i < data.length; i++) {
        var x = padding.left + i * xStep;
        var y = padding.top + chartHeight * (1 - data[i] / maxValue);
        points.push({ x: x, y: y });
      }
      
      var isMain = cat === activeCategory;
      
      ctx.beginPath();
      ctx.strokeStyle = colors[cat];
      ctx.lineWidth = isMain ? 1.8 : 2.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalAlpha = isMain ? 1 : 0.25;
      
      ctx.moveTo(points[0].x, points[0].y);
      for (var i = 0; i < points.length - 1; i++) {
        var p0 = points[i === 0 ? i : i - 1];
        var p1 = points[i];
        var p2 = points[i + 1];
        var p3 = points[i + 2 < points.length ? i + 2 : i + 1];
        var tension = 0.35;
        
        var cp1x = p1.x + (p2.x - p0.x) * tension;
        var cp1y = p1.y + (p2.y - p0.y) * tension;
        var cp2x = p2.x - (p3.x - p1.x) * tension;
        var cp2y = p2.y - (p3.y - p1.y) * tension;
        
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
      }
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    
    // X-axis labels - theme-aware color
    ctx.globalAlpha = 1;
    ctx.fillStyle = getChartLabelColor();
    ctx.font = getChartDateFont();
    ctx.textBaseline = 'top';
    var labelY = chartHeight + padding.top + 15;
    
    var labelIndices = [0, Math.floor(numPoints * 0.25), Math.floor(numPoints * 0.5), Math.floor(numPoints * 0.75), numPoints - 1];
    
    // === РќРђРЎРўР РћР™РљРђ ===
    var minLeftPosition = 67;
    
    var labelData = labelIndices.map(function(idx, i) {
      var label = chartData.labels[idx] || '';
      var dataPointX = padding.left + idx * xStep;
      var labelWidth = ctx.measureText(label).width;
      return { label: label, dataPointX: dataPointX, width: labelWidth, index: i };
    });
    
    var positions;
    if (canvas._fixedDatePositions) {
      positions = canvas._fixedDatePositions;
    } else {
      positions = new Array(5);
      var lastLabelLeft = (width - padding.right) - labelData[4].width;
      var labelSpace = (lastLabelLeft - minLeftPosition) / 4;
      for (var i = 0; i < 4; i++) {
        positions[i] = minLeftPosition + labelSpace * i;
      }
      positions[4] = width - padding.right;
      
      canvas._fixedDatePositions = positions.slice();
      canvas._fixedDateLabels = labelData.map(function(ld) { return ld.label; });
    }
    
    var labelsToUse = canvas._fixedDateLabels || labelData.map(function(ld) { return ld.label; });
    labelsToUse.forEach(function(label, i) {
      var x = positions[i];
      ctx.textAlign = (i === 4) ? 'right' : 'left';
      ctx.fillText(label, x, labelY);
    });
  }
  
  // Apply monthly earnings immediately when container appears
  function applyMonthlyEarningsEarly() {
    if (!isEarningStatsPage()) return;
    
    var container = document.querySelector('.b-stats-wrap');
    if (!container) return;
    
    // Check if already applied
    if (container.getAttribute('data-of-stats-months-applied')) return;
    
    var stats = getOrGenerateEarningStatsEarly();
    if (!stats || !stats.months || stats.months.length === 0) return;
    
    // Find "All time" row and collect rows to remove
    var allTimeRow = null;
    var existingMonthRows = [];
    var existingGeneratedRows = [];
    var allRows = container.querySelectorAll('.b-stats-row');
    
    allRows.forEach(function(row) {
      var monthEl = row.querySelector('.b-stats-row__month');
      if (monthEl) {
        if (isAllTimeText(monthEl.textContent)) {
          allTimeRow = row;
          // Mark All time row so CSS doesn't hide it
          row.setAttribute('data-of-stats-alltime', 'true');
        } else if (row.getAttribute('data-of-stats-generated')) {
          // Our previously generated rows - remove them too (for tab navigation)
          existingGeneratedRows.push(row);
        } else {
          existingMonthRows.push(row);
        }
      }
    });
    
    // Remove existing month rows (original ones)
    existingMonthRows.forEach(function(row) {
      row.remove();
    });
    
    // Remove previously generated rows (fixes duplicate bug on tab navigation)
    existingGeneratedRows.forEach(function(row) {
      row.remove();
    });
    
    // Watch for new original month rows being added and remove them
    if (!container.getAttribute('data-of-stats-observer')) {
      container.setAttribute('data-of-stats-observer', 'true');
      var observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
          mutation.addedNodes.forEach(function(node) {
            if (node.nodeType === 1 && node.classList && node.classList.contains('b-stats-row')) {
              // Check if it's an original month row (not ours and not All time)
              if (!node.getAttribute('data-of-stats-generated') && !node.getAttribute('data-of-stats-alltime')) {
                var monthEl = node.querySelector('.b-stats-row__month');
                if (monthEl && !isAllTimeText(monthEl.textContent)) {
                  node.remove();
                  log('OF Stats: Removed dynamically added original month row');
                }
              }
            }
          });
        });
      });
      observer.observe(container, { childList: true });
    }
    
    // Add click handler to All time row if not already added
    if (allTimeRow && !allTimeRow.getAttribute('data-of-stats-click-handler')) {
      allTimeRow.setAttribute('data-of-stats-click-handler', 'true');
      var allTimeHead = allTimeRow.querySelector('.b-stats-row__head');
      if (allTimeHead) {
        allTimeHead.style.cursor = 'pointer';
        allTimeHead.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          toggleAllTimeRow(allTimeRow);
        });
      }
      
      // Use event delegation on the content area for category clicks
      // This ensures we catch clicks even if elements are recreated
      var allTimeContent = allTimeRow.querySelector('.b-stats-row__content');
      if (allTimeContent) {
        allTimeContent.addEventListener('click', function(e) {
          // Find the clicked label
          var label = e.target.closest('.b-stats-row__label.m-border-line:not(.m-total)');
          if (label) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            log('OF Stats: Category clicked in All time (delegated):', label.className);
            switchActiveCategoryAllTime(allTimeRow, label);
          }
        }, true); // capture phase
      }
      
      // Also add direct handlers on labels as backup
      var allTimeCategoryLabels = allTimeRow.querySelectorAll('.b-stats-row__label.m-border-line:not(.m-total)');
      allTimeCategoryLabels.forEach(function(label) {
        label.style.cursor = 'pointer';
        label.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          log('OF Stats: Category clicked in All time (direct):', label.className);
          switchActiveCategoryAllTime(allTimeRow, label);
        }, true); // capture phase
      });
      
      // Set initial m-current on Subscriptions if not already set
      var subscriptionsLabel = allTimeRow.querySelector('.b-stats-row__label.m-subscriptions');
      if (subscriptionsLabel && !allTimeRow.querySelector('.b-stats-row__label.m-current')) {
        subscriptionsLabel.classList.add('m-current');
      }
    }
    
    // Mark as applied
    container.setAttribute('data-of-stats-months-applied', 'true');
    
    // Insert month rows after "All time" row
    var insertAfter = allTimeRow || container.firstChild;
    
    stats.months.forEach(function(monthData) {
      var row = createExpandableMonthRowEarly(monthData);
      
      if (insertAfter && insertAfter.nextSibling) {
        container.insertBefore(row, insertAfter.nextSibling);
        insertAfter = row;
      } else {
        container.appendChild(row);
        insertAfter = row;
      }
    });
    
    // Ensure All time row is expanded by default
    if (allTimeRow && !allTimeRow.classList.contains('m-expanded')) {
      var body = allTimeRow.querySelector('.b-stats-row__body');
      allTimeRow.classList.add('m-expanded');
      if (body) body.style.display = 'block';
    }
    
    log('OF Stats: Early applied ' + stats.months.length + ' expandable month rows');
  }
  
  // Toggle All time row expansion
  // Can switch between rows
  function toggleAllTimeRow(row) {
    var isExpanded = row.classList.contains('m-expanded');
    var body = row.querySelector('.b-stats-row__body');
    
    // If already expanded, do nothing (can't close last open row)
    if (isExpanded) {
      return;
    }
    
    // Collapse all other expanded rows (generated months)
    var container = row.closest('.b-stats-wrap');
    if (container) {
      container.querySelectorAll('.b-stats-row.m-expanded').forEach(function(expandedRow) {
        expandedRow.classList.remove('m-expanded');
        var expandedBody = expandedRow.querySelector('.b-stats-row__body');
        if (expandedBody) expandedBody.style.display = 'none';
        
        // Destroy previous month chart instance when collapsing
        var prevCanvas = expandedBody ? expandedBody.querySelector('canvas[data-of-stats-month-canvas]') : null;
        if (prevCanvas) {
          prevCanvas.removeAttribute('data-chart-drawn');
          if (prevCanvas._chartInstance) {
            prevCanvas._chartInstance.destroy();
            prevCanvas._chartInstance = null;
          }
          var ctx = prevCanvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, prevCanvas.width, prevCanvas.height);
        }
      });
    }
    
    // Apply current active category to All time row before expanding
    applyActiveCategoryToAllTime(row, currentActiveCategory);
    
    // Expand All time row
    row.classList.add('m-expanded');
    if (body) {
      body.style.display = 'block';
      
      // Redraw All time chart with animation
      var canvas = row.querySelector('.b-chart__wrapper canvas[data-of-stats-overlay]');
      if (canvas) {
        // Set active category before drawing
        canvas.setAttribute('data-active-category', currentActiveCategory);
        
        // Destroy old Chart.js instance if exists
        if (canvas._chartInstance) {
          canvas._chartInstance.destroy();
          canvas._chartInstance = null;
        }
        canvas.removeAttribute('data-chart-drawn');
        
        // Clear canvas
        var ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Get chart data and redraw with animation
        var chartData = canvas._chartData;
        if (chartData) {
          drawAllTimeChartCanvas(canvas, chartData);
        }
      }
    }
  }
  
  // Switch active category for All time chart and redraw
  function switchActiveCategoryAllTime(row, clickedLabel) {
    // Remove m-current from all category labels in this row (use m-current like original site)
    var allLabels = row.querySelectorAll('.b-stats-row__label.m-border-line:not(.m-total)');
    allLabels.forEach(function(label) {
      label.classList.remove('m-current');
    });
    
    // Add m-current to clicked label
    clickedLabel.classList.add('m-current');
    
    // Determine which category was clicked
    var categoryMap = {
      'm-subscriptions': 'subscriptions',
      'm-tips': 'tips',
      'm-posts': 'posts',
      'm-messages': 'messages',
      'm-referrals': 'referrals',
      'm-calls': 'streams'
    };
    
    var activeCategory = 'subscriptions'; // default
    var labelClass = clickedLabel.className || '';
    for (var cls in categoryMap) {
      if (labelClass.indexOf(cls) !== -1) {
        activeCategory = categoryMap[cls];
        break;
      }
    }
    
    // Save active category globally for syncing with month rows
    currentActiveCategory = activeCategory;
    
    // Also update all expanded month rows to use same category
    var container = row.closest('.b-stats-wrap');
    if (container) {
      container.querySelectorAll('.b-stats-row[data-of-stats-generated].m-expanded').forEach(function(monthRow) {
        applyActiveCategoryToMonth(monthRow, activeCategory);
      });
    }
    
    // Redraw chart with new active category (no animation on switch)
    // Canvas is inside .b-chart__wrapper with our overlay attribute
    var canvas = row.querySelector('.b-chart__wrapper canvas[data-of-stats-overlay][data-of-stats-alltime-canvas]');
    if (!canvas) {
      canvas = row.querySelector('canvas[data-of-stats-alltime-canvas]');
    }
    if (!canvas) {
      canvas = row.querySelector('.b-chart__wrapper canvas[data-of-stats-overlay]');
    }
    log('OF Stats: switchActiveCategoryAllTime - canvas found:', !!canvas, 'activeCategory:', activeCategory);
    if (canvas) {
      // Store active category on canvas for redraw
      canvas.setAttribute('data-active-category', activeCategory);
      
      // Trigger redraw without animation
      var chartData = canvas._chartData;
      log('OF Stats: chartData exists:', !!chartData, 'chartData:', chartData);
      if (chartData) {
        var ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawAllTimeChartCanvasNoAnimation(canvas, chartData);
        log('OF Stats: Chart redrawn with active category:', activeCategory);
      }
    }
  }
  
  // Apply active category to a month row (sync from All time)
  function applyActiveCategoryToMonth(monthRow, activeCategory) {
    var categoryClassMap = {
      'subscriptions': 'm-subscriptions',
      'tips': 'm-tips',
      'posts': 'm-posts',
      'messages': 'm-messages',
      'referrals': 'm-referrals',
      'streams': 'm-calls'
    };
    
    var targetClass = categoryClassMap[activeCategory] || 'm-subscriptions';
    
    // Find and click the matching category label
    var allLabels = monthRow.querySelectorAll('.b-stats-row__label.m-border-line:not(.m-total)');
    allLabels.forEach(function(label) {
      label.classList.remove('m-active');
      var nameEl = label.querySelector('.b-stats-row__name');
      if (nameEl) {
        nameEl.style.color = '#8a96a3';
        nameEl.style.opacity = '0.6';
      }
      
      if (label.classList.contains(targetClass)) {
        label.classList.add('m-active');
        if (nameEl) {
          nameEl.style.color = '#000';
          nameEl.style.opacity = '1';
        }
      }
    });
    
    // Redraw month chart with new category
    var canvas = monthRow.querySelector('canvas[data-of-stats-month-canvas]');
    if (canvas) {
      canvas.setAttribute('data-active-category', activeCategory);
      var chartData = canvas._chartData;
      if (chartData) {
        var ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawMonthChartCanvasNoAnimation(canvas, chartData);
      }
    }
  }
  
  // Detect dark mode by checking class names AND computed backgrounds on multiple elements.
  // OnlyFans applies theme classes (m-night / m-dark / data-theme="dark") and on some pages
  // body is transparent — bg lives on html or a wrapper element, so we probe several sources.
  function isDarkMode() {
    try {
      // 1. Class-based detection on html / body (most reliable when present)
      var html = document.documentElement;
      var body = document.body;
      var classCheck = (el) => el && el.className && /\b(m-night|m-dark|night-mode|dark-mode|theme-dark)\b/.test(el.className);
      if (classCheck(html) || classCheck(body)) return true;
      if (html && html.getAttribute && (html.getAttribute('data-theme') === 'dark' || html.getAttribute('data-color-scheme') === 'dark')) return true;
      if (body && body.getAttribute && (body.getAttribute('data-theme') === 'dark' || body.getAttribute('data-color-scheme') === 'dark')) return true;

      // 2. Computed background — walk through candidates that might hold the actual page bg
      var candidates = [
        body,
        html,
        document.querySelector('.l-wrapper'),
        document.querySelector('.l-main-wrapper'),
        document.querySelector('.g-main-content'),
        document.querySelector('main')
      ];
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (!el) continue;
        var bg = window.getComputedStyle(el).backgroundColor;
        if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue;
        var m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          var r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
          return (r + g + b) / 3 < 128;
        }
      }
    } catch (e) {}
    return false;
  }

  // Get chart grid line color based on theme
  function getChartGridColor() {
    return isDarkMode() ? '#34363c' : '#eef2f7';
  }

  // Get chart label text color based on theme
  function getChartLabelColor() {
    return isDarkMode() ? '#e8e8e8' : '#333333';
  }

  // Get chart date label font based on theme
  function getChartDateFont() {
    return isDarkMode() ? '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' : '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  }

  // Apply chart overlay immediately when canvas appears
  function applyChartEarly() {
    if (!isEarningStatsPage()) return;
    
    var wrapper = document.querySelector('.b-chart__wrapper');
    if (!wrapper) return;
    
    // Check if overlay already exists
    if (wrapper.querySelector('[data-of-stats-overlay]')) return;
    
    var originalCanvas = wrapper.querySelector('canvas:not([data-of-stats-overlay])');
    if (!originalCanvas) return;
    
    var stats = getOrGenerateEarningStatsEarly();
    if (!stats || !stats.months || stats.months.length === 0) return;
    
    // Hide original canvas
    originalCanvas.style.visibility = 'hidden';
    
    // Generate chart data and create overlay
    // This will be handled by the full applyEarningStats later, 
    // but we hide original immediately to prevent flash
    log('OF Stats: Early hidden original chart canvas');
  }
  
  // Format number with commas
  function formatNumber(value) {
    if (!value) return value;
    let cleanValue = value.toString().trim().replace(/^\$/, '').trim();
    if (cleanValue.includes(',')) return cleanValue;
    const numMatch = cleanValue.match(/^(\d+)(\.(\d+))?$/);
    if (numMatch) {
      const intPart = numMatch[1];
      const decPart = numMatch[3] || '';
      const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return decPart ? formattedInt + '.' + decPart : formattedInt;
    }
    return cleanValue;
  }
  
  // Format percentage value
  function formatTopCreatorsPercentage(value) {
    if (!value) return value;
    let cleanValue = value.toString().trim().replace('%', '').trim();
    let num = parseFloat(cleanValue);
    if (isNaN(num)) return value;
    if (num < 1) return num.toFixed(2) + '%';
    if (Number.isInteger(num)) return num + '%';
    return cleanValue + '%';
  }
  
  // Check if we're on earnings page (statements or stats)
  function isEarningsPage() {
    const path = window.location.pathname;
    return path.includes('/my/statements/earnings') || path.includes('/my/stats/earnings') || path.includes('/my/statistics/statements/earnings');
  }
  
  // Check if we're on statistics/statements/earnings page (different UI)
  function isStatisticsStatementsEarningsPage() {
    return window.location.pathname.includes('/my/statistics/statements/earnings');
  }

  // Detect page language (ru / es / de / en)
  function getPageLanguage() {
    var htmlLang = (document.documentElement.lang || '').toLowerCase();
    if (htmlLang.startsWith('ru')) return 'ru';
    if (htmlLang.startsWith('es')) return 'es';
    if (htmlLang.startsWith('de')) return 'de';
    // Fallback: check for known UI text on the page
    var body = document.body ? (document.body.textContent || '').substring(0, 3000) : '';
    if (body.indexOf('Статистика') !== -1 || body.indexOf('Заявления') !== -1 || body.indexOf('Заработок') !== -1) return 'ru';
    if (body.indexOf('Estadísticas') !== -1 || body.indexOf('Ganancias') !== -1 || body.indexOf('Suscripciones') !== -1) return 'es';
    if (body.indexOf('Statistiken') !== -1 || body.indexOf('Einnahmen') !== -1 || body.indexOf('Abonnements') !== -1) return 'de';
    return 'en';
  }

  // Check if text is "All time" in any language
  function isAllTimeText(text) {
    var t = text.trim().toLowerCase();
    return t === 'all time' || t === 'все время' || t === 'за все время' || t === 'всё время'
        || t === 'todo el tiempo' || t === 'siempre' || t === 'todo tiempo'
        || t === 'gesamte zeit' || t === 'alle zeit' || t === 'gesamtzeitraum'
        || t === 'gesamt' || t === 'alle zeiten' || t === 'gesamter zeitraum'
        || t === 'immer' || t === 'zeitraum gesamt';
  }

  // Get localized Top Creators text
  function getTopCreatorsText(formattedPercentage) {
    var lang = getPageLanguage();
    var num = formattedPercentage.replace('%', '');
    if (lang === 'ru') return 'ВЫ НАХОДИТЕСЬ В ТОП% ' + num + 'ВСЕХ СОЗДАТЕЛЕЙ!';
    if (lang === 'es') return '¡Estáis en el TOP% ' + num + 'de todos los creadores!';
    if (lang === 'de') return 'SIE SINDEN IN DEN TOP% ' + num + 'ALLE Schöpfer!';
    return 'YOU ARE IN THE TOP ' + formattedPercentage + ' OF ALL CREATORS!';
  }

  // Check if text content looks like a Top Creators block (any language)
  function isTopCreatorsText(textContent) {
    var t = textContent.toUpperCase();
    return (t.indexOf('TOP') !== -1 && (t.indexOf('CREATORS') !== -1 || t.indexOf('CREADORES') !== -1 || t.indexOf('ERSTELLER') !== -1 || t.indexOf('SCHÖPFER') !== -1 || t.indexOf('SCHOPFER') !== -1)) ||
           (t.indexOf('ТОП') !== -1 && t.indexOf('СОЗДАТЕЛЕЙ') !== -1);
  }

  // Check if button text is a withdrawal request button (any language)
  function isWithdrawalButton(btnText) {
    var t = btnText.toLowerCase();
    return t.includes('request withdrawal') || t.includes('запрос на вывод')
        || t.includes('solicitar retiro') || t.includes('auszahlung anfordern');
  }

  // Check if name matches Gross label (any language)
  function isGrossLabel(name) {
    var n = name.toLowerCase().trim();
    return n === 'gross' || n === 'валовой' || n === 'гросс' || n === 'bruto' || n === 'brutto';
  }

  // Check if name matches Net label (any language)
  function isNetLabel(name) {
    var n = name.toLowerCase().trim();
    return n === 'net' || n === 'чистая' || n === 'neto' || n === 'neta' || n === 'netto';
  }

  // Get localized label for Gross
  function getLocalizedGrossLabel() {
    var lang = getPageLanguage();
    if (lang === 'ru') return 'Валовой';
    if (lang === 'es') return 'Bruto';
    if (lang === 'de') return 'Brutto';
    return 'Gross';
  }

  // Get localized label for Net
  function getLocalizedNetLabel() {
    var lang = getPageLanguage();
    if (lang === 'ru') return 'Чистая';
    if (lang === 'es') return 'Neto';
    if (lang === 'de') return 'Netto';
    return 'Net';
  }

  // Get localized earnings description
  function getEarningsDescription(type, userId, username) {
    var lang = getPageLanguage();
    if (lang === 'ru') {
      return type === 'tip'
        ? 'Чаевые от <a href="https://onlyfans.com/' + userId + '">' + username + '</a>'
        : 'Оплата за сообщение от <a href="https://onlyfans.com/' + userId + '">' + username + '</a>';
    }
    if (lang === 'es') {
      return type === 'tip'
        ? 'Propina de <a href="https://onlyfans.com/' + userId + '">' + username + '</a>'
        : 'Pago por mensaje de <a href="https://onlyfans.com/' + userId + '">' + username + '</a>';
    }
    if (lang === 'de') {
      return type === 'tip'
        ? 'Trinkgeld von <a href="https://onlyfans.com/' + userId + '">' + username + '</a>'
        : 'Zahlung für Nachricht von <a href="https://onlyfans.com/' + userId + '">' + username + '</a>';
    }
    return type === 'tip'
      ? 'Tip from <a href="https://onlyfans.com/' + userId + '">' + username + '</a>'
      : 'Payment for message from <a href="https://onlyfans.com/' + userId + '">' + username + '</a>';
  }

  // Get localized status tooltip text
  function getStatusTooltipText(status, daysRemaining) {
    var lang = getPageLanguage();
    if (lang === 'ru') {
      if (status === 'complete') return 'Завершить';
      if (status === 'reversed') return 'Перевернутый';
      return 'Заработок станет доступен в ' + daysRemaining + ' течение нескольких дней';
    }
    if (lang === 'es') {
      if (status === 'complete') return 'Completado';
      if (status === 'reversed') return 'Revertido';
      return 'Las ganancias estarán disponibles en ' + daysRemaining + ' día' + (daysRemaining !== 1 ? 's' : '');
    }
    if (lang === 'de') {
      if (status === 'complete') return 'Abgeschlossen';
      if (status === 'reversed') return 'Storniert';
      return 'Einnahmen verfügbar in ' + daysRemaining + ' Tag' + (daysRemaining !== 1 ? 'en' : '');
    }
    if (status === 'complete') return 'Complete';
    if (status === 'reversed') return 'Reversed';
    return 'Earning will become available in ' + daysRemaining + ' day' + (daysRemaining !== 1 ? 's' : '');
  }

  
  // Update Top Creators percentage in existing block or create new
  function updateTopCreatorsBanner() {
    if (!cachedSettings || !cachedSettings.topCreators) return;
    if (!isEarningsPage()) return;
    
    const formattedPercentage = formatTopCreatorsPercentage(cachedSettings.topCreators);

    // === /my/statistics/statements/earnings page ===
    // This page has a native Vue-controlled .b-top-rated block.
    // Vue re-renders this block continuously (first English, then translated).
    // We CANNOT edit its textContent — Vue overwrites it immediately.
    // Instead: hide native block via CSS, create our own block next to it.
    if (isStatisticsStatementsEarningsPage()) {
      // Inject persistent CSS to hide ALL native .b-top-rated blocks on this page
      // (always inject, even before native block exists, to prevent flash)
      if (!document.getElementById('of-stats-hide-native-top-rated')) {
        var hideStyle = document.createElement('style');
        hideStyle.id = 'of-stats-hide-native-top-rated';
        hideStyle.textContent = '.b-top-rated:not(#of-stats-top-creators-rated){display:none!important}';
        (document.head || document.documentElement).appendChild(hideStyle);
      }
      // Create or update our own block
      createTopCreatorsBlockStatistics(formattedPercentage);
      return;
    }
    
    // === /my/statements/earnings page ===
    // This page has a g-box style block with Top Creators text.
    // We update its text to our localized version.
    var localizedText = getTopCreatorsText(formattedPercentage);
    const allGBoxes = document.querySelectorAll('.g-box.m-with-icon.m-panel');
    let found = false;
    
    allGBoxes.forEach(function(box) {
      const textContent = box.textContent || '';
      if (isTopCreatorsText(textContent)) {
        const paragraph = box.querySelector('p, .g-box__header p');
        if (paragraph) {
          paragraph.innerHTML = localizedText;
          found = true;
          // If OF's own block was found (not our custom one), remove our custom block
          if (box.id !== 'of-stats-top-creators') {
            var ourBlock = document.getElementById('of-stats-top-creators');
            if (ourBlock) ourBlock.remove();
          }
        }
      }
    });
    
    // If not found, create the block
    if (!found) {
      createTopCreatorsBlock(formattedPercentage);
    }
  }
  
  // Create Top Creators block
  function createTopCreatorsBlock(formattedPercentage) {
    if (!isEarningsPage()) return false;
    if (document.getElementById('of-stats-top-creators')) return true;
    
    // Use different structure for /my/statistics/statements/earnings page
    if (isStatisticsStatementsEarningsPage()) {
      return createTopCreatorsBlockStatistics(formattedPercentage);
    }
    
    var block = document.createElement('div');
    block.id = 'of-stats-top-creators';
    block.className = 'g-box m-with-icon m-panel';
    block.innerHTML = '<div class="g-box__header"><svg class="g-box__icon g-icon" aria-hidden="true"><use href="#icon-star6" xlink:href="#icon-star6"></use></svg><p>' + getTopCreatorsText(formattedPercentage) + '</p></div>';
    
    // Add styles immediately
    if (!document.getElementById('of-stats-top-creators-style')) {
      var style = document.createElement('style');
      style.id = 'of-stats-top-creators-style';
      style.textContent = '#of-stats-top-creators{position:relative;border-radius:6px;margin:0 0 12px;width:100%;font-size:13px;overflow:hidden}#of-stats-top-creators::after{content:"";position:absolute;left:0;right:0;top:0;bottom:0;border:1px solid rgba(138,150,163,.25);border-radius:6px;pointer-events:none;z-index:1}#of-stats-top-creators .g-box__header{background:rgba(0,175,240,.12);padding:10px 17px 10px 52px;font-size:13px;font-weight:500;border-radius:6px;text-transform:uppercase;width:100%;display:flex;flex-direction:row;align-items:center;justify-content:flex-start}#of-stats-top-creators .g-box__icon{position:absolute;top:50%;left:16px;transform:translateY(-50%);width:24px;height:24px;display:inline-block;fill:currentColor;line-height:1;flex:0 0 24px}#of-stats-top-creators .g-box__icon use{color:#fa0}#of-stats-top-creators .g-box__header p{margin:0;line-height:16px}';
      if (document.head) {
        document.head.appendChild(style);
      } else {
        document.documentElement.appendChild(style);
      }
    }
    
    // Try multiple insertion points - with null checks
    var inserted = false;
    
    // Try .g-main-content first (main content wrapper)
    var mainContent = document.querySelector('.g-main-content');
    if (mainContent && mainContent.firstElementChild && !inserted) {
      try {
        mainContent.insertBefore(block, mainContent.firstElementChild);
        inserted = true;
      } catch(e) {}
    }
    
    // Try balance section
    if (!inserted) {
      var balanceSection = document.querySelector('.b-make-modal-w, [class*="balance"]');
      if (balanceSection && balanceSection.parentNode) {
        try {
          balanceSection.parentNode.insertBefore(block, balanceSection);
          inserted = true;
        } catch(e) {}
      }
    }
    
    // Try .b-payout__wrapper
    if (!inserted) {
      var payoutWrapper = document.querySelector('.b-payout__wrapper');
      if (payoutWrapper && payoutWrapper.firstChild) {
        try {
          payoutWrapper.insertBefore(block, payoutWrapper.firstChild);
          inserted = true;
        } catch(e) {}
      }
    }
    
    // Try row container after header
    if (!inserted) {
      var rowAfterHeader = document.querySelector('.g-page__header + .row, .row');
      if (rowAfterHeader && rowAfterHeader.firstChild) {
        try {
          rowAfterHeader.insertBefore(block, rowAfterHeader.firstChild);
          inserted = true;
        } catch(e) {}
      }
    }
    
    return inserted;
  }
  
  // Create Top Creators block for /my/statistics/statements/earnings page (b-top-rated style)
  function createTopCreatorsBlockStatistics(formattedPercentage) {
    var localizedText = getTopCreatorsText(formattedPercentage);
    // If our block already exists, just update its text
    var existing = document.getElementById('of-stats-top-creators-rated');
    if (existing) {
      var existingText = existing.querySelector('.b-top-rated__text');
      if (existingText) existingText.textContent = ' ' + localizedText + ' ';
      return true;
    }
    
    var block = document.createElement('div');
    block.id = 'of-stats-top-creators-rated';
    block.className = 'b-top-rated m-bordered';
    block.setAttribute('data-v-e08a9fd4', '');
    block.innerHTML = '<svg data-v-e08a9fd4="" class="b-top-rated__icon g-icon" data-icon-name="icon-star-on" aria-hidden="true"><use href="#icon-star-on" xlink:href="#icon-star-on"></use></svg><div data-v-e08a9fd4="" class="b-top-rated__text"> ' + localizedText + ' </div>';

    // Add styles immediately. Light/dark theme variants applied via .of-theme-dark class
    // toggled by syncTopCreatorsTheme() — defined below — and re-evaluated on theme changes.
    if (!document.getElementById('of-stats-top-creators-rated-style')) {
      var style = document.createElement('style');
      style.id = 'of-stats-top-creators-rated-style';
      style.textContent =
        '#of-stats-top-creators-rated.b-top-rated{display:flex!important;align-items:center;gap:4px;background:#fff!important;border:1px solid rgba(138,150,163,.25)!important;border-radius:6px;padding:14px 20px;margin-bottom:12px;font-size:14px;font-weight:500;white-space:nowrap;text-transform:none!important;color:#1d1d1d!important}' +
        '#of-stats-top-creators-rated.b-top-rated.of-theme-dark{background:#1c1d21!important;border-color:rgba(138,150,163,.2)!important;color:#e8e8e8!important}' +
        '#of-stats-top-creators-rated .b-top-rated__icon{width:24px;height:24px;flex-shrink:0;fill:#00aff0}' +
        '#of-stats-top-creators-rated .b-top-rated__text{line-height:1.2;white-space:nowrap;position:relative;top:1px;margin-left:-2px;text-transform:none!important}';
      if (document.head) {
        document.head.appendChild(style);
      } else {
        document.documentElement.appendChild(style);
      }
    }

    // Sync theme class based on current body brightness
    block.classList.toggle('of-theme-dark', isDarkMode());

    // Independent theme observer for the Top Creators banner.
    // Needed because the page-wide setupStatsThemeObserver only initializes on
    // /my/stats/earnings, not on /my/statistics/statements/earnings where this banner lives.
    if (!window._ofStatsTopCreatorsThemeObserver) {
      var syncBannerTheme = function() {
        var el = document.getElementById('of-stats-top-creators-rated');
        if (el) el.classList.toggle('of-theme-dark', isDarkMode());
      };
      // Re-check at staggered intervals to catch late theme application
      [100, 300, 600, 1000].forEach(function(d) { setTimeout(syncBannerTheme, d); });
      // Watch html/body for class/style changes (theme toggle)
      try {
        var obs = new MutationObserver(syncBannerTheme);
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
        obs.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
      } catch (e) {}
      // Catch the theme switch button click directly (sometimes class lags behind)
      document.addEventListener('click', function(e) {
        var btn = e.target.closest && e.target.closest('[data-name="SwitchTheme"]');
        if (btn) [50, 150, 300, 500].forEach(function(d) { setTimeout(syncBannerTheme, d); });
      }, true);
      window._ofStatsTopCreatorsThemeObserver = true;
    }
    
    // Try multiple insertion points
    var inserted = false;
    
    // Try .b-statements-balances (balance section on this page)
    var balancesSection = document.querySelector('.b-statements-balances');
    if (balancesSection && balancesSection.parentNode && !inserted) {
      try {
        balancesSection.parentNode.insertBefore(block, balancesSection);
        inserted = true;
      } catch(e) {}
    }
    
    // Try .g-main-content
    if (!inserted) {
      var mainContent = document.querySelector('.g-main-content');
      if (mainContent && mainContent.firstElementChild) {
        try {
          mainContent.insertBefore(block, mainContent.firstElementChild);
          inserted = true;
        } catch(e) {}
      }
    }
    
    // Try .b-payout__wrapper
    if (!inserted) {
      var payoutWrapper = document.querySelector('.b-payout__wrapper');
      if (payoutWrapper && payoutWrapper.firstChild) {
        try {
          payoutWrapper.insertBefore(block, payoutWrapper.firstChild);
          inserted = true;
        } catch(e) {}
      }
    }
    
    return inserted;
  }

  // Watch html[lang] changes — Vue sets this when i18n initializes.
  // When the language changes, update our Top Creators block text.
  (function() {
    var langObserver = new MutationObserver(function() {
      var our = document.getElementById('of-stats-top-creators-rated');
      if (!our || !cachedSettings || !cachedSettings.topCreators) return;
      var lang = getPageLanguage();
      if (lang === 'en') return; // still waiting
      var textEl = our.querySelector('.b-top-rated__text');
      if (textEl) {
        var pct = formatTopCreatorsPercentage(cachedSettings.topCreators);
        textEl.textContent = ' ' + getTopCreatorsText(pct) + ' ';
      }
    });
    langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  })();

  // ==================== EARLY EARNINGS GENERATOR ====================
  
  // Realistic usernames based on real patterns
  var earningsUsernames = [
    // Short names (most common)
    'Dan', 'Alex', 'John', 'Jake', 'Mike', 'Chris', 'Matt', 'Nick', 'Tom', 'Ben',
    'Sam', 'Joe', 'Rob', 'Dave', 'Steve', 'Mark', 'Paul', 'Ryan', 'Tony', 'James',
    'Viktor', 'Nader', 'Joel', 'Robbin', 'Marty', 'Jale', 'Cristian', 'Sean', 'Kris',
    'Charlie', 'Jan', 'Jindra', 'Kairi', 'ElDano', 'Kowal', 'Clone', 'Fastburn',
    // Internet style names
    'MrXhot', 'Mongalio', 'HadTraNer', 'Nomore', 'djwkflsla', 'JayWDRM', 'PonasBybis',
    'TheRealKing', 'szamsik', 'hotbillybob', 'Clone_Soldat', 'Lx1', 'BigBoss',
    // With numbers
    'Mike92', 'Chris85', 'Alex2001', 'John88', 'Dave87', 'Matt99', 'James82',
    'Rob94', 'Tom00', 'Nick91', 'hotbillybob1903', 'Gamer2020', 'Player1',
    // Gamer/cool tags  
    'DarkKnight', 'ShadowX', 'IceMan', 'WolfPack', 'StormRider', 'NightOwl',
    'RedFox', 'BlackHawk', 'SilentKing', 'PhantomX', 'IronWolf', 'GhostRider',
    'ThunderX', 'Viper', 'Falcon', 'Blaze', 'Reaper', 'Hunter', 'Warrior',
    // Compound names
    'BigDave', 'LilSam', 'MrJames', 'TheReal', 'JustMike', 'OnlyAlex',
    'CoolCat', 'ChillGuy', 'HappyDude', 'LazyBear', 'WildCard', 'LuckyStar',
    // Location/hobby style
    'NYCGuy', 'LAKid', 'TexasBoy', 'Skater', 'Surfer', 'Biker', 'Gamer',
    'Traveler', 'Photographer', 'Artist', 'Musician', 'Boxer', 'Wrestler',
    // Mixed style
    'xXShadowXx', 'Pr0Player', 'EpicWin', 'TryHard', 'NoobMaster', 'EzMode',
    // Simple variations
    'Johnny', 'Mikey', 'Danny', 'Sammy', 'Bobby', 'Jimmy', 'Tommy', 'Billy',
    'Ricky', 'Franky', 'Eddie', 'Freddy', 'Teddy', 'Kenny', 'Jerry', 'Larry'
  ];
  
  var earningsUsedNames = {};
  
  function earningsGenerateUsername() {
    // 8% chance for numeric ID style
    if (Math.random() < 0.08) {
      return 'u' + Math.floor(Math.random() * 900000000 + 100000000);
    }
    
    // Reset if too many used
    var usedCount = 0;
    for (var k in earningsUsedNames) usedCount++;
    if (usedCount > earningsUsernames.length * 0.8) {
      earningsUsedNames = {};
    }
    
    // Pick unused username
    var attempts = 0;
    var username;
    do {
      username = earningsUsernames[Math.floor(Math.random() * earningsUsernames.length)];
      attempts++;
    } while (earningsUsedNames[username] && attempts < 20);
    
    // Small variation sometimes (10% chance)
    if (Math.random() < 0.10) {
      var rand = Math.random();
      if (rand < 0.5) {
        username = username + Math.floor(Math.random() * 99 + 1);
      } else {
        username = username + (1980 + Math.floor(Math.random() * 45));
      }
    }
    
    earningsUsedNames[username] = true;
    return username;
  }
  
  function earningsGenerateAmount() {
    var rand = Math.random();
    if (rand < 0.35) return 5 + Math.floor(Math.random() * 11);
    if (rand < 0.60) return 15 + Math.floor(Math.random() * 16);
    if (rand < 0.80) return 30 + Math.floor(Math.random() * 21);
    if (rand < 0.92) return 50 + Math.floor(Math.random() * 51);
    return 100 + Math.floor(Math.random() * 51);
  }
  
  function earningsFormatDate(date) {
    var lang = getPageLanguage();
    if (lang === 'ru') {
      var ruMonths = ['янв.', 'февр.', 'март', 'апр.', 'май', 'июнь', 'июль', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
      return date.getDate() + ' ' + ruMonths[date.getMonth()] + ', ' + date.getFullYear();
    }
    if (lang === 'es') {
      var esMonths = ['ene.', 'feb.', 'mar.', 'abr.', 'may.', 'jun.', 'jul.', 'ago.', 'sep.', 'oct.', 'nov.', 'dic.'];
      return date.getDate() + ' ' + esMonths[date.getMonth()] + ', ' + date.getFullYear();
    }
    if (lang === 'de') {
      var deMonths = ['Jan.', 'Feb.', 'Mär.', 'Apr.', 'Mai', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];
      return date.getDate() + '. ' + deMonths[date.getMonth()] + ' ' + date.getFullYear();
    }
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[date.getMonth()] + ' ' + date.getDate() + ', ' + date.getFullYear();
  }
  
  function earningsFormatTime(date) {
    var hours = date.getHours();
    var minutes = date.getMinutes().toString().padStart(2, '0');
    var ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12 || 12;
    return hours + ':' + minutes + ' ' + ampm;
  }
  
  var earningsApplied = false; // Flag to prevent re-applying
  var lastCheckedUrl = window.location.href; // Track URL for SPA navigation
  var lastCheckedLang = getPageLanguage(); // Track language for re-render on language switch
  
  // Reset earnings state when navigating away
  function resetEarningsState() {
    earningsApplied = false;
    window.ofStatsEarningsApplied = false;
    window.ofStatsEarningsIndex = 0;
    window.ofStatsEarningsDelayDone = false; // Reset delay flag for next visit
    // Disconnect observer if exists
    if (window.ofStatsTbodyObserver) {
      window.ofStatsTbodyObserver.disconnect();
      window.ofStatsTbodyObserver = null;
    }
    // Remove scroll handler
    if (window.ofStatsScrollHandler) {
      window.removeEventListener('scroll', window.ofStatsScrollHandler);
      window.ofStatsScrollHandler = null;
    }
    // Don't clear transactions - keep cached data
  }
  
  // Helper to check if URL is an earnings page
  function isEarningsPageUrl(url) {
    return url.includes('/my/statements/earnings') || 
           url.includes('/my/statistics/statements/earnings') ||
           url.includes('/my/stats/earnings');
  }
  
  // Check if URL changed (SPA navigation)
  function checkUrlChange() {
    var currentUrl = window.location.href;
    if (currentUrl !== lastCheckedUrl) {
      var wasEarningsPage = isEarningsPageUrl(lastCheckedUrl);
      var isNowEarningsPage = isEarningsPageUrl(currentUrl);
      // Also track if we're moving between different earnings pages
      var changedEarningsPage = wasEarningsPage && isNowEarningsPage && lastCheckedUrl !== currentUrl;
      
      lastCheckedUrl = currentUrl;
      
      // If navigated away from earnings, reset state and remove hide style
      if (wasEarningsPage && !isNowEarningsPage) {
        resetEarningsState();
        // Remove hide style when leaving earnings page
        var hideStyle = document.getElementById('of-stats-hide-earnings-spa');
        if (hideStyle) hideStyle.remove();
        // CRITICAL: strip `data-of-stats-applied` from ALL stats wrappers when
        // leaving earnings. The earnings-page CSS rule (`of-stats-hide-earnings-content`)
        // hides every `.b-elements-determinant` inside any wrapper with this
        // flag — if Vue keep-alive reuses the wrapper for the fans/subscriptions
        // subtab, the flag carries over and silently empties the Summary widget.
        // Stripping the flag the moment we leave earnings keeps the rule scoped
        // to the actual earnings page only.
        document.querySelectorAll('.b-statistics-page-content__wrapper[data-of-stats-applied]').forEach(function (w) {
          // Destroy live Chart.js instances first to free memory
          try {
            if (typeof Chart !== 'undefined') {
              var mainCv = w.querySelector('#of-stats-earnings-chart-main');
              var asideCv = w.querySelector('#of-stats-earnings-chart-aside');
              if (mainCv) { var mC = Chart.getChart(mainCv); if (mC) mC.destroy(); }
              if (asideCv) { var aC = Chart.getChart(asideCv); if (aC) aC.destroy(); }
            }
          } catch (e) {}
          w.querySelectorAll('[data-of-stats-generated]').forEach(function (el) { el.remove(); });
          w.querySelectorAll('[data-of-stats-original-hidden]').forEach(function (el) {
            el.removeAttribute('data-of-stats-original-hidden');
            el.style.display = '';
          });
          w.removeAttribute('data-of-stats-applied');
        });
      }
      
      // If navigated to earnings (or moved between earnings pages), hide original rows first, then apply our data
      if (isNowEarningsPage || changedEarningsPage) {
        // Re-read settings from localStorage in case they were updated
        try {
          var freshCache = localStorage.getItem('ofStatsCache');
          if (freshCache) {
            cachedSettings = JSON.parse(freshCache);
          }
        } catch(e) {}

        // Immediately hide original rows to prevent flash
        if (cachedSettings && (cachedSettings.earningsCount || cachedSettings.earningsCompleteCount)) {
          if (!document.getElementById('of-stats-hide-earnings-spa')) {
            var hideStyle = document.createElement('style');
            hideStyle.id = 'of-stats-hide-earnings-spa';
            hideStyle.textContent = 'table.b-table.m-responsive.m-earnings tbody tr:not([data-of-stats]):not(:has(.infinite-loading-container)) { visibility: hidden !important; height: 0 !important; overflow: hidden !important; }';
            document.head.appendChild(hideStyle);
          }
        }

        // Tear down our chart from the previous visit so OF's natural loading
        // state shows again. Per user feedback: bugs accumulate when we skip
        // OF's loading dance — letting the page re-load from scratch each visit
        // is cleaner and matches OF's organic behaviour.
        document.querySelectorAll('.b-statistics-page-content__wrapper[data-of-stats-applied]').forEach(function (w) {
          // Destroy any live Chart.js instances bound to our canvases
          try {
            if (typeof Chart !== 'undefined') {
              var mainCv = w.querySelector('#of-stats-earnings-chart-main');
              var asideCv = w.querySelector('#of-stats-earnings-chart-aside');
              if (mainCv) { var mC = Chart.getChart(mainCv); if (mC) mC.destroy(); }
              if (asideCv) { var aC = Chart.getChart(asideCv); if (aC) aC.destroy(); }
            }
          } catch (e) {}
          // Drop our generated DOM
          w.querySelectorAll('[data-of-stats-generated]').forEach(function (el) { el.remove(); });
          // Restore visibility of original elements we previously hid
          w.querySelectorAll('[data-of-stats-original-hidden]').forEach(function (el) {
            el.removeAttribute('data-of-stats-original-hidden');
            el.style.display = '';
          });
          w.removeAttribute('data-of-stats-applied');
        });

        // Only reset the applied flag, not the cached data
        earningsApplied = false;
        window.ofStatsEarningsApplied = false;
        setTimeout(applyEarningsEarly, 100);
        setTimeout(applyEarningsEarly, 250);
        setTimeout(applyEarningsEarly, 400);
        setTimeout(applyEarningsEarly, 600);
        setTimeout(applyEarningsEarly, 800);
      }
    }
    
    // Detect language change (e.g. switching OnlyFans between English and Russian)
    var currentLang = getPageLanguage();
    if (currentLang !== lastCheckedLang) {
      log('OF Stats: Language changed from ' + lastCheckedLang + ' to ' + currentLang + ', re-rendering');
      lastCheckedLang = currentLang;
      
      // Force re-render of statistics/statements/earnings page
      var wrapper = findEarningsWrapper();
      if (wrapper) {
        wrapper.querySelectorAll('[data-of-stats-generated]').forEach(function(el) {
          el.remove();
        });
        wrapper.removeAttribute('data-of-stats-applied');
      }
      
      // Force re-render of stats page (/my/stats)
      var statsWrap = document.querySelector('.b-stats-wrap');
      if (statsWrap) {
        statsWrap.removeAttribute('data-of-stats-months-applied');
        statsWrap.removeAttribute('data-of-stats-observer');
        // Remove generated month rows
        statsWrap.querySelectorAll('[data-of-stats-generated]').forEach(function(el) {
          el.remove();
        });
        // Remove data-of-stats-modified from All time values so they re-apply
        statsWrap.querySelectorAll('[data-of-stats-modified]').forEach(function(el) {
          el.removeAttribute('data-of-stats-modified');
        });
        // Remove click handler flags so they re-attach
        statsWrap.querySelectorAll('[data-of-stats-click-handler]').forEach(function(el) {
          el.removeAttribute('data-of-stats-click-handler');
        });
      }
      
      // Remove overlay canvases (they have old language labels)
      document.querySelectorAll('canvas[data-of-stats-overlay]').forEach(function(el) {
        el.remove();
      });
      // Remove chart tooltips
      document.querySelectorAll('[data-of-stats-alltime-tooltip]').forEach(function(el) {
        el.remove();
      });
      // Restore hidden original canvases
      document.querySelectorAll('.b-chart__wrapper canvas').forEach(function(el) {
        if (el.style.visibility === 'hidden') {
          el.style.visibility = '';
        }
      });
      
      // Force re-render of earnings (statements) page
      earningsApplied = false;
      window.ofStatsEarningsApplied = false;
      
      // Remove generated earnings rows so they get recreated with new language
      document.querySelectorAll('tr[data-of-stats]').forEach(function(el) {
        el.remove();
      });
      
      // Re-apply everything with staggered timeouts
      setTimeout(applyEarningsEarly, 100);
      setTimeout(applyEarningsEarly, 300);
      setTimeout(applyEarningsEarly, 600);
      
      // Re-apply stats page
      setTimeout(function() {
        if (isEarningStatsPage()) {
          applyMonthlyEarningsEarly();
          applyChartEarly();
        }
        applyEarningStats();
      }, 150);
      setTimeout(function() {
        if (isEarningStatsPage()) {
          applyMonthlyEarningsEarly();
          applyChartEarly();
        }
        applyEarningStats();
      }, 400);
      setTimeout(function() {
        if (isEarningStatsPage()) {
          applyMonthlyEarningsEarly();
          applyChartEarly();
        }
        applyEarningStats();
      }, 800);
      
      // Re-apply statistics/statements/earnings page
      try {
        if (localStorage.getItem('ofStatsStatisticsChartDisabled') !== 'true') {
          setTimeout(applyStatisticsEarningsPage, 200);
          setTimeout(applyStatisticsEarningsPage, 500);
          setTimeout(applyStatisticsEarningsPage, 1000);
        }
      } catch(e) {
        setTimeout(applyStatisticsEarningsPage, 200);
      }
    }
  }
  
  // Poll for URL changes (catches SPA navigation)
  setInterval(checkUrlChange, 200);
  
  // Also listen to popstate for back/forward navigation
  window.addEventListener('popstate', function() {
    setTimeout(checkUrlChange, 50);
  });
  
  // Check if already applied (also check window flag for cross-script coordination)
  function isEarningsAlreadyApplied() {
    if (earningsApplied) return true;
    if (window.ofStatsEarningsApplied) return true;
    return false;
  }
  
  // Get or generate earnings data - uses localStorage to persist across page reloads
  // pendingCount = transactions within 7 days (status: pending/loading)
  // completeCount = transactions older than 7 days (status: complete ~98%, reversed ~2%)
  function getOrGenerateEarningsData(pendingCount, completeCount) {
    completeCount = completeCount || 0;
    var totalCount = pendingCount + completeCount;
    var cacheKey = 'ofStatsEarningsData';
    var keyKey = 'ofStatsEarningsKey';
    // Version 7: Fixed tooltip days calculation (7 - daysSince instead of 6)
    var today = new Date();
    var todayStr = today.getFullYear() + '-' + (today.getMonth() + 1) + '-' + today.getDate();
    var currentKey = 'earnings_v7_' + pendingCount + '_' + completeCount + '_' + todayStr;
    
    try {
      var savedKey = localStorage.getItem(keyKey);
      var savedData = localStorage.getItem(cacheKey);
      
      // If key matches and data exists, use cached data
      if (savedKey === currentKey && savedData) {
        var parsed = JSON.parse(savedData);
        // Restore Date objects
        for (var i = 0; i < parsed.length; i++) {
          parsed[i].date = new Date(parsed[i].date);
        }
        return parsed;
      }
    } catch(e) {}
    
    // Generate new data
    var generated = [];
    var now = new Date();
    
    // Calculate cutoff date (7 days ago at start of day)
    // If today is Jan 16, pending can be Jan 9-16 (16 - 7 = 9)
    // So cutoff is 7 days ago at 00:00:00
    var cutoffDate = new Date(now);
    cutoffDate.setDate(cutoffDate.getDate() - 7);
    cutoffDate.setHours(0, 0, 0, 0);
    
    // Generate PENDING transactions (last 7 days) - STRICT 7 day limit
    // Jan 16 minus 7 days = Jan 9, so we need Jan 9-16 = 8 calendar days
    // First, create array of available days (today and 7 days back)
    var pendingDays = [];
    for (var d = 0; d <= 7; d++) {  // 0-7 = 8 days (Jan 9-16)
      var dayDate = new Date(now);
      dayDate.setDate(dayDate.getDate() - d);
      dayDate.setHours(0, 0, 0, 0);
      pendingDays.push(dayDate);
    }
    
    // Distribute transactions evenly across all 8 days
    var numDays = pendingDays.length; // 8 days
    var basePerDay = Math.floor(pendingCount / numDays);
    var extraTrans = pendingCount % numDays;
    
    var transPerDay = [];
    for (var d = 0; d < numDays; d++) {
      // Give extra transactions to earlier days (more recent)
      var dayTrans = basePerDay + (d < extraTrans ? 1 : 0);
      transPerDay.push(dayTrans);
    }
    
    // Generate transactions for each day
    for (var dayIndex = 0; dayIndex < numDays; dayIndex++) {
      var dayTransCount = transPerDay[dayIndex];
      if (dayTransCount <= 0) continue;
      
      var dayStart = new Date(pendingDays[dayIndex]);
      dayStart.setHours(0, 0, 0, 0);
      var dayEnd = new Date(pendingDays[dayIndex]);
      dayEnd.setHours(23, 59, 59, 0);
      
      // Generate times for this day, spread throughout the day
      var dayTransactions = [];
      for (var t = 0; t < dayTransCount; t++) {
        // Spread evenly with some randomness
        var hourSlot = 23 - Math.floor((t / dayTransCount) * 24);
        var hour = Math.max(0, Math.min(23, hourSlot + Math.floor(Math.random() * 2 - 1)));
        var minute = Math.floor(Math.random() * 60);
        
        var transDate = new Date(dayStart);
        transDate.setHours(hour, minute, Math.floor(Math.random() * 60), 0);
        
        var amount = earningsGenerateAmount();
        dayTransactions.push({
          date: transDate,
          amount: amount,
          fee: amount * 0.20,
          net: amount * 0.80,
          type: Math.random() < 0.70 ? 'payment' : 'tip',
          username: earningsGenerateUsername(),
          userId: 'u' + Math.floor(Math.random() * 900000000 + 100000000),
          status: 'pending'
        });
      }
      
      // Sort by time descending and add to generated
      dayTransactions.sort(function(a, b) { return b.date - a.date; });
      generated = generated.concat(dayTransactions);
    }
    
    // Debug logging for pending date range
    if (pendingDays.length > 0) {
      var firstPending = pendingDays[0]; // Most recent (today)
      var lastPending = pendingDays[pendingDays.length - 1]; // Oldest pending (7 days ago)
      log('OF Stats: Pending date range: ' + earningsFormatDate(lastPending) + ' to ' + earningsFormatDate(firstPending) + ' (' + pendingDays.length + ' days)');
    }
    
    // Generate COMPLETE transactions (older than 7 days)
    // Pending is last 7 days (e.g., Jan 9-16), so complete starts from day 8 (Jan 8)
    if (completeCount > 0) {
      // Calculate how many days we need for complete transactions
      var daysNeeded = Math.ceil(completeCount / 10); // ~10 per day max
      daysNeeded = Math.max(daysNeeded, 7); // At least spread over a week
      
      // Create array of available days for complete (starting 8 days ago)
      var completeDays = [];
      for (var cd = 8; cd < 8 + daysNeeded; cd++) {
        var cDayDate = new Date(now);
        cDayDate.setDate(cDayDate.getDate() - cd);
        cDayDate.setHours(0, 0, 0, 0);
        completeDays.push(cDayDate);
      }
      
      // Debug logging for complete date range
      if (completeDays.length > 0) {
        var firstComplete = completeDays[0]; // Most recent complete (8 days ago)
        var lastComplete = completeDays[completeDays.length - 1]; // Oldest complete
        log('OF Stats: Complete date range: ' + earningsFormatDate(lastComplete) + ' to ' + earningsFormatDate(firstComplete) + ' (' + completeDays.length + ' days)');
      }
      
      // Distribute complete transactions across days
      var completePerDay = [];
      var remainingComplete = completeCount;
      
      for (var cd = 0; cd < completeDays.length; cd++) {
        if (cd < completeDays.length - 1) {
          var cDayTrans = Math.ceil(remainingComplete / (completeDays.length - cd) * (0.8 + Math.random() * 0.4));
          cDayTrans = Math.max(1, Math.min(cDayTrans, remainingComplete));
          completePerDay.push(cDayTrans);
          remainingComplete -= cDayTrans;
        } else {
          completePerDay.push(remainingComplete);
        }
      }
      
      // Generate transactions for each complete day
      for (var cDayIndex = 0; cDayIndex < completeDays.length; cDayIndex++) {
        var cDayTransCount = completePerDay[cDayIndex];
        if (cDayTransCount <= 0) continue;
        
        var cDayStart = new Date(completeDays[cDayIndex]);
        
        for (var ct = 0; ct < cDayTransCount; ct++) {
          var cHour = 23 - Math.floor((ct / cDayTransCount) * 24);
          cHour = Math.max(0, Math.min(23, cHour + Math.floor(Math.random() * 2 - 1)));
          var cMinute = Math.floor(Math.random() * 60);
          
          var transDate2 = new Date(cDayStart);
          transDate2.setHours(cHour, cMinute, Math.floor(Math.random() * 60), 0);
          
          var amount2 = earningsGenerateAmount();
          // ~2% reversed, ~98% complete
          var status = Math.random() < 0.02 ? 'reversed' : 'complete';
          
          generated.push({
            date: transDate2,
            amount: amount2,
            fee: amount2 * 0.20,
            net: amount2 * 0.80,
            type: Math.random() < 0.70 ? 'payment' : 'tip',
            username: earningsGenerateUsername(),
            userId: 'u' + Math.floor(Math.random() * 900000000 + 100000000),
            status: status
          });
        }
      }
    }
    
    generated.sort(function(a, b) { return b.date - a.date; });
    
    // Save to localStorage
    try {
      localStorage.setItem(keyKey, currentKey);
      localStorage.setItem(cacheKey, JSON.stringify(generated));
    } catch(e) {}
    
    return generated;
  }
  
  // Status tooltip element (singleton)
  var statusTooltipEl = null;
  
  function getStatusTooltip() {
    if (!statusTooltipEl) {
      statusTooltipEl = document.createElement('div');
      statusTooltipEl.className = 'of-stats-status-tooltip';
      document.body.appendChild(statusTooltipEl);
    }
    return statusTooltipEl;
  }
  
  function showStatusTooltip(target, text) {
    var tooltip = getStatusTooltip();
    tooltip.textContent = text;
    
    var rect = target.getBoundingClientRect();
    tooltip.style.left = (rect.left + rect.width / 2) + 'px';
    tooltip.style.top = (rect.top - 8) + 'px';
    tooltip.style.transform = 'translate(-50%, -100%)';
    tooltip.classList.add('visible');
  }
  
  function hideStatusTooltip() {
    if (statusTooltipEl) {
      statusTooltipEl.classList.remove('visible');
    }
  }
  
  // Hide tooltip on scroll
  window.addEventListener('scroll', hideStatusTooltip, true);
  
  // Add tooltip handlers to existing status-tip elements on page
  function initStatusTooltips() {
    var statusTips = document.querySelectorAll('.b-table__status-tip:not([data-of-tooltip-init])');
    statusTips.forEach(function(tip) {
      tip.setAttribute('data-of-tooltip-init', 'true');
      tip.addEventListener('mouseenter', function() {
        var text = tip.getAttribute('data-tooltip-text') || tip.getAttribute('aria-label');
        if (text) showStatusTooltip(tip, text);
      });
      tip.addEventListener('mouseleave', function() {
        hideStatusTooltip();
      });
    });
  }
  
  // Export for content.js
  window.ofStatsInitStatusTooltips = initStatusTooltips;
  
  // Create a full TR element with our data
  function createEarningsRow(trans) {
    var tr = document.createElement('tr');
    tr.setAttribute('data-of-stats', 'true');
    
    var desc = getEarningsDescription(trans.type, trans.userId, trans.username);
    
    // Determine icon and label based on status
    var status = trans.status || 'pending';
    var iconName, ariaLabel;
    
    if (status === 'complete') {
      iconName = 'icon-done';
    } else if (status === 'reversed') {
      iconName = 'icon-undo';
    } else {
      // Calculate days remaining based on transaction date (max 6 days)
      var now = new Date();
      now.setHours(0, 0, 0, 0);
      var transDate = new Date(trans.date);
      transDate.setHours(0, 0, 0, 0);
      var daysSince = Math.floor((now - transDate) / (1000 * 60 * 60 * 24));
      var daysRemaining = Math.max(1, 6 - daysSince);
      iconName = 'icon-loading';
    }
    ariaLabel = getStatusTooltipText(status, typeof daysRemaining !== 'undefined' ? daysRemaining : 1);
    
    tr.innerHTML = '<td class="b-table__date"><span class="b-table__date__date"><span title=""> ' + earningsFormatDate(trans.date) + ' </span></span><span class="b-table__date__time"><span title=""> ' + earningsFormatTime(trans.date) + ' </span></span></td><td data-title="Amount" class="b-table__amount"><span class=""> $' + trans.amount.toFixed(2) + ' </span></td><td data-title="Fee" class="b-table__fee"><span class=""> $' + trans.fee.toFixed(2) + ' </span></td><td data-title="Net" class="b-table__net"><strong><span class=""> $' + trans.net.toFixed(2) + ' </span></strong></td><td class="b-table__desc"><span>' + desc + '</span><span tabindex="0" class="b-table__status-tip" data-tooltip-text="' + ariaLabel + '"><svg class="g-icon" data-icon-name="' + iconName + '" aria-hidden="true"><use href="#' + iconName + '" xlink:href="#' + iconName + '"></use></svg></span></td><td class="b-table__status"><span tabindex="0" class="b-table__status-tip" data-tooltip-text="' + ariaLabel + '"><svg class="g-icon" data-icon-name="' + iconName + '" aria-hidden="true"><use href="#' + iconName + '" xlink:href="#' + iconName + '"></use></svg></span></td>';
    
    // Add hover handlers for status tooltips
    var statusTips = tr.querySelectorAll('.b-table__status-tip');
    statusTips.forEach(function(tip) {
      tip.addEventListener('mouseenter', function() {
        var text = tip.getAttribute('data-tooltip-text') || tip.getAttribute('aria-label');
        if (text) showStatusTooltip(tip, text);
      });
      tip.addEventListener('mouseleave', function() {
        hideStatusTooltip();
      });
    });
    
    return tr;
  }
  
  // Check if a row is the infinite-loading row
  function isInfiniteLoadingRow(tr) {
    return tr.querySelector('.infinite-loading-container') !== null;
  }
  
  // Find the infinite-loading row
  function findInfiniteLoadingRow(tbody) {
    var rows = tbody.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
      if (isInfiniteLoadingRow(rows[i])) return rows[i];
    }
    return null;
  }
  
  // Remove original data rows (keep only infinite-loading)
  function removeOriginalDataRows(tbody) {
    var rows = tbody.querySelectorAll('tr');
    for (var i = rows.length - 1; i >= 0; i--) {
      var tr = rows[i];
      if (!isInfiniteLoadingRow(tr) && tr.getAttribute('data-of-stats') !== 'true') {
        tr.remove();
      }
    }
  }
  
  function applyEarningsEarly() {
    if (!cachedSettings) return;
    if (!cachedSettings.earningsCount && !cachedSettings.earningsCompleteCount) return;
    if (!isEarningsPage()) return;
    if (isEarningsAlreadyApplied()) return;
    
    var pendingCount = parseInt(cachedSettings.earningsCount) || 0;
    var completeCount = parseInt(cachedSettings.earningsCompleteCount) || 0;
    
    if (pendingCount <= 0 && completeCount <= 0) return;
    
    var table = document.querySelector('table.b-table.m-responsive.m-earnings');
    if (!table) return;
    
    var tbody = table.querySelector('tbody');
    if (!tbody) return;
    
    // Find infinite-loading row (loading spinner)
    var loadingRow = findInfiniteLoadingRow(tbody);
    if (!loadingRow) {
      // No loading row yet, wait
      setTimeout(applyEarningsEarly, 50);
      return;
    }
    
    // Add artificial delay for first load to show spinner naturally (500-800ms)
    if (!window.ofStatsEarningsDelayDone) {
      window.ofStatsEarningsDelayDone = true;
      var delay = 500 + Math.floor(Math.random() * 300); // 500-800ms
      setTimeout(applyEarningsEarly, delay);
      return;
    }
    
    // Mark as applied immediately
    earningsApplied = true;
    window.ofStatsEarningsApplied = true;
    
    // Get cached or generate transactions
    var transactions = getOrGenerateEarningsData(pendingCount, completeCount);
    window.ofStatsEarningsTransactions = transactions;
    var totalCount = transactions.length;
    
    // Remove any original data rows that OnlyFans might have added
    removeOriginalDataRows(tbody);
    
    // Insert our rows BEFORE the loading row
    var initialCount = Math.min(30, transactions.length);
    for (var i = 0; i < initialCount; i++) {
      var row = createEarningsRow(transactions[i]);
      tbody.insertBefore(row, loadingRow);
    }
    window.ofStatsEarningsIndex = initialCount;
    
    // Remove hiding styles (both initial and SPA navigation styles)
    var hideStyle = document.getElementById('of-stats-hide-earnings');
    if (hideStyle) hideStyle.remove();
    var hideStyleSpa = document.getElementById('of-stats-hide-earnings-spa');
    if (hideStyleSpa) hideStyleSpa.remove();
    
    // If there's more data, keep spinner visible at bottom. Otherwise hide it.
    if (initialCount >= transactions.length) {
      loadingRow.style.display = 'none';
    }
    // Spinner stays visible for scroll loading
    
    log('OF Stats Editor: Added ' + initialCount + ' earnings, total: ' + totalCount + ' (' + pendingCount + ' pending + ' + completeCount + ' complete)');
    
    // Setup observer to remove any future original rows and handle scroll
    setupTbodyObserver(tbody);
    
    // Setup scroll handler for loading more of OUR rows
    setupScrollHandler(loadingRow);
    
    // Init tooltips for status icons
    initStatusTooltips();
  }
  
  // Setup scroll handler to load more rows with loading animation
  function setupScrollHandler(loadingRow) {
    if (window.ofStatsScrollHandler) {
      window.removeEventListener('scroll', window.ofStatsScrollHandler);
    }
    
    var isLoadingMore = false;
    
    log('OF Stats Editor: Scroll handler setup, loadingRow:', loadingRow);
    
    window.ofStatsScrollHandler = function() {
      if (isLoadingMore) return;
      
      var trans = window.ofStatsEarningsTransactions;
      var idx = window.ofStatsEarningsIndex || 0;
      if (!trans || idx >= trans.length) return;
      
      var scrollY = window.scrollY || window.pageYOffset;
      var windowHeight = window.innerHeight;
      var documentHeight = document.documentElement.scrollHeight;
      
      // Trigger early (400px from bottom) so user doesn't see loading
      if (scrollY + windowHeight >= documentHeight - 400) {
        log('OF Stats Editor: Bottom reached, loading more...');
        isLoadingMore = true;
        
        var tbl = document.querySelector('table.b-table.m-responsive.m-earnings');
        if (!tbl) { isLoadingMore = false; return; }
        var tb = tbl.querySelector('tbody');
        if (!tb) { isLoadingMore = false; return; }
        
        // Find loading row fresh (in case DOM changed)
        var spinner = findInfiniteLoadingRow(tb);
        
        // Make sure spinner is visible
        if (spinner) {
          spinner.style.display = '';
        }
        
        // Quick load (2x faster)
        var loadDelay = 300 + Math.random() * 200; // 300-500ms
        
        setTimeout(function() {
          // Add next batch of 10 rows
          var endIdx = Math.min(idx + 10, trans.length);
          for (var j = idx; j < endIdx; j++) {
            var row = createEarningsRow(trans[j]);
            if (spinner) {
              tb.insertBefore(row, spinner);
            } else {
              tb.appendChild(row);
            }
          }
          window.ofStatsEarningsIndex = endIdx;
          log('OF Stats Editor: Loaded more (' + endIdx + '/' + trans.length + ')');
          
          // Hide spinner if no more data
          if (endIdx >= trans.length && spinner) {
            spinner.style.display = 'none';
          }
          
          // Reset flag immediately
          isLoadingMore = false;
        }, loadDelay);
      }
    };
    
    window.addEventListener('scroll', window.ofStatsScrollHandler, { passive: true });
    log('OF Stats Editor: Scroll listener added');
  }
  
  // Observer to remove original rows that OnlyFans might add
  function setupTbodyObserver(tbody) {
    if (window.ofStatsTbodyObserver) {
      window.ofStatsTbodyObserver.disconnect();
    }
    
    window.ofStatsTbodyObserver = new MutationObserver(function(mutations) {
      mutations.forEach(function(mutation) {
        mutation.addedNodes.forEach(function(node) {
          if (node.nodeType === 1 && node.tagName === 'TR') {
            // Skip infinite-loading row
            if (isInfiniteLoadingRow(node)) return;
            
            // Skip our rows
            if (node.getAttribute('data-of-stats') === 'true') return;
            
            // Remove original OnlyFans rows (we manage our own)
            node.remove();
          }
        });
      });
    });
    
    window.ofStatsTbodyObserver.observe(tbody, { childList: true });
  }
  
  // ==================== END EARLY EARNINGS GENERATOR ====================

  // Observe DOM and replace content as elements appear
  const observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      mutation.addedNodes.forEach(function(node) {
        if (node.nodeType === 1) {
          // Check for tooltip (skip our custom tooltips)
          if (node.classList && node.classList.contains('tooltip') && !node.hasAttribute('data-of-stats-custom')) {
            replaceTooltip(node);
          }
          
          // Check this element
          replaceContent(node);
          
          // Check for Top Creators block
          if (node.classList && node.classList.contains('g-box')) {
            const text = node.textContent || '';
            if (isTopCreatorsText(text)) {
              updateTopCreatorsBanner();
            }
          }
          
          // Check if a container appeared where we can insert Top Creators
          if (isEarningsPage() && cachedSettings && cachedSettings.topCreators) {
            var classStr1 = getClassStr(node);
            if (classStr1.indexOf('g-main-content') !== -1 || 
                classStr1.indexOf('b-payout') !== -1 || 
                classStr1.indexOf('balance') !== -1 ||
                classStr1.indexOf('row') !== -1) {
              updateTopCreatorsBanner();
            }
          }
          
          // Check for earnings table
          if (isEarningsPage() && cachedSettings && cachedSettings.earningsCount) {
            var classStr2 = getClassStr(node);
            if (classStr2.indexOf('b-table') !== -1 || classStr2.indexOf('m-earnings') !== -1) {
              applyEarningsEarly();
            }
          }
          
          // Check for withdrawal button
          if (node.tagName === 'BUTTON' && isWithdrawalButton(node.textContent)) {
            activateWithdrawButton(node);
          }
          
          // Check all children
          if (node.querySelectorAll) {
            // Check for tooltips in children
            node.querySelectorAll('.tooltip').forEach(replaceTooltip);
            
            node.querySelectorAll(
              '[class*="balance__value"], [class*="balance_value"], ' +
              '.l-sidebar__user-data__item__count, .b-profile__sections__count'
            ).forEach(replaceContent);
            
            // Check for earning stats values on /my/stats/earnings page
            if (isEarningStatsPage()) {
              node.querySelectorAll('.b-stats-row__val, .b-stats-row__total-net span').forEach(replaceContent);
              
              // Check for months container - apply monthly earnings immediately
              if (node.classList && node.classList.contains('b-stats-wrap')) {
                applyMonthlyEarningsEarly();
              }
              node.querySelectorAll('.b-stats-wrap').forEach(function() {
                applyMonthlyEarningsEarly();
              });
              
              // Check for chart wrapper - apply chart overlay immediately
              if (node.classList && node.classList.contains('b-chart__wrapper')) {
                applyChartEarly();
              }
              node.querySelectorAll('.b-chart__wrapper').forEach(function() {
                applyChartEarly();
              });
            }
            
            // Check for Top Creators blocks in children
            node.querySelectorAll('.g-box.m-with-icon.m-panel').forEach(function(box) {
              const text = box.textContent || '';
              if (isTopCreatorsText(text)) {
                updateTopCreatorsBanner();
              }
            });
            
            // Check for b-top-rated blocks (re-rendered by Vue on language/page changes)
            node.querySelectorAll('.b-top-rated').forEach(function() {
              updateTopCreatorsBanner();
            });
            if (node.classList && node.classList.contains('b-top-rated')) {
              updateTopCreatorsBanner();
            }
            
            // Check for containers in children where we can insert Top Creators
            if (isEarningsPage() && cachedSettings && cachedSettings.topCreators) {
              if (node.querySelector('.g-main-content, .b-payout__wrapper, .row, [class*="balance"]')) {
                updateTopCreatorsBanner();
              }
            }
            
            // Find withdrawal buttons in children
            node.querySelectorAll('button[disabled]').forEach(function(btn) {
              if (isWithdrawalButton(btn.textContent)) {
                activateWithdrawButton(btn);
              }
            });
          }
        }
      });
    });
  });
  
  // ==================== EARNING STATISTICS PAGE (/my/stats/earnings) ====================
  
  function isEarningStatsPage() {
    return window.location.pathname.includes('/my/stats/earnings');
  }
  
  // Click counter for progressive generation
  var earningStatsClickCount = 0;
  
  // Get current balance from cached settings
  function getCurrentBalanceValue() {
    var currentBalance = 0;
    
    if (cachedSettings && cachedSettings.currentBalance) {
      currentBalance = parseFloat(cachedSettings.currentBalance.toString().replace(/[$,]/g, '')) || 0;
    }
    
    return currentBalance;
  }
  
  // Get current balance + pending from cached settings
  function getMinBalanceRequirement() {
    var currentBalance = 0;
    var pendingBalance = 0;
    
    if (cachedSettings) {
      if (cachedSettings.currentBalance) {
        currentBalance = parseFloat(cachedSettings.currentBalance.toString().replace(/[$,]/g, '')) || 0;
      }
      if (cachedSettings.pendingBalance) {
        pendingBalance = parseFloat(cachedSettings.pendingBalance.toString().replace(/[$,]/g, '')) || 0;
      }
    }
    
    return currentBalance + pendingBalance;
  }
  
  // Calculate Gross from average of 2 most recent months (from /my/stats/earnings page)
  // Gross must always be greater than Current balance
  // NOTE: This function must return STABLE values (no random) for chart caching to work
  function calculateGrossFromMonths(months) {
    if (!months || months.length < 2) {
      // Not enough months data, fallback to basic calculation
      var minRequired = getMinBalanceRequirement();
      return Math.max(minRequired * 1.5, 2500); // Fixed value, no random
    }
    
    // Get 2 most recent months (months[0] is current, months[1] is previous)
    var month1Net = months[0].net || 0;
    var month2Net = months[1].net || 0;
    
    // Average of 2 months (net values)
    var avgNet = (month1Net + month2Net) / 2;
    
    // Convert Net to Gross (Net = 80% of Gross, so Gross = Net / 0.8)
    var avgGross = avgNet / 0.8;
    
    // Ensure Gross is always greater than Current balance
    var currentBalance = getCurrentBalanceValue();
    if (avgGross <= currentBalance) {
      // Add 20% buffer above current balance (fixed, no random)
      avgGross = currentBalance * 1.2;
    }
    
    // Round to 2 decimal places for stability
    avgGross = Math.round(avgGross * 100) / 100;
    
    log('OF Stats: Calculated Gross from 2 months average - Month1 Net: $' + month1Net.toFixed(2) + ', Month2 Net: $' + month2Net.toFixed(2) + ', Avg Gross: $' + avgGross.toFixed(2) + ', Current Balance: $' + currentBalance.toFixed(2));
    return avgGross;
  }
  
  // Calculate percentage change between current and previous month
  function calculateMonthlyPercentageChange(months) {
    if (!months || months.length < 2) {
      return { value: 0, isIncrease: false };
    }
    
    var currentMonthNet = months[0].net || 0;
    var previousMonthNet = months[1].net || 0;
    
    if (previousMonthNet === 0) {
      return { value: 100, isIncrease: true }; // First month with earnings
    }
    
    var percentChange = ((currentMonthNet - previousMonthNet) / previousMonthNet) * 100;
    
    return {
      value: Math.abs(percentChange),
      isIncrease: percentChange >= 0
    };
  }
  
  // Generate Gross amount based on click count and minimum balance requirement
  function generateGrossAmount() {
    // Progressive ranges based on click count
    var ranges = [
      { min: 1000, max: 10000 },      // 1st click: up to 10K
      { min: 10000, max: 50000 },     // 2nd click: up to 50K
      { min: 50000, max: 100000 },    // 3rd click: up to 100K
      { min: 100000, max: 300000 },   // 4th click: up to 300K
      { min: 300000, max: 500000 }    // 5th+ click: up to 500K
    ];
    
    var rangeIndex = Math.min(earningStatsClickCount, ranges.length - 1);
    var range = ranges[rangeIndex];
    
    // Get minimum balance requirement (Current + Pending)
    var minRequired = getMinBalanceRequirement();
    // Gross needs to be at least 1.5x the required NET (since NET = 80% of Gross)
    // And we need at least 12 months of data, so multiply more
    var minGross = (minRequired / 0.8) * 1.5; // At least 1.5x to cover current month + some history
    
    // Adjust range minimum if needed
    var actualMin = Math.max(range.min, minGross);
    var actualMax = Math.max(range.max, minGross * 2);
    
    var gross = Math.floor(Math.random() * (actualMax - actualMin + 1)) + actualMin;
    // Add cents
    gross += Math.random() * 0.99;
    
    log('OF Stats: Generated gross with range ' + actualMin.toFixed(0) + '-' + actualMax.toFixed(0) + ' (click #' + (earningStatsClickCount + 1) + ', minRequired: $' + minRequired.toFixed(2) + ')');
    return gross;
  }
  
  // Calculate Net from Gross (80% after 20% commission)
  function calculateNet(gross) {
    return gross * 0.8;
  }
  
  // Format number as currency
  function formatCurrency(num) {
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  
  // Distribute earnings across categories
  function distributeEarnings(gross, net) {
    // Messages: ~75%
    // Tips: ~22%
    // Posts: ~3%
    // Subscriptions: always $0.00
    // Streams: always $0.00
    // Referrals: always $0.00
    
    var messagesPercent = 0.73 + Math.random() * 0.04; // 73-77%
    var postsPercent = 0.02 + Math.random() * 0.02; // 2-4%
    var tipsPercent = 1 - messagesPercent - postsPercent; // rest (~19-25%)
    
    return {
      subscriptions: { gross: 0, net: 0 },
      tips: { gross: gross * tipsPercent, net: net * tipsPercent },
      posts: { gross: gross * postsPercent, net: net * postsPercent },
      messages: { gross: gross * messagesPercent, net: net * messagesPercent },
      referrals: { gross: 0, net: 0 },
      streams: { gross: 0, net: 0 }
    };
  }
  
  // earningStatsData is already declared at the top of the file and loaded from localStorage
  // DO NOT redeclare it here - this was causing preset data to be overwritten!
  
  
  // Load saved earning stats from localStorage
  function loadEarningStats() {
    try {
      var saved = localStorage.getItem('ofStatsEarningStats');
      if (saved) {
        earningStatsData = JSON.parse(saved);
        log('OF Stats: Loaded earning stats from localStorage:', earningStatsData);
        return earningStatsData;
      } else {
        // localStorage was cleared, also clear in-memory cache
        if (earningStatsData) {
          log('OF Stats: localStorage empty but memory has data, clearing memory cache');
          earningStatsData = null;
        }
      }
    } catch (e) {
      logError('OF Stats: Error loading earning stats:', e);
    }
    return null;
  }
  
  // Save earning stats to localStorage
  function saveEarningStats(data) {
    try {
      localStorage.setItem('ofStatsEarningStats', JSON.stringify(data));
      log('OF Stats: Saved earning stats to localStorage');
    } catch (e) {
      logError('OF Stats: Error saving earning stats:', e);
    }
  }
  
  function getOrGenerateEarningStats() {
    // Always check localStorage first - it might have been cleared externally (by popup reset/apply)
    var savedData = loadEarningStats();
    
    // Use saved data if available, but validate against current balance
    if (savedData) {
      // If data was loaded from a preset, use it without validation
      if (savedData.fromPreset) {
        log('OF Stats: Using earning stats from preset - Gross: $' + (savedData.gross || 0).toFixed(2) + ', Net: $' + (savedData.net || 0).toFixed(2));
        return savedData;
      }
      
      // Check if current month earnings are still >= Current + Pending balance
      var minRequired = getMinBalanceRequirement();
      if (minRequired > 0 && savedData.months && savedData.months.length > 0) {
        var currentMonthNet = savedData.months[0].net || 0;
        if (currentMonthNet < minRequired) {
          log('OF Stats: Current month ($' + currentMonthNet.toFixed(2) + ') < balance requirement ($' + minRequired.toFixed(2) + '), regenerating...');
          // Need to regenerate - clear saved data
          savedData = null;
          earningStatsData = null;
          localStorage.removeItem('ofStatsEarningStats');
        }
      }
      
      if (savedData) {
        return savedData;
      }
    }
    
    // If no data in localStorage, generate new
    var gross = generateGrossAmount();
    var net = calculateNet(gross);
    var categories = distributeEarnings(gross, net);
    var months = generateMonthlyEarnings(net);
    
    earningStatsData = {
      gross: gross,
      net: net,
      categories: categories,
      months: months
    };
    
    // Save initial generation
    saveEarningStats(earningStatsData);
    
    log('OF Stats: Generated initial earning stats:', earningStatsData);
    return earningStatsData;
  }
  
  // Show modal for custom Gross input
  function showGrossInputModal() {
    // Remove any existing modal
    var existingModal = document.getElementById('of-stats-gross-modal');
    if (existingModal) existingModal.remove();
    
    // Create modal overlay
    var modal = document.createElement('div');
    modal.id = 'of-stats-gross-modal';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 999999; display: flex; align-items: center; justify-content: center;';
    
    // Create modal content
    var content = document.createElement('div');
    content.style.cssText = 'background: #fff; border-radius: 12px; padding: 24px; min-width: 320px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);';
    
    content.innerHTML = '<div style="margin-bottom: 16px; font-size: 18px; font-weight: 600; color: #000;">Set Custom Gross Value</div>' +
      '<div style="margin-bottom: 12px; font-size: 13px; color: #8a96a3;">Enter the Gross amount. Net and all months will be calculated automatically.</div>' +
      '<div style="position: relative; margin-bottom: 20px;">' +
        '<span style="position: absolute; left: 12px; top: 50%; transform: translateY(-50%); font-size: 16px; color: #000;">$</span>' +
        '<input type="text" id="of-stats-gross-input" placeholder="0.00" style="width: 100%; padding: 12px 12px 12px 28px; font-size: 16px; border: 1px solid #e0e0e0; border-radius: 8px; outline: none; box-sizing: border-box;" autocomplete="off">' +
      '</div>' +
      '<div style="display: flex; gap: 12px;">' +
        '<button id="of-stats-gross-cancel" style="flex: 1; padding: 12px; font-size: 14px; border: 1px solid #e0e0e0; border-radius: 8px; background: #fff; cursor: pointer;">Cancel</button>' +
        '<button id="of-stats-gross-apply" style="flex: 1; padding: 12px; font-size: 14px; border: none; border-radius: 8px; background: #00aff0; color: #fff; cursor: pointer; font-weight: 600;">Apply</button>' +
      '</div>';
    
    modal.appendChild(content);
    document.body.appendChild(modal);
    
    // Focus input
    var input = document.getElementById('of-stats-gross-input');
    if (input) {
      input.focus();
      
      // Format input as user types
      input.addEventListener('input', function(e) {
        var value = e.target.value.replace(/[^0-9.]/g, '');
        // Only allow one decimal point
        var parts = value.split('.');
        if (parts.length > 2) {
          value = parts[0] + '.' + parts.slice(1).join('');
        }
        // Limit decimal places to 2
        if (parts.length === 2 && parts[1].length > 2) {
          value = parts[0] + '.' + parts[1].substring(0, 2);
        }
        // Add thousand separators for display
        if (value) {
          var numParts = value.split('.');
          numParts[0] = numParts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          e.target.value = numParts.join('.');
        } else {
          e.target.value = value;
        }
      });
      
      // Handle Enter key
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyCustomGross();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          modal.remove();
        }
      });
    }
    
    // Cancel button
    var cancelBtn = document.getElementById('of-stats-gross-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function() {
        modal.remove();
      });
    }
    
    // Apply button
    var applyBtn = document.getElementById('of-stats-gross-apply');
    if (applyBtn) {
      applyBtn.addEventListener('click', function() {
        applyCustomGross();
      });
    }
    
    // Close on overlay click
    modal.addEventListener('click', function(e) {
      if (e.target === modal) {
        modal.remove();
      }
    });
  }
  
  // Apply custom Gross value and recalculate everything
  function applyCustomGross() {
    var input = document.getElementById('of-stats-gross-input');
    var modal = document.getElementById('of-stats-gross-modal');
    
    if (!input) return;
    
    // Parse the value (remove commas)
    var value = input.value.replace(/,/g, '');
    var gross = parseFloat(value);
    
    if (isNaN(gross) || gross <= 0) {
      input.style.borderColor = '#ff0000';
      return;
    }
    
    // Always add random cents (0.01 - 0.99) if user entered whole number
    if (gross === Math.floor(gross)) {
      gross = gross + Math.random() * 0.99 + 0.01;
    }
    // Round to 2 decimal places
    gross = Math.round(gross * 100) / 100;
    
    log('OF Stats: Applying custom Gross value: $' + gross);
    
    // Clear the statistics chart disabled flag (user is actively setting custom values)
    try {
      localStorage.removeItem('ofStatsStatisticsChartDisabled');
      log('OF Stats: Cleared statistics chart disabled flag (custom Gross applied)');
    } catch(e) {}
    
    // Calculate Net (80% of Gross)
    var net = calculateNet(gross);
    var categories = distributeEarnings(gross, net);
    
    // Check if we have preset data with oldest month to preserve
    var oldestMonthData = null;
    if (earningStatsData && earningStatsData.fromPreset && earningStatsData.oldestMonth) {
      oldestMonthData = earningStatsData.oldestMonth;
      log('OF Stats: Preserving oldest month from preset: ' + oldestMonthData.year + '-' + (oldestMonthData.month + 1));
    }
    
    // Generate new monthly data based on net (preserve oldest month if from preset)
    var months = generateMonthlyEarnings(net, oldestMonthData);
    
    // Update global stats
    earningStatsData = {
      gross: gross,
      net: net,
      categories: categories,
      months: months
    };
    
    // Preserve fromPreset and oldestMonth if it was from a preset
    if (oldestMonthData) {
      earningStatsData.fromPreset = true;
      earningStatsData.oldestMonth = oldestMonthData;
    }
    
    // Save to localStorage
    saveEarningStats(earningStatsData);
    
    // Remove all modified markers to allow re-update
    document.querySelectorAll('[data-of-stats-modified]').forEach(function(el) {
      el.removeAttribute('data-of-stats-modified');
    });
    
    // Remove months-replaced flag to allow re-generating
    var container = document.querySelector('.b-stats-wrap');
    if (container) {
      container.removeAttribute('data-of-stats-months-replaced');
      container.removeAttribute('data-of-stats-months-applied');
      // Remove all generated month rows
      container.querySelectorAll('[data-of-stats-generated]').forEach(function(row) {
        row.remove();
      });
    }
    
    // Remove content ready flag to allow re-applying values
    var contentContainer = document.querySelector('.b-stats-row__content');
    if (contentContainer) {
      contentContainer.removeAttribute('data-of-stats-ready');
    }
    
    // Remove chart modification flag and overlays
    var wrapper = document.querySelector('.b-chart__wrapper');
    if (wrapper) {
      var overlay = wrapper.querySelector('[data-of-stats-overlay]');
      if (overlay) overlay.remove();
      
      // Restore original canvas visibility
      var originalCanvas = wrapper.querySelector('canvas:not([data-of-stats-overlay])');
      if (originalCanvas) {
        originalCanvas.style.visibility = 'visible';
      }
    }
    var canvas = document.querySelector('.b-chart__wrapper canvas');
    if (canvas) {
      canvas.removeAttribute('data-of-stats-chart-modified');
    }
    
    // Close modal
    if (modal) modal.remove();
    
    // Apply the new stats
    applyEarningStats();
    
    log('OF Stats: Custom Gross applied - Gross: $' + formatCurrency(gross) + ', Net: $' + formatCurrency(net));
  }
  
  // Regenerate stats (called on GROSS click)
  function regenerateEarningStats() {
    earningStatsClickCount++;
    
    // Check if we have preset data with oldest month to preserve
    var oldestMonthData = null;
    var wasFromPreset = false;
    if (earningStatsData && earningStatsData.fromPreset && earningStatsData.oldestMonth) {
      oldestMonthData = earningStatsData.oldestMonth;
      wasFromPreset = true;
      log('OF Stats: Preserving oldest month from preset: ' + oldestMonthData.year + '-' + (oldestMonthData.month + 1));
    }
    
    var gross = generateGrossAmount();
    var net = calculateNet(gross);
    var categories = distributeEarnings(gross, net);
    
    // Generate new monthly data (preserve oldest month if from preset)
    var months = generateMonthlyEarnings(net, oldestMonthData);
    
    earningStatsData = {
      gross: gross,
      net: net,
      categories: categories,
      months: months
    };
    
    // Preserve fromPreset and oldestMonth if it was from a preset
    if (wasFromPreset && oldestMonthData) {
      earningStatsData.fromPreset = true;
      earningStatsData.oldestMonth = oldestMonthData;
    }
    
    // Save to localStorage
    saveEarningStats(earningStatsData);
    
    // Remove months-replaced flag to allow re-generating
    var container = document.querySelector('.b-stats-wrap');
    if (container) {
      container.removeAttribute('data-of-stats-months-replaced');
      container.removeAttribute('data-of-stats-months-applied');
      // Remove all generated month rows
      container.querySelectorAll('[data-of-stats-generated]').forEach(function(row) {
        row.remove();
      });
    }
    
    // Reset All time row click handler so it can be re-added
    // BUT keep it expanded (don't remove m-expanded class)
    var allTimeRows = document.querySelectorAll('.b-stats-row');
    allTimeRows.forEach(function(row) {
      var monthEl = row.querySelector('.b-stats-row__month');
      if (monthEl && isAllTimeText(monthEl.textContent)) {
        row.removeAttribute('data-of-stats-click-handler');
        // Don't remove data-of-stats-alltime - it's needed for styling
        // Don't remove m-expanded - keep it open
      }
    });
    
    // Remove content ready flag to allow re-applying values
    var contentContainer = document.querySelector('.b-stats-row__content');
    if (contentContainer) {
      contentContainer.removeAttribute('data-of-stats-ready');
    }
    
    // Remove chart modification flag and overlays
    var wrapper = document.querySelector('.b-chart__wrapper');
    if (wrapper) {
      var overlay = wrapper.querySelector('[data-of-stats-overlay]');
      if (overlay) overlay.remove();
      
      // Restore original canvas visibility
      var originalCanvas = wrapper.querySelector('canvas:not([data-of-stats-overlay])');
      if (originalCanvas) {
        originalCanvas.style.visibility = 'visible';
      }
    }
    var canvas = document.querySelector('.b-chart__wrapper canvas');
    if (canvas) {
      canvas.removeAttribute('data-of-stats-chart-modified');
    }
    
    log('OF Stats: Regenerated earning stats (click #' + earningStatsClickCount + '):', earningStatsData);
    return earningStatsData;
  }
  
  // Apply earning stats to the page
  function applyEarningStats() {
    if (!isEarningStatsPage()) return;
    
    var stats = getOrGenerateEarningStats();
    
    log('OF Stats: applyEarningStats called, looking for elements...');
    
    // 1. Update "All time" Net value (top right): .b-stats-row__total-net span
    var allTimeRows = document.querySelectorAll('.b-stats-row');
    log('OF Stats: Found ' + allTimeRows.length + ' .b-stats-row elements');
    
    allTimeRows.forEach(function(row) {
      var monthEl = row.querySelector('.b-stats-row__month');
      if (monthEl && isAllTimeText(monthEl.textContent)) {
        var netEl = row.querySelector('.b-stats-row__total-net span');
        log('OF Stats: Found All time row, netEl:', netEl);
        if (netEl && !netEl.getAttribute('data-of-stats-modified')) {
          netEl.textContent = ' $' + formatCurrency(stats.net) + ' ';
          netEl.setAttribute('data-of-stats-modified', 'true');
          log('OF Stats: Updated All time Net to $' + formatCurrency(stats.net));
        }
      }
    });
    
    // 2. Update GROSS total: .b-stats-row__label.m-total-item with "Gross"
    var totalItems = document.querySelectorAll('.b-stats-row__label.m-total-item');
    log('OF Stats: Found ' + totalItems.length + ' .b-stats-row__label.m-total-item elements');
    
    totalItems.forEach(function(item) {
      var nameEl = item.querySelector('.b-stats-row__name');
      var valEl = item.querySelector('.b-stats-row__val');
      log('OF Stats: Total item - name:', nameEl ? nameEl.textContent.trim() : 'null', 'val:', valEl ? valEl.textContent.trim() : 'null');
      if (nameEl && valEl) {
        var name = nameEl.textContent.trim().toLowerCase();
        if (isGrossLabel(name)) {
          if (!valEl.getAttribute('data-of-stats-modified')) {
            valEl.textContent = ' $' + formatCurrency(stats.gross) + ' ';
            valEl.setAttribute('data-of-stats-modified', 'true');
            nameEl.textContent = getLocalizedGrossLabel();
            valEl.style.cursor = 'pointer';
            valEl.title = 'Click to regenerate stats | Right-click to set custom value';
            log('OF Stats: Updated GROSS to $' + formatCurrency(stats.gross));
          }
          // Add click handler only once
          if (!valEl.getAttribute('data-of-stats-click-handler')) {
            valEl.setAttribute('data-of-stats-click-handler', 'true');
            valEl.addEventListener('click', function() {
              log('OF Stats: GROSS clicked, regenerating...');
              // Clear the statistics chart disabled flag (user is actively changing values)
              try {
                localStorage.removeItem('ofStatsStatisticsChartDisabled');
                log('OF Stats: Cleared statistics chart disabled flag (GROSS clicked)');
              } catch(e) {}
              // Remove all modified markers to allow re-update
              document.querySelectorAll('[data-of-stats-modified]').forEach(function(el) {
                el.removeAttribute('data-of-stats-modified');
              });
              regenerateEarningStats();
              applyEarningStats();
            });
            // Add right-click context menu handler
            valEl.addEventListener('contextmenu', function(e) {
              e.preventDefault();
              e.stopPropagation();
              showGrossInputModal();
            });
          }
        } else if (isNetLabel(name) && !valEl.getAttribute('data-of-stats-modified')) {
          valEl.textContent = ' $' + formatCurrency(stats.net) + ' ';
          valEl.setAttribute('data-of-stats-modified', 'true');
          nameEl.textContent = getLocalizedNetLabel();
          log('OF Stats: Updated NET to $' + formatCurrency(stats.net));
        }
      }
    });
    
    // 3. Update category values
    // Categories have classes: m-subscriptions, m-tips, m-posts, m-messages, m-referrals, m-calls (streams)
    var categoryMap = {
      'm-subscriptions': 'subscriptions',
      'm-tips': 'tips',
      'm-posts': 'posts',
      'm-messages': 'messages',
      'm-referrals': 'referrals',
      'm-calls': 'streams'  // Streams uses m-calls class
    };
    
    Object.keys(categoryMap).forEach(function(className) {
      var catName = categoryMap[className];
      var catRow = document.querySelector('.b-stats-row__label.' + className);
      log('OF Stats: Looking for .' + className + ', found:', catRow ? 'yes' : 'no');
      if (catRow) {
        var vals = catRow.querySelectorAll('.b-stats-row__val');
        var catData = stats.categories[catName];
        if (catData && vals.length >= 2) {
          // First val is Gross, second is Net
          if (!vals[0].getAttribute('data-of-stats-modified')) {
            vals[0].textContent = ' $' + formatCurrency(catData.gross) + ' ';
            vals[0].setAttribute('data-of-stats-modified', 'true');
          }
          if (!vals[1].getAttribute('data-of-stats-modified')) {
            vals[1].textContent = ' $' + formatCurrency(catData.net) + ' ';
            vals[1].setAttribute('data-of-stats-modified', 'true');
          }
          log('OF Stats: Updated ' + catName + ' - Gross: $' + formatCurrency(catData.gross) + ', Net: $' + formatCurrency(catData.net));
        }
      }
    });
    
    // Mark content container as ready to show values (removes CSS hiding)
    var contentContainer = document.querySelector('.b-stats-row__content');
    if (contentContainer && !contentContainer.getAttribute('data-of-stats-ready')) {
      contentContainer.setAttribute('data-of-stats-ready', 'true');
      log('OF Stats: Marked content container as ready');
    }
    
    // 4. Generate and update monthly data
    applyMonthlyEarnings(stats);
    
    // 5. Update chart with our data
    updateEarningsChart(stats);
    
    // 6. Remove hiding style now that our data is applied
    var hideStatsStyle = document.getElementById('of-stats-hide-stats');
    if (hideStatsStyle) {
      hideStatsStyle.remove();
      log('OF Stats: Removed hide-stats style');
    }
  }
  
  // Update Chart.js chart by injecting script into page context
  // Version to force overlay recreation when code changes
  var CHART_OVERLAY_VERSION = 20;
  
  function updateEarningsChart(stats) {
    var canvas = document.querySelector('.b-chart__wrapper canvas:not([data-of-stats-overlay])');
    if (!canvas) {
      log('OF Stats: No chart canvas found');
      return;
    }
    
    var wrapper = canvas.closest('.b-chart__wrapper');
    
    // Check if overlay already exists and is up to date
    var existingOverlay = wrapper ? wrapper.querySelector('[data-of-stats-overlay]') : null;
    if (existingOverlay) {
      // Check version - recreate if outdated
      var overlayVersion = parseInt(existingOverlay.getAttribute('data-overlay-version') || '0');
      if (overlayVersion >= CHART_OVERLAY_VERSION) {
        log('OF Stats: Chart overlay already exists (v' + overlayVersion + ')');
        return;
      }
      log('OF Stats: Recreating overlay (old v' + overlayVersion + ' -> new v' + CHART_OVERLAY_VERSION + ')');
      existingOverlay.remove();
    }
    
    // Generate chart data
    var chartData = generateChartDataFromMonths(stats);
    
    log('OF Stats: Creating chart overlay...');
    
    // Create overlay canvas to prevent Chart.js from overwriting
    createOverlayChart(canvas, chartData);
  }
  
  // Create overlay canvas on top of original
  function createOverlayChart(originalCanvas, chartData) {
    var wrapper = originalCanvas.closest('.b-chart__wrapper');
    if (!wrapper) {
      log('OF Stats: No chart wrapper found');
      return;
    }
    
    // Remove existing overlay
    var existingOverlay = wrapper.querySelector('[data-of-stats-overlay]');
    if (existingOverlay) {
      existingOverlay.remove();
    }
    
    // Remove existing tooltip
    var existingTooltip = wrapper.querySelector('[data-of-stats-alltime-tooltip]');
    if (existingTooltip) {
      existingTooltip.remove();
    }
    
    // Create overlay canvas - fixed 608x200 like month charts
    var canvas = document.createElement('canvas');
    canvas.width = 608;
    canvas.height = 200;
    canvas.style.cssText = 'position: absolute; top: 0; left: 0; display: block; box-sizing: border-box; width: 608px; height: 200px; z-index: 1;';
    canvas.setAttribute('data-of-stats-overlay', 'true');
    canvas.setAttribute('data-of-stats-alltime-canvas', 'true');
    canvas.setAttribute('data-overlay-version', CHART_OVERLAY_VERSION.toString());
    
    // Make wrapper position relative for absolute positioning, allow overflow for tooltip
    wrapper.style.position = 'relative';
    wrapper.style.overflow = 'visible';
    
    // Hide original canvas by making it invisible
    originalCanvas.style.visibility = 'hidden';
    
    wrapper.appendChild(canvas);
    
    // Create tooltip element with all 6 categories
    var tooltip = document.createElement('div');
    tooltip.className = 'b-chart__tooltip of-stats-tooltip';
    tooltip.setAttribute('data-of-stats-alltime-tooltip', 'true');
    tooltip.style.cssText = 'position: absolute; opacity: 0; left: 0; top: 0; width: 156px; pointer-events: none; z-index: 100;';
    var langTooltip = getPageLanguage();
    tooltip.innerHTML = 
      '<div class="b-chart__tooltip__title"></div>' +
      '<div class="b-chart__tooltip__text" data-cat="subscriptions">' +
        '<div class="b-chart__tooltip__circle" style="background: #2196f3;"></div>' +
        '<div class="b-chart__tooltip__text__title"> ' + (langTooltip === 'ru' ? 'Подписки' : langTooltip === 'es' ? 'Suscripciones' : langTooltip === 'de' ? 'Abonnements' : 'Subscriptions') + ' </div>' +
        '<div class="b-chart__tooltip__text__value"> $0 </div>' +
      '</div>' +
      '<div class="b-chart__tooltip__text" data-cat="tips">' +
        '<div class="b-chart__tooltip__circle" style="background: #00bcd4;"></div>' +
        '<div class="b-chart__tooltip__text__title"> ' + (langTooltip === 'ru' ? 'Чаевые' : langTooltip === 'es' ? 'Propinas' : langTooltip === 'de' ? 'Trinkgelder' : 'Tips') + ' </div>' +
        '<div class="b-chart__tooltip__text__value"> $0 </div>' +
      '</div>' +
      '<div class="b-chart__tooltip__text" data-cat="posts">' +
        '<div class="b-chart__tooltip__circle" style="background: #ec407a;"></div>' +
        '<div class="b-chart__tooltip__text__title"> ' + (langTooltip === 'ru' ? 'Посты' : langTooltip === 'es' ? 'Publicaciones' : langTooltip === 'de' ? 'Beiträge' : 'Posts') + ' </div>' +
        '<div class="b-chart__tooltip__text__value"> $0 </div>' +
      '</div>' +
      '<div class="b-chart__tooltip__text" data-cat="messages">' +
        '<div class="b-chart__tooltip__circle" style="background: #ff7043;"></div>' +
        '<div class="b-chart__tooltip__text__title"> ' + (langTooltip === 'ru' ? 'Сообщения' : langTooltip === 'es' ? 'Mensajes' : langTooltip === 'de' ? 'Nachrichten' : 'Messages') + ' </div>' +
        '<div class="b-chart__tooltip__text__value"> $0 </div>' +
      '</div>' +
      '<div class="b-chart__tooltip__text" data-cat="referrals">' +
        '<div class="b-chart__tooltip__circle" style="background: #9575cd;"></div>' +
        '<div class="b-chart__tooltip__text__title"> ' + (langTooltip === 'ru' ? 'Рефералы' : langTooltip === 'es' ? 'Referidos' : langTooltip === 'de' ? 'Empfehlungen' : 'Referrals') + ' </div>' +
        '<div class="b-chart__tooltip__text__value"> $0 </div>' +
      '</div>' +
      '<div class="b-chart__tooltip__text" data-cat="streams">' +
        '<div class="b-chart__tooltip__circle" style="background: #ffa000;"></div>' +
        '<div class="b-chart__tooltip__text__title"> ' + (langTooltip === 'ru' ? 'Потоки' : langTooltip === 'es' ? 'Transmisiones' : langTooltip === 'de' ? 'Streams' : 'Streams') + ' </div>' +
        '<div class="b-chart__tooltip__text__value"> $0 </div>' +
      '</div>';
    wrapper.appendChild(tooltip);
    
    log('OF Stats: Overlay created, canvas size:', canvas.width, 'x', canvas.height);
    
    // Store chartData on canvas for redraw when switching categories
    canvas._chartData = chartData;
    
    // Store tooltip reference on canvas
    canvas._tooltip = tooltip;
    
    // Add mouse event handlers for tooltip
    setupAllTimeChartTooltip(canvas, wrapper, tooltip, chartData);
    
    // Draw the chart using canvas (same as month charts for consistency)
    drawAllTimeChartCanvas(canvas, chartData);
  }
  
  // Setup mouse events for All time chart tooltip
  function setupAllTimeChartTooltip(canvas, wrapper, tooltip, chartData) {
    var padding = { top: 20, right: 10, bottom: 28, left: 10 };
    var chartWidth = canvas.width - padding.left - padding.right;
    var chartHeight = canvas.height - padding.top - padding.bottom;
    var numPoints = chartData.labels.length;
    var xStep = chartWidth / (numPoints - 1);
    
    // Find max value for Y calculation
    var maxValue = 0;
    var categories = ['subscriptions', 'messages', 'tips', 'posts', 'streams', 'referrals'];
    categories.forEach(function(cat) {
      var data = chartData.datasets[cat];
      if (data && data.length > 0) {
        var catMax = Math.max.apply(null, data);
        if (catMax > maxValue) maxValue = catMax;
      }
    });
    if (maxValue === 0) maxValue = 100;
    maxValue *= 1.15;
    
    var lastHoveredIndex = -1;
    
    // Pre-calculate line points for hit detection
    function getLinePoints(cat) {
      var data = chartData.datasets[cat];
      if (!data || data.length === 0) return [];
      var points = [];
      for (var i = 0; i < data.length; i++) {
        var px = padding.left + i * xStep;
        var py = padding.top + chartHeight * (1 - data[i] / maxValue);
        points.push({ x: px, y: py });
      }
      return points;
    }
    
    // Check if point is near any line
    function isNearLine(x, y, threshold) {
      var checkCategories = ['subscriptions', 'messages', 'tips'];
      for (var c = 0; c < checkCategories.length; c++) {
        var cat = checkCategories[c];
        var points = getLinePoints(cat);
        for (var i = 0; i < points.length - 1; i++) {
          var p1 = points[i];
          var p2 = points[i + 1];
          // Distance from point to line segment
          var dx = p2.x - p1.x;
          var dy = p2.y - p1.y;
          var lengthSq = dx * dx + dy * dy;
          var t = Math.max(0, Math.min(1, ((x - p1.x) * dx + (y - p1.y) * dy) / lengthSq));
          var nearX = p1.x + t * dx;
          var nearY = p1.y + t * dy;
          var dist = Math.sqrt((x - nearX) * (x - nearX) + (y - nearY) * (y - nearY));
          if (dist < threshold) return true;
        }
      }
      return false;
    }
    
    canvas.addEventListener('mousemove', function(e) {
      var rect = canvas.getBoundingClientRect();
      var scaleX = canvas.width / rect.width;
      var scaleY = canvas.height / rect.height;
      var x = (e.clientX - rect.left) * scaleX;
      var y = (e.clientY - rect.top) * scaleY;
      
      // Check if mouse is in chart area
      if (x < padding.left || x > canvas.width - padding.right ||
          y < padding.top || y > canvas.height - padding.bottom) {
        if (lastHoveredIndex !== -1) {
          lastHoveredIndex = -1;
          tooltip.style.opacity = '0';
          redrawAllTimeChartWithPoint(canvas, chartData, -1);
        }
        return;
      }
      
      // Check if cursor is near any line (within 15px)
      if (!isNearLine(x, y, 15)) {
        if (lastHoveredIndex !== -1) {
          lastHoveredIndex = -1;
          tooltip.style.opacity = '0';
          redrawAllTimeChartWithPoint(canvas, chartData, -1);
        }
        return;
      }
      
      // Calculate nearest data point index
      var relativeX = x - padding.left;
      var index = Math.round(relativeX / xStep);
      index = Math.max(0, Math.min(index, numPoints - 1));
      
      if (index !== lastHoveredIndex) {
        lastHoveredIndex = index;
        
        // Apply dark mode class
        if (isDarkMode()) {
          tooltip.classList.add('dark-mode');
        } else {
          tooltip.classList.remove('dark-mode');
        }
        
        // Update tooltip content
        var titleEl = tooltip.querySelector('.b-chart__tooltip__title');
        if (titleEl) {
          titleEl.textContent = ' ' + chartData.labels[index] + ' ';
        }
        
        // Update each category value - show cumulative value with cents
        categories.forEach(function(cat) {
          var catRow = tooltip.querySelector('[data-cat="' + cat + '"]');
          if (catRow) {
            var valueEl = catRow.querySelector('.b-chart__tooltip__text__value');
            if (valueEl) {
              var currentValue = chartData.datasets[cat][index] || 0;
              // Format with commas and 2 decimal places
              var formatted = currentValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              valueEl.textContent = ' $' + formatted + ' ';
            }
          }
        });
        
        // Calculate tooltip position
        var pointX = padding.left + index * xStep;
        
        // Position tooltip relative to Tips line (center line)
        var tipsValue = chartData.datasets['tips'][index] || 0;
        var pointY = padding.top + chartHeight * (1 - tipsValue / maxValue);
        
        // Position tooltip - to the right of the Tips point, vertically centered
        var tooltipWidth = 156;
        var tooltipHeight = 160; // Approximate tooltip height
        var tooltipX = pointX / scaleX + 15; // РЎРїСЂР°РІР° РѕС‚ С‚РѕС‡РєРё
        var tooltipY = pointY / scaleX - tooltipHeight / 2; // РџРѕ С†РµРЅС‚СЂСѓ РѕС‚ С‚РѕС‡РєРё Tips
        
        // Only flip to left if not enough space on right
        if (tooltipX + tooltipWidth > rect.width) {
          tooltipX = pointX / scaleX - tooltipWidth - 15;
        }
        // No vertical bounds checking - allow tooltip to go outside canvas
        
        tooltip.style.left = tooltipX + 'px';
        tooltip.style.top = tooltipY + 'px';
        tooltip.style.opacity = '1';
        
        // Redraw chart with highlighted point
        redrawAllTimeChartWithPoint(canvas, chartData, index);
      }
    });
    
    canvas.addEventListener('mouseleave', function() {
      lastHoveredIndex = -1;
      tooltip.style.opacity = '0';
      redrawAllTimeChartWithPoint(canvas, chartData, -1);
    });
  }
  
  // Redraw All time chart with highlighted point (no animation)
  function redrawAllTimeChartWithPoint(canvas, chartData, highlightIndex) {
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    var width = canvas.width;
    var height = canvas.height;
    
    var colors = {
      subscriptions: '#2196f3',
      messages: '#ff7043',
      tips: '#00bcd4',
      posts: '#ec407a',
      streams: '#ffa000',
      referrals: '#9575cd'
    };
    
    var padding = { top: 20, right: 10, bottom: 28, left: 10 };
    var chartWidth = width - padding.left - padding.right;
    var chartHeight = height - padding.top - padding.bottom;
    
    // Find max value
    var maxValue = 0;
    var categories = ['subscriptions', 'messages', 'tips', 'posts', 'streams', 'referrals'];
    categories.forEach(function(cat) {
      var data = chartData.datasets[cat];
      if (data && data.length > 0) {
        var catMax = Math.max.apply(null, data);
        if (catMax > maxValue) maxValue = catMax;
      }
    });
    if (maxValue === 0) maxValue = 100;
    maxValue *= 1.15;
    
    var numPoints = chartData.labels.length;
    var xStep = chartWidth / (numPoints - 1);
    
    var activeCategory = canvas.getAttribute('data-active-category') || 'subscriptions';
    
    var drawOrder = ['tips', 'messages', 'posts', 'streams', 'referrals', 'subscriptions'];
    drawOrder = drawOrder.filter(function(c) { return c !== activeCategory; });
    drawOrder.push(activeCategory);
    
    // Clear canvas
    ctx.clearRect(0, 0, width, height);
    
    // Draw grid lines
    ctx.strokeStyle = getChartGridColor();
    ctx.lineWidth = 1;
    for (var i = 0; i < 4; i++) {
      var gridY = padding.top + (chartHeight * i / 3);
      ctx.beginPath();
      ctx.moveTo(padding.left, gridY);
      ctx.lineTo(width - padding.right, gridY);
      ctx.stroke();
    }
    
    // Draw lines
    drawOrder.forEach(function(cat) {
      var data = chartData.datasets[cat];
      if (!data || data.length === 0) return;
      
      var points = [];
      for (var i = 0; i < data.length; i++) {
        var x = padding.left + i * xStep;
        var y = padding.top + chartHeight * (1 - data[i] / maxValue);
        points.push({ x: x, y: y });
      }
      
      var isMain = cat === activeCategory;
      
      ctx.beginPath();
      ctx.strokeStyle = colors[cat];
      ctx.lineWidth = isMain ? 1.8 : 2.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalAlpha = isMain ? 1 : 0.25;
      
      ctx.moveTo(points[0].x, points[0].y);
      for (var i = 0; i < points.length - 1; i++) {
        var p0 = points[i === 0 ? i : i - 1];
        var p1 = points[i];
        var p2 = points[i + 1];
        var p3 = points[i + 2 < points.length ? i + 2 : i + 1];
        var tension = 0.35;
        
        var cp1x = p1.x + (p2.x - p0.x) * tension;
        var cp1y = p1.y + (p2.y - p0.y) * tension;
        var cp2x = p2.x - (p3.x - p1.x) * tension;
        var cp2y = p2.y - (p3.y - p1.y) * tension;
        
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
      }
      ctx.stroke();
      
      // Draw points at highlighted index for subscriptions, messages, tips
      var showPointCategories = ['subscriptions', 'messages', 'tips'];
      if (showPointCategories.indexOf(cat) !== -1 && highlightIndex >= 0 && highlightIndex < points.length) {
        var p = points[highlightIndex];
        ctx.globalAlpha = 1;
        
        // White outer circle
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        
        // Colored inner circle
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = colors[cat];
        ctx.fill();
      }
    });
    ctx.globalAlpha = 1;
    
    // Draw X-axis labels
    ctx.fillStyle = getChartLabelColor();
    ctx.font = getChartDateFont();
    ctx.textBaseline = 'top';
    var labelY = chartHeight + padding.top + 15;
    
    var labelIndices = [0, Math.floor(numPoints * 0.25), Math.floor(numPoints * 0.5), Math.floor(numPoints * 0.75), numPoints - 1];
    var labelsToUse = canvas._fixedDateLabels || chartData.labels;
    var positions = canvas._fixedDatePositions;
    
    if (positions && labelsToUse) {
      labelIndices.forEach(function(idx, i) {
        var label = labelsToUse[i] || chartData.labels[idx] || '';
        var x = positions[i];
        if (i === 4) {
          ctx.textAlign = 'right';
        } else {
          ctx.textAlign = 'left';
        }
        ctx.fillText(label, x, labelY);
      });
    }
  }
  
  // Draw All time chart using canvas (same style as month charts)
  function drawAllTimeChartCanvas(canvas, chartData) {
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    var width = canvas.width;
    var height = canvas.height;
    
    // Chart colors - same as month charts
    var colors = {
      subscriptions: '#2196f3', // Blue - main line
      messages: '#ff7043',
      tips: '#00bcd4',
      posts: '#ec407a',
      streams: '#ffa000',
      referrals: '#9575cd'     // Purple
    };
    
    // Padding - top:10 for spacing from header, bottom for X-axis labels
    var padding = { top: 20, right: 10, bottom: 28, left: 10 };
    var chartWidth = width - padding.left - padding.right;
    var chartHeight = height - padding.top - padding.bottom;
    
    // Find max value from full data
    var maxValue = 0;
    var categories = ['subscriptions', 'messages', 'tips', 'posts', 'streams', 'referrals'];
    categories.forEach(function(cat) {
      var data = chartData.datasets[cat];
      if (data && data.length > 0) {
        var catMax = Math.max.apply(null, data);
        if (catMax > maxValue) maxValue = catMax;
      }
    });
    if (maxValue === 0) maxValue = 100;
    maxValue *= 1.15; // 15% grace like Chart.js - data won't touch top grid line
    
    var numPoints = chartData.labels.length;
    var xStep = chartWidth / (numPoints - 1);
    
    // Get active category - determines which line is bold
    var activeCategory = canvas.getAttribute('data-active-category') || 'subscriptions';
    
    // Prepare line data - active category LAST so it draws on top
    var drawOrder = ['tips', 'messages', 'posts', 'streams', 'referrals', 'subscriptions'];
    // Reorder: move active category to end so it draws on top
    drawOrder = drawOrder.filter(function(c) { return c !== activeCategory; });
    drawOrder.push(activeCategory);
    
    var linesToDraw = [];
    
    drawOrder.forEach(function(cat) {
      var data = chartData.datasets[cat];
      if (!data || data.length === 0) return;
      
      var points = [];
      for (var i = 0; i < data.length; i++) {
        var x = padding.left + i * xStep;
        var y = padding.top + chartHeight * (1 - data[i] / maxValue);
        points.push({ x: x, y: y });
      }
      
      // Active category line is slightly thicker and opaque, others thicker but very transparent
      var isMain = cat === activeCategory;
      linesToDraw.push({
        points: points,
        color: colors[cat],
        lineWidth: isMain ? 1.8 : 2.5,
        alpha: isMain ? 1 : 0.25
      });
    });
    
    // Animation variables - vertical grow like Chart.js
    var animationDuration = 800;
    var startTime = null;
    
    function easeOutQuart(t) {
      return 1 - Math.pow(1 - t, 4);
    }
    
    // Calculate baseline Y (bottom of chart)
    var baselineY = padding.top + chartHeight;
    
    function animate(currentTime) {
      if (!startTime) startTime = currentTime;
      var elapsed = currentTime - startTime;
      var progress = Math.min(elapsed / animationDuration, 1);
      var easedProgress = easeOutQuart(progress);
      
      // Clear canvas
      ctx.clearRect(0, 0, width, height);
      
      // Draw grid lines (4 horizontal lines - matches All time Chart.js with maxTicksLimit:4)
      // 4 ticks = 4 lines dividing into 3 intervals: top line, 2 middle lines, bottom line
      ctx.strokeStyle = getChartGridColor();
      ctx.lineWidth = 1;
      for (var i = 0; i < 4; i++) {
        var gridY = padding.top + (chartHeight * i / 3);
        ctx.beginPath();
        ctx.moveTo(padding.left, gridY);
        ctx.lineTo(width - padding.right, gridY);
        ctx.stroke();
      }
      
      // Draw animated lines - vertical grow from baseline
      linesToDraw.forEach(function(line) {
        ctx.beginPath();
        ctx.strokeStyle = line.color;
        ctx.lineWidth = line.lineWidth;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.globalAlpha = line.alpha;
        
        // Calculate animated points (grow vertically from baseline)
        var animatedPoints = line.points.map(function(p) {
          var animatedY = baselineY + (p.y - baselineY) * easedProgress;
          return { x: p.x, y: animatedY };
        });
        
        ctx.moveTo(animatedPoints[0].x, animatedPoints[0].y);
        for (var i = 0; i < animatedPoints.length - 1; i++) {
          var p0 = animatedPoints[i === 0 ? i : i - 1];
          var p1 = animatedPoints[i];
          var p2 = animatedPoints[i + 1];
          var p3 = animatedPoints[i + 2 < animatedPoints.length ? i + 2 : i + 1];
          var tension = 0.35;
          var cp1x = p1.x + (p2.x - p0.x) * tension;
          var cp1y = p1.y + (p2.y - p0.y) * tension;
          var cp2x = p2.x - (p3.x - p1.x) * tension;
          var cp2y = p2.y - (p3.y - p1.y) * tension;
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      });
      
      // Draw X-axis labels - theme-aware color, 5 evenly spaced
      ctx.globalAlpha = easedProgress;
      ctx.fillStyle = getChartLabelColor();
      ctx.font = getChartDateFont();
      ctx.textBaseline = 'top';
      
      // Position: bottom of chart area + padding
      var labelY = chartHeight + padding.top + 15;
      
      // 5 label positions
      var labelIndices = [0, Math.floor(numPoints * 0.25), Math.floor(numPoints * 0.5), Math.floor(numPoints * 0.75), numPoints - 1];
      
      // === РќРђРЎРўР РћР™РљРђ ===
      var minLeftPosition = 67;
      
      var labelData = labelIndices.map(function(idx, i) {
        var label = chartData.labels[idx] || '';
        var dataPointX = padding.left + idx * xStep;
        var labelWidth = ctx.measureText(label).width;
        return { label: label, dataPointX: dataPointX, width: labelWidth, index: i };
      });
      
      var positions;
      if (canvas._fixedDatePositions) {
        positions = canvas._fixedDatePositions;
      } else {
        positions = new Array(5);
        var lastLabelLeft = (width - padding.right) - labelData[4].width;
        var labelSpace = (lastLabelLeft - minLeftPosition) / 4;
        for (var i = 0; i < 4; i++) {
          positions[i] = minLeftPosition + labelSpace * i;
        }
        positions[4] = width - padding.right;
        
        canvas._fixedDatePositions = positions.slice();
        canvas._fixedDateLabels = labelData.map(function(ld) { return ld.label; });
      }
      
      var labelsToUse = canvas._fixedDateLabels || labelData.map(function(ld) { return ld.label; });
      labelsToUse.forEach(function(label, i) {
        var x = positions[i];
        ctx.textAlign = (i === 4) ? 'right' : 'left';
        ctx.fillText(label, x, labelY);
      });
      ctx.globalAlpha = 1;
      
      // Continue animation
      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    }
    
    // Start animation
    requestAnimationFrame(animate);
  }

  // Draw All time chart without animation (for category switching)
  function drawAllTimeChartCanvasNoAnimation(canvas, chartData) {
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    var width = canvas.width;
    var height = canvas.height;
    
    // Chart colors
    var colors = {
      subscriptions: '#2196f3',
      messages: '#ff7043',
      tips: '#00bcd4',
      posts: '#ec407a',
      streams: '#ffa000',
      referrals: '#9575cd'
    };
    
    var padding = { top: 20, right: 10, bottom: 28, left: 10 };
    var chartWidth = width - padding.left - padding.right;
    var chartHeight = height - padding.top - padding.bottom;
    
    // Find max value
    var maxValue = 0;
    var categories = ['subscriptions', 'messages', 'tips', 'posts', 'streams', 'referrals'];
    categories.forEach(function(cat) {
      var data = chartData.datasets[cat];
      if (data && data.length > 0) {
        var catMax = Math.max.apply(null, data);
        if (catMax > maxValue) maxValue = catMax;
      }
    });
    if (maxValue === 0) maxValue = 100;
    maxValue *= 1.15;
    
    var numPoints = chartData.labels.length;
    var xStep = chartWidth / (numPoints - 1);
    
    // Get active category
    var activeCategory = canvas.getAttribute('data-active-category') || 'subscriptions';
    
    // Prepare line data
    var drawOrder = ['tips', 'messages', 'posts', 'streams', 'referrals', 'subscriptions'];
    drawOrder = drawOrder.filter(function(c) { return c !== activeCategory; });
    drawOrder.push(activeCategory);
    
    // Clear canvas
    ctx.clearRect(0, 0, width, height);
    
    // Draw grid lines
    ctx.strokeStyle = getChartGridColor();
    ctx.lineWidth = 1;
    for (var i = 0; i < 4; i++) {
      var gridY = padding.top + (chartHeight * i / 3);
      ctx.beginPath();
      ctx.moveTo(padding.left, gridY);
      ctx.lineTo(width - padding.right, gridY);
      ctx.stroke();
    }
    
    // Draw lines (no animation)
    drawOrder.forEach(function(cat) {
      var data = chartData.datasets[cat];
      if (!data || data.length === 0) return;
      
      var points = [];
      for (var i = 0; i < data.length; i++) {
        var x = padding.left + i * xStep;
        var y = padding.top + chartHeight * (1 - data[i] / maxValue);
        points.push({ x: x, y: y });
      }
      
      var isMain = cat === activeCategory;
      
      ctx.beginPath();
      ctx.strokeStyle = colors[cat];
      ctx.lineWidth = isMain ? 1.8 : 2.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalAlpha = isMain ? 1 : 0.25;
      
      ctx.moveTo(points[0].x, points[0].y);
      for (var i = 0; i < points.length - 1; i++) {
        var p0 = points[i === 0 ? i : i - 1];
        var p1 = points[i];
        var p2 = points[i + 1];
        var p3 = points[i + 2 < points.length ? i + 2 : i + 1];
        var tension = 0.35;
        
        var cp1x = p1.x + (p2.x - p0.x) * tension;
        var cp1y = p1.y + (p2.y - p0.y) * tension;
        var cp2x = p2.x - (p3.x - p1.x) * tension;
        var cp2y = p2.y - (p3.y - p1.y) * tension;
        
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
      }
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    
    // Draw X-axis labels - theme-aware color, 5 evenly spaced
    ctx.globalAlpha = 1;
    ctx.fillStyle = getChartLabelColor();
    ctx.font = getChartDateFont();
    ctx.textBaseline = 'top';
    var labelY = chartHeight + padding.top + 15;
    
    var labelIndices = [0, Math.floor(numPoints * 0.25), Math.floor(numPoints * 0.5), Math.floor(numPoints * 0.75), numPoints - 1];
    
    // === РќРђРЎРўР РћР™РљРђ ===
    var minLeftPosition = 67;
    
    var labelData = labelIndices.map(function(idx, i) {
      var label = chartData.labels[idx] || '';
      var dataPointX = padding.left + idx * xStep;
      var labelWidth = ctx.measureText(label).width;
      return { label: label, dataPointX: dataPointX, width: labelWidth, index: i };
    });
    
    var positions;
    if (canvas._fixedDatePositions) {
      positions = canvas._fixedDatePositions;
    } else {
      positions = new Array(5);
      var lastLabelLeft = (width - padding.right) - labelData[4].width;
      var labelSpace = (lastLabelLeft - minLeftPosition) / 4;
      for (var i = 0; i < 4; i++) {
        positions[i] = minLeftPosition + labelSpace * i;
      }
      positions[4] = width - padding.right;
      
      canvas._fixedDatePositions = positions.slice();
      canvas._fixedDateLabels = labelData.map(function(ld) { return ld.label; });
    }
    
    var labelsToUse = canvas._fixedDateLabels || labelData.map(function(ld) { return ld.label; });
    labelsToUse.forEach(function(label, i) {
      var x = positions[i];
      ctx.textAlign = (i === 4) ? 'right' : 'left';
      ctx.fillText(label, x, labelY);
    });
  }

  
  
  
  // Generate chart data from monthly stats - creates cumulative growth chart
  function generateChartDataFromMonths(stats) {
    var labels = [];
    var dates = []; // ISO date strings for Chart.js time axis
    var datasets = {
      subscriptions: [],
      tips: [],
      posts: [],
      messages: [],
      referrals: [],
      streams: []
    };
    
    // Use existing months if available, otherwise generate new ones
    var months = stats.months;
    if (!months || months.length === 0) {
      months = generateMonthlyEarnings(stats.net);
      stats.months = months;
      saveEarningStats(stats); // Save newly generated months
    }
    
    // Sort months from oldest to newest
    var sortedMonths = months.slice().sort(function(a, b) {
      return new Date(a.year, a.month) - new Date(b.year, b.month);
    });
    
    // Generate cumulative data points from each month's categories
    var cumulative = {
      subscriptions: 0,
      tips: 0,
      posts: 0,
      messages: 0,
      referrals: 0,
      streams: 0
    };
    
    var langChart2 = getPageLanguage();
    var monthNamesShort = langChart2 === 'ru' ? ['янв.', 'февр.', 'март', 'апр.', 'май', 'июнь', 'июль', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.']
      : langChart2 === 'es' ? ['ene.', 'feb.', 'mar.', 'abr.', 'may.', 'jun.', 'jul.', 'ago.', 'sep.', 'oct.', 'nov.', 'dic.']
      : langChart2 === 'de' ? ['Jan.', 'Feb.', 'Mär.', 'Apr.', 'Mai', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.']
      : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    // Add data points for every other month (skip 1 month between points)
    sortedMonths.forEach(function(monthData, index) {
      // Skip odd indices to show every other month
      if (index % 2 !== 0 && index !== sortedMonths.length - 1) {
        // Still accumulate data for skipped months
        var monthCategories = monthData.categories;
        if (monthCategories) {
          Object.keys(cumulative).forEach(function(cat) {
            cumulative[cat] += monthCategories[cat] || 0;
          });
        } else {
          var catTotals = stats.categories;
          var totalNet = stats.net || 1;
          var monthNet = monthData.net;
          Object.keys(cumulative).forEach(function(cat) {
            var proportion = catTotals[cat] ? catTotals[cat].net / totalNet : 0;
            cumulative[cat] += monthNet * proportion;
          });
        }
        return; // Skip adding point but keep accumulating
      }
      
      // Create consistent day per month (1-28 range)
      var daysInMonth = new Date(monthData.year, monthData.month + 1, 0).getDate();
      var dayOffset = (monthData.month * 13 + monthData.year * 7) % 22;
      var day = 1 + dayOffset;
      if (day > daysInMonth) day = Math.floor(daysInMonth / 2);
      
      // ISO date string for Chart.js (YYYY-MM-DD)
      var monthNum = (monthData.month + 1).toString().padStart(2, '0');
      var dayStr = day.toString().padStart(2, '0');
      var isoDate = monthData.year + '-' + monthNum + '-' + dayStr;
      dates.push(isoDate);
      
      // Human readable label
      var monthStr = monthNamesShort[monthData.month];
      var yearStr = monthData.year.toString().slice(-2);
      var label = day + ' ' + monthStr + ' ' + yearStr;
      labels.push(label);
      
      // Use month's own category breakdown if available
      var monthCategories = monthData.categories;
      
      if (monthCategories) {
        // Add this month's categories to cumulative totals
        Object.keys(cumulative).forEach(function(cat) {
          cumulative[cat] += monthCategories[cat] || 0;
          datasets[cat].push(Math.round(cumulative[cat] * 100) / 100);
        });
      } else {
        // Fallback: distribute month net using total proportions
        var catTotals = stats.categories;
        var totalNet = stats.net || 1;
        var monthNet = monthData.net;
        
        Object.keys(cumulative).forEach(function(cat) {
          var proportion = catTotals[cat] ? catTotals[cat].net / totalNet : 0;
          cumulative[cat] += monthNet * proportion;
          datasets[cat].push(Math.round(cumulative[cat] * 100) / 100);
        });
      }
    });
    
    log('OF Stats: Generated chart data - ' + labels.length + ' points (every other month), dates:', dates.slice(0, 3), '...', dates.slice(-1));
    
    // Normalize datasets so last point equals actual Gross values from stats.categories
    if (stats.categories) {
      Object.keys(datasets).forEach(function(cat) {
        var data = datasets[cat];
        if (data.length > 0) {
          var lastValue = data[data.length - 1];
          var targetGross = stats.categories[cat] ? (stats.categories[cat].gross || stats.categories[cat].net || 0) : 0;
          
          if (lastValue > 0 && targetGross > 0) {
            // Scale all values proportionally so last value equals targetGross
            var scaleFactor = targetGross / lastValue;
            for (var i = 0; i < data.length; i++) {
              data[i] = Math.round(data[i] * scaleFactor * 100) / 100;
            }
          } else if (targetGross > 0) {
            // If lastValue is 0 but we have a target, set last point to target
            data[data.length - 1] = targetGross;
          } else {
            // If target is 0, ensure all values are 0
            for (var i = 0; i < data.length; i++) {
              data[i] = 0;
            }
          }
        }
      });
      log('OF Stats: Normalized chart data to match Gross values');
    }
    
    return {
      labels: labels,
      dates: dates,
      datasets: datasets
    };
  }
  
  // Get current balance + pending from cached settings
  function getMinimumCurrentMonthEarning() {
    var currentBalance = 0;
    var pendingBalance = 0;
    
    if (cachedSettings) {
      // Parse current balance
      if (cachedSettings.currentBalance) {
        currentBalance = parseFloat(cachedSettings.currentBalance.toString().replace(/[$,]/g, '')) || 0;
      }
      // Parse pending balance
      if (cachedSettings.pendingBalance) {
        pendingBalance = parseFloat(cachedSettings.pendingBalance.toString().replace(/[$,]/g, '')) || 0;
      }
    }
    
    return currentBalance + pendingBalance;
  }
  
  // Generate monthly earnings data
  // Optional oldestMonthData: {year, month} - if provided, generates months starting from current month to this oldest month
  function generateMonthlyEarnings(totalNet, oldestMonthData) {
    var months = [];
    var now = new Date();
    var currentYear = now.getFullYear();
    var currentMonth = now.getMonth(); // 0-11
    
    // Get minimum for current month (Current + Pending balance)
    var minCurrentMonth = getMinimumCurrentMonthEarning();
    
    // If oldest month is provided (from preset), calculate exact number of months
    var numMonths;
    if (oldestMonthData && oldestMonthData.year && typeof oldestMonthData.month === 'number') {
      // Calculate months between current month and oldest month
      var oldestDate = new Date(oldestMonthData.year, oldestMonthData.month, 1);
      var currentDate = new Date(currentYear, currentMonth, 1);
      numMonths = (currentYear - oldestMonthData.year) * 12 + (currentMonth - oldestMonthData.month) + 1;
      numMonths = Math.max(numMonths, 1); // At least 1 month
      log('OF Stats: Generating ' + numMonths + ' months to match preset oldest month (' + oldestMonthData.year + '-' + (oldestMonthData.month + 1) + ')');
    } else {
      // Determine how many months based on total amount - MORE MONTHS
      // Small amounts ($0-$10k): 15-25 months
      // Medium amounts ($10k-$50k): 25-40 months
      // Large amounts ($50k-$100k): 35-50 months
      // Huge amounts ($100k+): 40-60 months
      if (totalNet < 10000) {
        numMonths = 15 + Math.floor(Math.random() * 11);
      } else if (totalNet < 50000) {
        numMonths = 25 + Math.floor(Math.random() * 16);
      } else if (totalNet < 100000) {
        numMonths = 35 + Math.floor(Math.random() * 16);
      } else {
        numMonths = 40 + Math.floor(Math.random() * 21);
      }
    }
    
    // Choose a growth pattern randomly
    // 1: Consistent growth (40%)
    // 2: Peak in middle then decline (25%)
    // 3: Slow start then rapid growth (20%)
    // 4: Plateau after growth (15%)
    var patternRand = Math.random();
    var growthPattern;
    if (patternRand < 0.40) {
      growthPattern = 'consistent';
    } else if (patternRand < 0.65) {
      growthPattern = 'peak-middle';
    } else if (patternRand < 0.85) {
      growthPattern = 'rapid-late';
    } else {
      growthPattern = 'plateau';
    }
    
    // Generate growth curve - start small, grow gradually
    // Using exponential growth from past to present
    var weights = [];
    var totalWeight = 0;
    
    for (var i = 0; i < numMonths; i++) {
      // i=0 is current month, i=numMonths-1 is oldest
      var monthsFromStart = i; // 0 for current, numMonths-1 for oldest
      var progressRatio = (numMonths - 1 - monthsFromStart) / (numMonths - 1); // 0 for oldest, 1 for newest
      
      var baseGrowthFactor;
      
      // Apply different growth patterns
      if (growthPattern === 'consistent') {
        // Consistent growth from small to large
        baseGrowthFactor = Math.pow(progressRatio, 2.2);
        
      } else if (growthPattern === 'peak-middle') {
        // Peak around 60-70% of career, then slight decline
        var peakPoint = 0.65 + Math.random() * 0.1; // 65-75%
        if (progressRatio < peakPoint) {
          baseGrowthFactor = Math.pow(progressRatio / peakPoint, 1.8);
        } else {
          var declineRatio = (1 - progressRatio) / (1 - peakPoint);
          baseGrowthFactor = 1 - (declineRatio * 0.3); // 30% decline after peak
        }
        
      } else if (growthPattern === 'rapid-late') {
        // Slow start, then rapid growth in last 30%
        if (progressRatio < 0.7) {
          baseGrowthFactor = Math.pow(progressRatio, 3.5) * 0.4;
        } else {
          baseGrowthFactor = Math.pow((progressRatio - 0.7) / 0.3, 1.5) * 0.6 + 0.4;
        }
        
      } else { // plateau
        // Growth then plateau at 70-90%
        var plateauStart = 0.7 + Math.random() * 0.2;
        if (progressRatio < plateauStart) {
          baseGrowthFactor = Math.pow(progressRatio / plateauStart, 2.0);
        } else {
          baseGrowthFactor = 0.9 + Math.random() * 0.2; // Plateau with slight variation
        }
      }
      
      // Smooth randomization (85-115% for most, bigger for very early months)
      var randomFluctuation;
      if (monthsFromStart > numMonths - 5) {
        // First 5 months can have bigger variation (60-140%)
        randomFluctuation = 0.6 + Math.random() * 0.8;
      } else {
        // Later months: smoother (85-115%)
        randomFluctuation = 0.85 + Math.random() * 0.3;
      }
      
      // Very rare special events (5% chance, not 2x but 1.4x or 0.7x)
      var specialEvent = Math.random();
      if (specialEvent < 0.025 && monthsFromStart < numMonths - 8) {
        randomFluctuation *= 1.4; // Good month (+40%)
      } else if (specialEvent < 0.05 && monthsFromStart < numMonths - 8) {
        randomFluctuation *= 0.7; // Bad month (-30%)
      }
      
      // Force very early months to be tiny
      if (monthsFromStart > numMonths - 4) {
        baseGrowthFactor *= 0.03; // First 4 months extremely small
      } else if (monthsFromStart > numMonths - 8) {
        baseGrowthFactor *= 0.12; // Months 5-8 still very small
      }
      
      var weight = Math.max(0.005, baseGrowthFactor * randomFluctuation);
      
      weights.push(weight);
      totalWeight += weight;
    }
    
    // Distribute total net across months based on weights
    for (var i = 0; i < numMonths; i++) {
      var monthDate = new Date(currentYear, currentMonth - i, 1);
      var monthValue = (totalNet * weights[i] / totalWeight);
      
      // Current month: ensure MORE than minCurrentMonth (add 10-50% buffer)
      if (i === 0 && minCurrentMonth > 0) {
        var minWithBuffer = minCurrentMonth * (1.1 + Math.random() * 0.4); // 110-150% of min
        monthValue = Math.max(monthValue, minWithBuffer);
      }
      
      // Add extra randomness variation (90-110% for current month, 80-120% for others)
      if (i === 0) {
        monthValue *= (0.95 + Math.random() * 0.15); // Less variation for current month
      } else {
        monthValue *= (0.8 + Math.random() * 0.4);
      }
      
      // For very early months (oldest), cap at $1000
      var monthsFromStart = numMonths - 1 - i;
      if (monthsFromStart < 3) {
        monthValue = Math.min(monthValue, 300 + Math.random() * 700); // $300-$1000
      } else if (monthsFromStart < 6) {
        monthValue = Math.min(monthValue, 800 + Math.random() * 1200); // $800-$2000
      }
      
      // Ensure minimum value for each month (very small for early months)
      monthValue = Math.max(monthValue, 50 + Math.random() * 100);
      
      // Generate category breakdown for this month
      var monthCategories = generateMonthCategoryBreakdown(monthValue);
      
      months.push({
        date: monthDate,
        year: monthDate.getFullYear(),
        month: monthDate.getMonth(),
        net: monthValue,
        categories: monthCategories
      });
    }
    
    // Normalize to match total net exactly
    var generatedTotal = months.reduce(function(sum, m) { return sum + m.net; }, 0);
    var adjustFactor = totalNet / generatedTotal;
    months.forEach(function(m) {
      m.net *= adjustFactor;
      // Also adjust categories
      Object.keys(m.categories).forEach(function(cat) {
        m.categories[cat] *= adjustFactor;
      });
    });
    
    // IMPORTANT: After normalization, ensure current month (index 0) is MORE than minCurrentMonth
    // This prevents Current Balance from being higher than current month earnings
    // Add 10-50% buffer to make it look natural
    var minWithBuffer = minCurrentMonth * (1.1 + Math.random() * 0.4); // 110-150% of min
    if (minCurrentMonth > 0 && months.length > 0 && months[0].net < minWithBuffer) {
      log('OF Stats: Current month after normalization ($' + months[0].net.toFixed(2) + ') < minRequired with buffer ($' + minWithBuffer.toFixed(2) + '), adjusting...');
      
      // Set to the buffered minimum
      var newNet = minWithBuffer;
      
      // Redistribute the deficit across categories proportionally
      var catTotal = 0;
      Object.keys(months[0].categories).forEach(function(cat) {
        catTotal += months[0].categories[cat];
      });
      
      if (catTotal > 0) {
        // Scale categories to match new net value
        var catScale = newNet / catTotal;
        Object.keys(months[0].categories).forEach(function(cat) {
          months[0].categories[cat] *= catScale;
        });
      } else {
        // If no categories had values, distribute to messages (main category)
        months[0].categories.messages = newNet * 0.75;
        months[0].categories.tips = newNet * 0.22;
        months[0].categories.posts = newNet * 0.03;
      }
      
      months[0].net = newNet;
      log('OF Stats: Adjusted current month to $' + months[0].net.toFixed(2));
    }
    
    log('OF Stats: Generated ' + numMonths + ' months, minCurrentMonth: $' + minCurrentMonth.toFixed(2));
    return months;
  }
  
  // Generate category breakdown for a single month
  function generateMonthCategoryBreakdown(monthNet) {
    // Distribution: Messages ~75%, Tips ~22%, Posts ~3%
    // Subscriptions: always $0.00
    // Streams: always $0.00
    // Referrals: always $0.00
    
    var messagesShare = 0.70 + Math.random() * 0.10;  // 70-80%
    var postsShare = 0.02 + Math.random() * 0.02;     // 2-4%
    var tipsShare = 1 - messagesShare - postsShare;   // rest (~16-28%)
    
    return {
      subscriptions: 0,
      tips: tipsShare * monthNet,
      posts: postsShare * monthNet,
      messages: messagesShare * monthNet,
      referrals: 0,
      streams: 0
    };
  }
  
  // Month names for display
  var monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                    'July', 'August', 'September', 'October', 'November', 'December'];
  
  // Create a month row HTML element with expandable content
  function createMonthRowElement(monthData) {
    var lang = getPageLanguage();
    var monthName = lang === 'ru' ? monthNamesEarlyRu[monthData.month] : lang === 'es' ? monthNamesEarlyEs[monthData.month] : lang === 'de' ? monthNamesEarlyDe[monthData.month] : monthNames[monthData.month];
    var monthNameShort = lang === 'ru' ? monthNamesShortRu[monthData.month] : lang === 'es' ? monthNamesShortEs[monthData.month] : lang === 'de' ? monthNamesShortDe[monthData.month] : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][monthData.month];
    var yearStr = monthData.year.toString();
    var netValue = monthData.net;
    var netStr = formatCurrency(netValue);
    
    // Calculate gross from net (net is ~80% of gross)
    var grossValue = netValue / 0.8;
    var grossStr = formatCurrency(grossValue);
    
    // Get category data
    var categories = monthData.categories || {};
    var subsNet = categories.subscriptions || 0;
    var tipsNet = categories.tips || 0;
    var postsNet = categories.posts || 0;
    var messagesNet = categories.messages || 0;
    var referralsNet = categories.referrals || 0;
    var streamsNet = categories.streams || 0;
    
    // Calculate gross for each category
    var subsGross = subsNet / 0.8;
    var tipsGross = tipsNet / 0.8;
    var postsGross = postsNet / 0.8;
    var messagesGross = messagesNet / 0.8;
    var referralsGross = referralsNet / 0.8;
    var streamsGross = streamsNet / 0.8;
    
    // Check if values are zero for m-zero-value class
    var subsZero = subsNet === 0 ? ' m-zero-value' : '';
    var tipsZero = tipsNet === 0 ? ' m-zero-value' : '';
    var postsZero = postsNet === 0 ? ' m-zero-value' : '';
    var messagesZero = messagesNet === 0 ? ' m-zero-value' : '';
    var streamsZero = streamsNet === 0 ? ' m-zero-value' : '';
    
    // Calculate first and last day of month for calendar button
    var daysInMonth = new Date(monthData.year, monthData.month + 1, 0).getDate();
    var fromDate = monthNameShort + ' 1, ' + yearStr;
    var toDate = monthNameShort + ' ' + daysInMonth + ', ' + yearStr;
    
    var row = document.createElement('div');
    row.className = 'b-stats-row';
    row.setAttribute('data-of-stats-generated', 'true');
    row.setAttribute('data-month-year', monthData.month + '-' + monthData.year);
    
    row.innerHTML = '<div class="b-stats-row__head">' +
      '<div class="b-stats-row__month"> ' + monthName + ', ' + yearStr + ' </div>' +
      '<div class="b-stats-row__total-net g-semibold"><span class="" data-of-stats-modified="true"> $' + netStr + ' </span></div>' +
      '<svg class="b-stats-row__arrow g-icon" data-icon-name="icon-arrow-down" aria-hidden="true"><use href="#icon-arrow-down" xlink:href="#icon-arrow-down"></use></svg>' +
      '</div>' +
      '<div class="b-stats-row__body" style="display: none;">' +
        '<div>' +
          '<div class="b-chart__wrapper" style="position: relative; margin-top: -15px;" data-of-month-chart="true">' +
            '<canvas class="b-chart__multiple-line" height="220" width="608" style="display: block; box-sizing: border-box; height: 220px; width: 608px;" data-of-stats-month-canvas="' + monthData.month + '-' + monthData.year + '" data-of-stats-overlay="true"></canvas>' +
          '</div>' +
        '</div>' +
        '<button class="g-btn m-border m-rounded m-block m-no-uppercase m-icon-absolute m-time-period m-lg">' +
          '<svg class="m-half-left g-icon" data-icon-name="icon-calendar" aria-hidden="true"><use href="#icon-calendar" xlink:href="#icon-calendar"></use></svg>' +
          '<span class="b-btn-text"> ' + (lang === 'ru' ? 'От ' : lang === 'es' ? 'Desde ' : lang === 'de' ? 'Von ' : 'From ') + '<span class="b-date-value">' + fromDate + '</span> ' + (lang === 'ru' ? 'К ' : lang === 'es' ? 'Hasta ' : lang === 'de' ? 'Bis ' : 'To ') + '<span class="b-date-value">' + toDate + '</span></span>' +
        '</button>' +
        '<div class="b-stats-row__content" data-of-stats-ready="true">' +
          '<div class="b-stats-row__label m-border-line m-subscriptions m-active">' +
            '<span class="b-stats-row__name g-md-text m-dots m-break-word"> ' + (lang === 'ru' ? 'Подписки' : lang === 'es' ? 'Suscripciones' : lang === 'de' ? 'Abonnements' : 'Subscriptions') + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + subsZero + '" data-of-stats-modified="true"> $' + formatCurrency(subsGross) + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + subsZero + '" data-of-stats-modified="true"> $' + formatCurrency(subsNet) + ' </span>' +
          '</div>' +
          '<div class="b-stats-row__label m-border-line m-tips">' +
            '<span class="b-stats-row__name g-md-text m-dots m-break-word"> ' + (lang === 'ru' ? 'Чаевые' : lang === 'es' ? 'Propinas' : lang === 'de' ? 'Trinkgelder' : 'Tips') + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + tipsZero + '" data-of-stats-modified="true"> $' + formatCurrency(tipsGross) + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + tipsZero + '" data-of-stats-modified="true"> $' + formatCurrency(tipsNet) + ' </span>' +
          '</div>' +
          '<div class="b-stats-row__label m-border-line m-posts">' +
            '<span class="b-stats-row__name g-md-text m-dots m-break-word"> ' + (lang === 'ru' ? 'Посты' : lang === 'es' ? 'Publicaciones' : lang === 'de' ? 'Beiträge' : 'Posts') + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + postsZero + '" data-of-stats-modified="true"> $' + formatCurrency(postsGross) + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + postsZero + '" data-of-stats-modified="true"> $' + formatCurrency(postsNet) + ' </span>' +
          '</div>' +
          '<div class="b-stats-row__label m-border-line m-messages">' +
            '<span class="b-stats-row__name g-md-text m-dots m-break-word"> ' + (lang === 'ru' ? 'Сообщения' : lang === 'es' ? 'Mensajes' : lang === 'de' ? 'Nachrichten' : 'Messages') + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + messagesZero + '" data-of-stats-modified="true"> $' + formatCurrency(messagesGross) + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + messagesZero + '" data-of-stats-modified="true"> $' + formatCurrency(messagesNet) + ' </span>' +
          '</div>' +
          '<div class="b-stats-row__label m-border-line m-referrals">' +
            '<span class="b-stats-row__name g-md-text m-dots m-break-word"> ' + (lang === 'ru' ? 'Рефералы' : lang === 'es' ? 'Referidos' : lang === 'de' ? 'Empfehlungen' : 'Referrals') + ' </span>' +
            '<span class="b-stats-row__val g-semibold m-zero-value" data-of-stats-modified="true"> $0.00 </span>' +
            '<span class="b-stats-row__val g-semibold m-zero-value" data-of-stats-modified="true"> $0.00 </span>' +
          '</div>' +
          '<div class="b-stats-row__label m-border-line m-calls">' +
            '<span class="b-stats-row__name g-md-text m-dots m-break-word"> ' + (lang === 'ru' ? 'Потоки' : lang === 'es' ? 'Transmisiones' : lang === 'de' ? 'Streams' : 'Streams') + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + streamsZero + '" data-of-stats-modified="true"> $' + formatCurrency(streamsGross) + ' </span>' +
            '<span class="b-stats-row__val g-semibold' + streamsZero + '" data-of-stats-modified="true"> $' + formatCurrency(streamsNet) + ' </span>' +
          '</div>' +
          '<div class="b-stats-row__label m-border-line m-total">' +
            '<span class="b-stats-row__name g-md-text"> ' + (lang === 'ru' ? 'Итого' : lang === 'es' ? 'Total' : lang === 'de' ? 'Gesamt' : 'Total') + ' </span>' +
            '<div class="b-stats-row__label m-total-item pt-0 pb-0">' +
              '<span class="b-stats-row__name g-md-text"> ' + (lang === 'ru' ? 'Валовой' : lang === 'es' ? 'Bruto' : lang === 'de' ? 'Brutto' : 'Gross') + ' </span>' +
              '<span class="b-stats-row__val g-semibold" data-of-stats-modified="true"> $' + grossStr + ' </span>' +
            '</div>' +
            '<div class="b-stats-row__label m-total-item pt-0 pb-0">' +
              '<span class="b-stats-row__name g-md-text"> ' + (lang === 'ru' ? 'Чистая' : lang === 'es' ? 'Neto' : lang === 'de' ? 'Netto' : 'Net') + ' </span>' +
              '<span class="b-stats-row__val g-semibold" data-of-stats-modified="true"> $' + netStr + ' </span>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    
    // Add click handler to expand/collapse
    var head = row.querySelector('.b-stats-row__head');
    if (head) {
      head.style.cursor = 'pointer';
      head.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        toggleMonthRow(row);
      });
    }
    
    // Use event delegation on the content area for category clicks
    var monthContent = row.querySelector('.b-stats-row__content');
    if (monthContent) {
      monthContent.addEventListener('click', function(e) {
        var label = e.target.closest('.b-stats-row__label.m-border-line:not(.m-total)');
        if (label) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          switchActiveCategory(row, label);
        }
      }, true); // capture phase
    }
    
    // Add cursor and handlers on labels, set initial styles
    var categoryLabels = row.querySelectorAll('.b-stats-row__label.m-border-line:not(.m-total)');
    categoryLabels.forEach(function(label) {
      // Set initial styles - Subscriptions active, others inactive
      var nameEl = label.querySelector('.b-stats-row__name');
      if (nameEl) {
        if (label.classList.contains('m-subscriptions')) {
          nameEl.style.color = '#000';
          nameEl.style.opacity = '1';
        } else {
          nameEl.style.color = '#8a96a3';
          nameEl.style.opacity = '0.6';
        }
      }
      label.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        switchActiveCategory(row, label);
      }, true); // capture phase
    });
    
    return row;
  }
  
  // Toggle month row expansion
  // Cannot close all - can only switch between rows
  function toggleMonthRow(row) {
    var isExpanded = row.classList.contains('m-expanded');
    var body = row.querySelector('.b-stats-row__body');
    
    // If already expanded, do nothing (can't close last open row)
    if (isExpanded) {
      return;
    }
    
    // Collapse All time row and other expanded months first
    var container = row.closest('.b-stats-wrap');
    if (container) {
      container.querySelectorAll('.b-stats-row.m-expanded').forEach(function(expandedRow) {
        expandedRow.classList.remove('m-expanded');
        var expandedBody = expandedRow.querySelector('.b-stats-row__body');
        if (expandedBody) expandedBody.style.display = 'none';
      });
    }
    
    // Expand this row
    row.classList.add('m-expanded');
    if (body) {
      body.style.display = 'block';
      
      // Always draw chart with animation when expanding
      var canvas = body.querySelector('canvas[data-of-stats-month-canvas]');
      if (canvas) {
        drawMonthChart(canvas, row);
      }
    }
  }
  
  // Draw chart for a specific month - uses same logic as All time chart via drawMonthChartCanvas
  function drawMonthChart(canvas, row) {
    if (!canvas) return;
    
    // Always clear and redraw for animation
    if (canvas._chartInstance) {
      canvas._chartInstance.destroy();
      canvas._chartInstance = null;
    }
    var ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    var monthKey = canvas.getAttribute('data-of-stats-month-canvas');
    if (!monthKey) return;
    
    // Get month data from stats
    var stats = getOrGenerateEarningStats();
    if (!stats || !stats.months) return;
    
    var parts = monthKey.split('-');
    var targetMonth = parseInt(parts[0]);
    var targetYear = parseInt(parts[1]);
    
    var monthData = stats.months.find(function(m) {
      return m.month === targetMonth && m.year === targetYear;
    });
    
    if (!monthData) {
      log('OF Stats: Month data not found for', targetMonth, targetYear);
      return;
    }
    
    // Generate daily cumulative data for this month (like All time chart)
    var now = new Date();
    var isCurrentMonth = (targetYear === now.getFullYear() && targetMonth === now.getMonth());
    var currentDay = now.getDate();
    
    // Always use full month for chart display
    var daysInMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
    
    // For current month, data is only generated up to today
    var daysWithData = isCurrentMonth ? currentDay : daysInMonth;
    
    var categories = monthData.categories || {};
    
    // Generate daily breakdown per category
    var dailyCategories = {
      subscriptions: [],
      tips: [],
      messages: [],
      posts: [],
      streams: []
    };
    
    // Distribute each category across days with cumulative growth (only up to daysWithData)
    Object.keys(dailyCategories).forEach(function(cat) {
      var totalForCat = categories[cat] || 0;
      var cumulative = 0;
      var remaining = totalForCat;
      
      // Generate data up to daysWithData
      for (var d = 0; d < daysWithData; d++) {
        var dayShare;
        if (d === daysWithData - 1) {
          dayShare = remaining;
        } else {
          var avgDaily = remaining / (daysWithData - d);
          dayShare = avgDaily * (0.2 + Math.random() * 1.6);
          dayShare = Math.max(0, Math.min(dayShare, remaining * 0.4));
        }
        cumulative += dayShare;
        remaining -= dayShare;
        dailyCategories[cat].push(cumulative);
      }
      
      // For current month: add flat line from today to end of month
      if (isCurrentMonth && daysWithData < daysInMonth) {
        var lastValue = cumulative;
        for (var d = daysWithData; d < daysInMonth; d++) {
          dailyCategories[cat].push(lastValue);
        }
      }
    });
    
    // Generate labels (day numbers)
    var labels = [];
    var langChart3 = getPageLanguage();
    var monthNamesShort = langChart3 === 'ru' ? ['янв.', 'февр.', 'март', 'апр.', 'май', 'июнь', 'июль', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.']
      : langChart3 === 'es' ? ['ene.', 'feb.', 'mar.', 'abr.', 'may.', 'jun.', 'jul.', 'ago.', 'sep.', 'oct.', 'nov.', 'dic.']
      : langChart3 === 'de' ? ['Jan.', 'Feb.', 'Mär.', 'Apr.', 'Mai', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.']
      : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (var d = 1; d <= daysInMonth; d++) {
      labels.push(d.toString().padStart(2, '0') + ' ' + monthNamesShort[targetMonth] + ' ' + (targetYear % 100).toString().padStart(2, '0'));
    }
    
    // Fixed canvas size matching OnlyFans (608x220)
    canvas.width = 608;
    canvas.height = 220;
    canvas.style.width = '608px';
    canvas.style.height = '220px';
    
    // Prepare chart data in same format as All time
    var chartData = {
      labels: labels,
      datasets: dailyCategories
    };
    
    // Store chartData on canvas for redraw when switching categories
    canvas._chartData = chartData;
    
    // Use same drawing function as All time chart
    drawMonthChartCanvas(canvas, chartData);
    
    canvas.setAttribute('data-chart-drawn', 'true');
  }
  
  // Apply monthly earnings to the page
  function applyMonthlyEarnings(stats) {
    // Find the container for month rows (b-stats-wrap)
    var container = document.querySelector('.b-stats-wrap');
    if (!container) {
      log('OF Stats: No .b-stats-wrap container found');
      return;
    }
    
    // Check if we already applied months to this container (prevents re-generation on page refresh)
    if (container.getAttribute('data-of-stats-months-applied')) {
      log('OF Stats: Monthly earnings already applied, skipping');
      return;
    }
    
    // Find "All time" row and collect all rows
    var allTimeRow = null;
    var existingMonthRows = [];
    var existingGeneratedRows = [];
    var allRows = container.querySelectorAll('.b-stats-row');
    
    allRows.forEach(function(row) {
      var monthEl = row.querySelector('.b-stats-row__month');
      if (monthEl) {
        if (isAllTimeText(monthEl.textContent)) {
          allTimeRow = row;
        } else if (row.getAttribute('data-of-stats-generated')) {
          // Our previously generated rows - collect for removal (tab navigation fix)
          existingGeneratedRows.push(row);
        } else {
          // Only collect non-generated original month rows for removal
          existingMonthRows.push(row);
        }
      }
    });
    
    // Remove ALL previously generated rows first (fixes duplicate bug on tab navigation)
    existingGeneratedRows.forEach(function(row) {
      row.remove();
    });
    log('OF Stats: Removed ' + existingGeneratedRows.length + ' previously generated month rows');
    
    // Use existing months data from stats if available, only generate if missing
    var monthsData;
    if (stats.months && stats.months.length > 0) {
      monthsData = stats.months;
      log('OF Stats: Using cached months data (' + monthsData.length + ' months)');
    } else {
      monthsData = generateMonthlyEarnings(stats.net);
      stats.months = monthsData;
      // Save updated stats with new months
      saveEarningStats(stats);
      log('OF Stats: Generated new months data (' + monthsData.length + ' months)');
    }
    
    // Remove ALL existing month rows (including previously generated ones)
    existingMonthRows.forEach(function(row) {
      row.remove();
    });
    
    // Mark container as processed to prevent re-generation
    container.setAttribute('data-of-stats-months-applied', 'true');
    
    log('OF Stats: Applying ' + monthsData.length + ' month rows');
    
    // Insert month rows after "All time" row
    var insertAfter = allTimeRow || container.firstChild;
    
    monthsData.forEach(function(monthData, index) {
      var rowEl = createMonthRowElement(monthData);
      if (insertAfter && insertAfter.nextSibling) {
        container.insertBefore(rowEl, insertAfter.nextSibling);
        insertAfter = rowEl;
      } else {
        container.appendChild(rowEl);
        insertAfter = rowEl;
      }
    });
  }
  
  // ============================================
  // STATISTICS/STATEMENTS/EARNINGS PAGE SUPPORT
  // ============================================
  
  // Check if we're on the statistics/statements/earnings page
  function isStatisticsEarningsPage() {
    return window.location.pathname === '/my/statistics/statements/earnings';
  }

  // Determine currently selected time period on statistics/statements/earnings page.
  // Returns: 'last30' | 'alltime' | 'other'
  // Detects the dropdown header text (e.g. "Last 30 days", "All time", etc.)
  function getSelectedStatisticsPeriod() {
    // The period dropdown on OF statistics page uses:
    // .b-sticky-position-dropdown > .dropdown > button.b-holder-options
    //   > div > .b-holder-options__title (contains "All time", "Last 30 days", etc.)
    var titleEl = document.querySelector('.b-holder-options__title');
    if (!titleEl) {
      // Fallback: try dropdown toggle button text
      titleEl = document.querySelector('.b-sticky-position-dropdown .dropdown-toggle, .b-holder-options');
    }
    if (!titleEl) {
      // Last fallback: scan page for known period text
      var candidates = document.querySelectorAll('.b-statistics-page-content__wrapper div, .b-statistics-page-content__wrapper button');
      for (var i = 0; i < Math.min(candidates.length, 60); i++) {
        var el = candidates[i];
        var elText = (el.textContent || '').trim();
        if (elText.length > 3 && elText.length < 30) {
          var lt = elText.toLowerCase();
          if (lt === 'all time' || lt === 'все время' || lt === 'за все время'
              || lt === 'todo el tiempo' || lt === 'gesamte zeit'
              || lt.indexOf('last') === 0 || lt.indexOf('послед') === 0
              || lt.indexOf('últim') === 0 || lt.indexOf('letzt') === 0) {
            titleEl = el;
            break;
          }
        }
      }
    }
    
    if (!titleEl) return 'last30'; // Default fallback
    
    var text = (titleEl.textContent || '').trim().toLowerCase();
    log('OF Stats: Period dropdown text: "' + text + '"');
    
    // Check for "All time" in various languages
    if (text.indexOf('all time') !== -1 
        || text.indexOf('все время') !== -1 || text.indexOf('за все время') !== -1
        || text.indexOf('todo el tiempo') !== -1 || text.indexOf('siempre') !== -1
        || text.indexOf('gesamte zeit') !== -1 || text.indexOf('gesamtzeitraum') !== -1
        || text.indexOf('alle zeiten') !== -1 || text.indexOf('immer') !== -1
        || isAllTimeText(text)) {
      return 'alltime';
    }
    
    // Check for "Last 30 days" in various languages
    if (text.indexOf('last 30') !== -1 || text.indexOf('últimos 30') !== -1 
        || text.indexOf('letzten 30') !== -1 || text.indexOf('последние 30') !== -1 
        || text.indexOf('30 дн') !== -1 || text.indexOf('30 day') !== -1
        || text.indexOf('30 día') !== -1 || text.indexOf('30 tag') !== -1) {
      return 'last30';
    }
    
    return 'other';
  }
  
  // Get transactions for statistics page - USES THE SAME DATA as /my/statements/earnings page
  // This ensures consistency between the two pages (users see the same nicknames/amounts)
  // If no Earnings counts configured, generates automatic transactions based on Gross value
  function getStatisticsTransactions(autoGenerateFromGross) {
    // Use the same data source as /my/statements/earnings (getOrGenerateEarningsData function)
    var pendingCount = 0;
    var completeCount = 0;
    
    if (cachedSettings) {
      pendingCount = parseInt(cachedSettings.earningsCount) || 0;
      completeCount = parseInt(cachedSettings.earningsCompleteCount) || 0;
    }
    
    // If no counts configured but autoGenerateFromGross is true, generate automatic transactions
    if (pendingCount === 0 && completeCount === 0) {
      if (autoGenerateFromGross) {
        // Auto-generate transactions based on Gross value from /my/stats/earnings data
        return generateAutoTransactionsForStatistics();
      }
      log('OF Stats: No earnings counts configured, returning empty transactions');
      return [];
    }
    
    // Get/generate the same transactions as /my/statements/earnings page
    var allTransactions = getOrGenerateEarningsData(pendingCount, completeCount);
    
    // Filter to only include transactions from last 30 days for the chart display
    var now = new Date();
    var thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    var filteredTransactions = allTransactions.filter(function(t) {
      return t.date >= thirtyDaysAgo;
    });
    
    log('OF Stats: Statistics page using same data as earnings page - ' + filteredTransactions.length + ' transactions from last 30 days (total: ' + allTransactions.length + ')');
    return filteredTransactions;
  }
  
  // Generate automatic transactions for statistics page when no Earnings counts are configured
  // Uses the Gross value from /my/stats/earnings data
  function generateAutoTransactionsForStatistics() {
    var cacheKey = 'ofStatsAutoTransactionsData';
    var grossKey = 'ofStatsAutoTransactionsGross';
    
    // Get Gross value from earning stats
    var earningStats = getOrGenerateEarningStatsEarly();
    if (!earningStats) {
      log('OF Stats: No earning stats available for auto-generating transactions');
      return [];
    }
    
    var months = earningStats.months || [];
    var totalGross = calculateGrossFromMonths(months);
    var roundedGross = Math.round(totalGross * 100) / 100;
    
    // Check cache - if Gross hasn't changed, use cached transactions
    try {
      var cachedGross = localStorage.getItem(grossKey);
      var cachedData = localStorage.getItem(cacheKey);
      
      if (cachedGross && cachedData) {
        var cachedGrossRounded = Math.round(parseFloat(cachedGross) * 100) / 100;
        if (cachedGrossRounded === roundedGross) {
          var parsed = JSON.parse(cachedData);
          // Restore Date objects
          for (var i = 0; i < parsed.length; i++) {
            parsed[i].date = new Date(parsed[i].date);
          }
          log('OF Stats: Using cached auto-transactions (' + parsed.length + ' transactions, Gross: $' + roundedGross.toFixed(2) + ')');
          return parsed;
        }
      }
    } catch(e) {}
    
    log('OF Stats: Generating auto-transactions from Gross value $' + roundedGross.toFixed(2));
    
    // Calculate how many transactions to generate based on Gross
    // Average transaction ~$25-50, so count = Gross / avgAmount
    var avgTransactionAmount = 30 + Math.random() * 20; // $30-50
    var transactionCount = Math.max(10, Math.round(totalGross / avgTransactionAmount));
    transactionCount = Math.min(transactionCount, 200); // Cap at 200 transactions
    
    // Split into pending (30%) and complete (70%) - last 30 days
    var pendingCount = Math.round(transactionCount * 0.3);
    var completeCount = transactionCount - pendingCount;
    
    // Generate transactions
    var generated = [];
    var now = new Date();
    
    // Generate pending transactions (last 7 days)
    for (var p = 0; p < pendingCount; p++) {
      var pendingDaysAgo = Math.floor(Math.random() * 7); // 0-6 days ago
      var transDatePending = new Date(now);
      transDatePending.setDate(transDatePending.getDate() - pendingDaysAgo);
      transDatePending.setHours(Math.floor(Math.random() * 24), Math.floor(Math.random() * 60), Math.floor(Math.random() * 60), 0);
      
      var amountPending = earningsGenerateAmount();
      generated.push({
        date: transDatePending,
        amount: amountPending,
        fee: amountPending * 0.20,
        net: amountPending * 0.80,
        type: Math.random() < 0.70 ? 'payment' : 'tip',
        username: earningsGenerateUsername(),
        userId: 'u' + Math.floor(Math.random() * 900000000 + 100000000),
        status: 'pending'
      });
    }
    
    // Generate complete transactions (8-30 days ago)
    for (var c = 0; c < completeCount; c++) {
      var completeDaysAgo = 8 + Math.floor(Math.random() * 22); // 8-29 days ago
      var transDateComplete = new Date(now);
      transDateComplete.setDate(transDateComplete.getDate() - completeDaysAgo);
      transDateComplete.setHours(Math.floor(Math.random() * 24), Math.floor(Math.random() * 60), Math.floor(Math.random() * 60), 0);
      
      var amountComplete = earningsGenerateAmount();
      var statusComplete = Math.random() < 0.02 ? 'reversed' : 'complete';
      
      generated.push({
        date: transDateComplete,
        amount: amountComplete,
        fee: amountComplete * 0.20,
        net: amountComplete * 0.80,
        type: Math.random() < 0.70 ? 'payment' : 'tip',
        username: earningsGenerateUsername(),
        userId: 'u' + Math.floor(Math.random() * 900000000 + 100000000),
        status: statusComplete
      });
    }
    
    // Sort by date descending
    generated.sort(function(a, b) { return b.date - a.date; });
    
    // Save to cache
    try {
      localStorage.setItem(grossKey, roundedGross.toString());
      localStorage.setItem(cacheKey, JSON.stringify(generated));
    } catch(e) {}
    
    log('OF Stats: Generated ' + generated.length + ' auto-transactions for statistics page');
    return generated;
  }
  
  // Apply statistics/statements/earnings page content
  function applyStatisticsEarningsPage() {
    if (!isStatisticsEarningsPage()) return;
    
    // Check if chart generation is disabled (user clicked Reset)
    try {
      if (localStorage.getItem('ofStatsStatisticsChartDisabled') === 'true') {
        log('OF Stats: Statistics chart generation disabled (after Reset). Showing original content.');
        // Remove any hiding styles to show original content
        var hideStyle = document.getElementById('of-stats-hide-earnings-content');
        if (hideStyle) hideStyle.remove();
        
        // Stop the observer that hides original elements
        stopOriginalElementsObserver();
        
        // Also remove any already generated elements (in case they were created before flag was set)
        var wrapper = findEarningsWrapper();
        if (wrapper) {
          // Destroy Chart.js instances before removing canvas elements
          if (typeof Chart !== 'undefined') {
            var mainCanvas = document.getElementById('of-stats-earnings-chart-main');
            var asideCanvas = document.getElementById('of-stats-earnings-chart-aside');
            if (mainCanvas) {
              var mainChart = Chart.getChart(mainCanvas);
              if (mainChart) mainChart.destroy();
            }
            if (asideCanvas) {
              var asideChart = Chart.getChart(asideCanvas);
              if (asideChart) asideChart.destroy();
            }
            document.querySelectorAll('canvas[id^="of-stats-mini-chart-"]').forEach(function(canvas) {
              var chart = Chart.getChart(canvas);
              if (chart) chart.destroy();
            });
          }
          wrapper.querySelectorAll('[data-of-stats-generated]').forEach(function(el) {
            el.remove();
          });
          wrapper.removeAttribute('data-of-stats-applied');
          
          // Restore visibility of original hidden elements
          wrapper.querySelectorAll('[data-of-stats-original-hidden]').forEach(function(el) {
            el.removeAttribute('data-of-stats-original-hidden');
            el.style.display = '';
          });
        }
        // Reset Earnings section processed flag to show original
        document.querySelectorAll('.b-useful-data[data-of-stats-processed]').forEach(function(el) {
          el.removeAttribute('data-of-stats-processed');
        });
        document.querySelectorAll('[data-of-stats-earnings-generated]').forEach(function(el) {
          el.remove();
        });
        return;
      }
    } catch(e) {}
    
    // Check if earnings counts are configured in the plugin
    var pendingCount = 0;
    var completeCount = 0;
    if (cachedSettings) {
      pendingCount = parseInt(cachedSettings.earningsCount) || 0;
      completeCount = parseInt(cachedSettings.earningsCompleteCount) || 0;
    }
    
    // Even if no counts configured, we still generate data automatically from /my/stats/earnings
    var hasEarningsCounts = (pendingCount > 0 || completeCount > 0);
    // Store globally so observer can check this
    window.ofStatsHasEarningsCounts = hasEarningsCounts;
    
    var wrapper = findEarningsWrapper();
    if (!wrapper) return;

    // Wait for OF to finish its own loading state before replacing content.
    // If we apply during OF's data fetch, we hide the loading spinner and force
    // an instant render — which (per user reports) causes jank and chart
    // animation glitches on repeat navigations. Detecting OF's "loaded" signal
    // by waiting for the natural determinant OR chart to appear keeps OF's
    // organic loading flow intact, then we replace the rendered content.
    // Skip the wait if we've already applied (re-apply path) or already have
    // an existing applied flag (idempotent re-run).
    if (!wrapper.getAttribute('data-of-stats-applied')) {
      var hasNativeDeterminant = !!wrapper.querySelector('.b-elements-determinant:not([data-of-stats-generated])');
      var hasNativeChart = !!wrapper.querySelector('.b-chart:not([data-of-stats-generated]) canvas');
      if (!hasNativeDeterminant && !hasNativeChart) {
        // OF is still loading — observer will re-trigger us when DOM settles
        return;
      }
    }

    // Check if already applied
    if (wrapper.getAttribute('data-of-stats-applied')) {
      var hasMain = wrapper.querySelector('#of-stats-earnings-chart-main');
      var hasAside = wrapper.querySelector('#of-stats-earnings-chart-aside');
      var hasCombined = wrapper.querySelector('#of-stats-earnings-chart-combined');
      if (!hasMain || !hasAside || hasCombined) {
        // Remove old generated elements so we can re-apply
        wrapper.querySelectorAll('[data-of-stats-generated]').forEach(function(el) {
          el.remove();
        });
        if (hasCombined) {
          var oldChart = hasCombined.closest('.b-chart');
          if (oldChart) oldChart.remove();
        }
        wrapper.removeAttribute('data-of-stats-applied');
      } else {
        return;
      }
    }
    wrapper.setAttribute('data-of-stats-applied', 'true');
    
    // Determine currently selected period
    var selectedPeriod = getSelectedStatisticsPeriod();
    log('OF Stats: Selected statistics period: ' + selectedPeriod);
    // Store globally for observer
    window.ofStatsCurrentPeriod = selectedPeriod;
    
    // For periods other than last30/alltime — show native content as-is
    if (selectedPeriod === 'other') {
      // Restore any previously hidden native elements
      wrapper.querySelectorAll('[data-of-stats-original-hidden]').forEach(function(el) {
        el.removeAttribute('data-of-stats-original-hidden');
        el.style.display = '';
      });
      document.querySelectorAll('.b-useful-data[data-of-stats-processed]').forEach(function(el) {
        el.removeAttribute('data-of-stats-processed');
      });
      document.querySelectorAll('[data-of-stats-earnings-generated]').forEach(function(el) {
        el.remove();
      });
      log('OF Stats: Period is "other" — showing native content');
      startOriginalElementsObserver();
      return;
    }
    
    // Hide/remove original elements that we're replacing (charts, summary)
    // Mark them with attribute so CSS can hide them reliably
    wrapper.querySelectorAll('.b-elements-determinant:not([data-of-stats-generated])').forEach(function(el) {
      el.setAttribute('data-of-stats-original-hidden', 'true');
      el.style.display = 'none';
    });
    wrapper.querySelectorAll('.b-chart:not([data-of-stats-generated])').forEach(function(el) {
      el.setAttribute('data-of-stats-original-hidden', 'true');
      el.style.display = 'none';
    });
    // Only hide original transactions table if earnings counts are set
    if (hasEarningsCounts) {
      wrapper.querySelectorAll('.b-separate-section:not([data-of-stats-generated])').forEach(function(el) {
        el.setAttribute('data-of-stats-original-hidden', 'true');
        el.style.display = 'none';
      });
    }
    
    log('OF Stats: Applying statistics/statements/earnings page (period: ' + selectedPeriod + ')');
    
    // Get monthly data from /my/stats/earnings to calculate Gross and % change
    var earningStats = getOrGenerateEarningStatsEarly();
    var months = earningStats ? earningStats.months : null;
    
    log('OF Stats Debug: earningStats=' + (earningStats ? 'exists' : 'null') + ', months=' + (months ? months.length + ' items' : 'null'));
    
    // Get balances from settings
    var currentBalance = getCurrentBalanceValue();
    
    // Calculate Gross/Net based on selected period
    var totalGross;
    if (selectedPeriod === 'alltime' && earningStats && earningStats.gross) {
      // All Time — use total Gross from /my/stats/earnings data
      totalGross = earningStats.gross;
      log('OF Stats: Using All Time Gross from earningStats: $' + totalGross.toFixed(2));
    } else {
      // Last 30 days — average of 2 most recent months
      totalGross = calculateGrossFromMonths(months);
    }
    
    log('OF Stats Debug: totalGross=' + totalGross + ', currentBalance=' + currentBalance);
    var totalNet;
    if (selectedPeriod === 'alltime' && earningStats && earningStats.net) {
      totalNet = earningStats.net;
    } else {
      totalNet = totalGross * 0.8;
    }
    
    // Calculate percentage change from comparing current and previous month
    var percentChange = calculateMonthlyPercentageChange(months);
    
    // Get transactions - SAME DATA as /my/statements/earnings page, or auto-generate if no counts set
    // Pass true to enable auto-generation from Gross when no Earnings counts configured
    var transactions = getStatisticsTransactions(true);
    
    // Build percentage change display with correct icon (increase/decrease)
    var percentIcon = percentChange.isIncrease ? 'icon-increase' : 'icon-decrease';
    var percentClass = percentChange.isIncrease ? 'm-level-up' : 'm-level-down';
    var percentValue = percentChange.value.toFixed(1);
    
    // Create the summary display with Net/Gross and calculated % change
    var summaryDiv = document.createElement('div');
    summaryDiv.className = 'b-elements-determinant mb-0';
    summaryDiv.setAttribute('data-of-stats-generated', 'true');
    summaryDiv.innerHTML = '<div class="b-elements-determinant__value m-inline">' +
      '<span class=""> $' + formatCurrency(totalNet) + ' </span>' +
      '<div class="g-gray-text b-statistics-level__text"> (<span id="of-stats-gross-clickable" style="cursor:pointer;"> $' + formatCurrency(totalGross) + ' </span> ' + getLocalizedGrossLabel() + ') </div>' +
      '<span class="b-statistics-level ' + percentClass + '"><svg data-icon-name="' + percentIcon + '" aria-hidden="true" class="g-icon"><use href="#' + percentIcon + '" xlink:href="#' + percentIcon + '"></use></svg> ' + percentValue + '% </span>' +
      '</div>';
    
    // Create charts container - two canvases like original
    var chartDiv = document.createElement('div');
    chartDiv.className = 'b-chart b-chart--no-padding';
    chartDiv.setAttribute('data-of-stats-generated', 'true');
    chartDiv.style.marginTop = '5px';
    chartDiv.innerHTML = '<div class="b-chart__wrapper" style="position: relative; width: 100%; height: 112px;">' +
      '<canvas height="196" class="b-chart__double-line__main" style="display: block; box-sizing: border-box; height: 112px; width: 100%;" id="of-stats-earnings-chart-main"></canvas>' +
      '<div class="b-chart__tooltip of-stats-tooltip" id="of-stats-chart-tooltip" style="opacity: 0; left: 0px; top: 4.5px; width: 156px;">' +
        '<div class="b-chart__tooltip__title">&nbsp;</div>' +
        '<div class="b-chart__tooltip__text">' +
          '<div class="b-chart__tooltip__circle" style="background: rgb(0, 175, 240);"></div>' +
          '<div class="b-chart__tooltip__text__title"> ' + (getPageLanguage() === 'ru' ? 'Заработок' : getPageLanguage() === 'es' ? 'Ganancias' : getPageLanguage() === 'de' ? 'Verdienst' : 'Earnings') + ' </div>' +
          '<div class="b-chart__tooltip__text__value"> $0.00 </div>' +
        '</div>' +
        '<div class="b-chart__tooltip__text">' +
          '<div class="b-chart__tooltip__circle" style="background: rgb(138, 150, 163);"></div>' +
          '<div class="b-chart__tooltip__text__title"> ' + (getPageLanguage() === 'ru' ? 'Транзакции' : getPageLanguage() === 'es' ? 'Transacciones' : getPageLanguage() === 'de' ? 'Transaktionen' : 'Transactions') + ' </div>' +
          '<div class="b-chart__tooltip__text__value"> 0 </div>' +
        '</div>' +
      '</div>' +
      '</div>' +
      '<div class="b-chart__wrapper" style="position: relative; width: 100%; height: 90px;">' +
      '<canvas height="160" class="b-chart__double-line__aside" style="display: block; box-sizing: border-box; height: 90px; width: 100%;" id="of-stats-earnings-chart-aside"></canvas>' +
      '</div>';
    
    // Create transactions table only if earnings counts are set
    var tableDiv = null;
    if (hasEarningsCounts) {
      tableDiv = document.createElement('div');
      tableDiv.className = 'b-separate-section g-negative-sides-gaps g-sides-gaps';
      tableDiv.setAttribute('data-of-stats-generated', 'true');
    
      var langTable = getPageLanguage();
      var tableHTML = '<table cellspacing="0" cellpadding="0" border="0" class="b-table m-responsive m-compact-view-mode m-default-table b-statements-table">' +
        '<thead><tr><th class="m-width-statements"> ' + (langTable === 'ru' ? 'Дата' : langTable === 'es' ? 'Fecha' : langTable === 'de' ? 'Datum' : 'Date') + ' </th><th class="text-right"> ' + (langTable === 'ru' ? 'Сумма' : langTable === 'es' ? 'Monto' : langTable === 'de' ? 'Betrag' : 'Amount') + ' </th><th class="text-right"> ' + (langTable === 'ru' ? 'Сбор' : langTable === 'es' ? 'Tarifa' : langTable === 'de' ? 'Gebühr' : 'Fee') + ' </th><th class="text-right"> ' + (langTable === 'ru' ? 'Чистая' : langTable === 'es' ? 'Neto' : langTable === 'de' ? 'Netto' : 'Net') + ' </th></tr></thead>' +
      '<tbody>';
    
    var months = langTable === 'ru'
      ? ['янв.', 'февр.', 'март', 'апр.', 'май', 'июнь', 'июль', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.']
      : langTable === 'es'
      ? ['ene.', 'feb.', 'mar.', 'abr.', 'may.', 'jun.', 'jul.', 'ago.', 'sep.', 'oct.', 'nov.', 'dic.']
      : langTable === 'de'
      ? ['Jan.', 'Feb.', 'Mär.', 'Apr.', 'Mai', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.']
      : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    transactions.forEach(function(t) {
      var dateStr = months[t.date.getMonth()] + ' ' + t.date.getDate() + ', ' + t.date.getFullYear() + ',';
      var hours = t.date.getHours();
      var minutes = t.date.getMinutes().toString().padStart(2, '0');
      var ampm = hours >= 12 ? 'pm' : 'am';
      hours = hours % 12 || 12;
      var timeStr = hours + ':' + minutes + ' ' + ampm;
      
      var description = t.type === 'tip' 
        ? (langTable === 'ru' ? 'Чаевые от' : langTable === 'es' ? 'Propina de' : langTable === 'de' ? 'Trinkgeld von' : 'Tip from') + ' <a href="https://onlyfans.com/' + t.userId + '">' + t.username + '</a>'
        : (langTable === 'ru' ? 'Оплата за сообщение от' : langTable === 'es' ? 'Pago por mensaje de' : langTable === 'de' ? 'Zahlung für Nachricht von' : 'Payment for message from') + ' <a href="https://onlyfans.com/' + t.userId + '">' + t.username + '</a>';
      
      // Use the status from the transaction data (same as /my/statements/earnings)
      var status = t.status || 'pending';
      var iconName, statusText;
      
      if (status === 'complete') {
        iconName = 'icon-done';
        statusText = langTable === 'ru' ? 'Завершить' : langTable === 'es' ? 'Completado' : langTable === 'de' ? 'Abgeschlossen' : 'Complete';
      } else if (status === 'reversed') {
        iconName = 'icon-undo';
        statusText = langTable === 'ru' ? 'Перевернутый' : langTable === 'es' ? 'Revertido' : langTable === 'de' ? 'Storniert' : 'Reversed';
      } else {
        // pending - calculate days remaining (max 6 days)
        var now = new Date();
        now.setHours(0, 0, 0, 0);
        var transDateNorm = new Date(t.date);
        transDateNorm.setHours(0, 0, 0, 0);
        var daysSince = Math.floor((now - transDateNorm) / (1000 * 60 * 60 * 24));
        var daysRemaining = Math.max(1, 6 - daysSince);
        iconName = 'icon-loading';
        if (langTable === 'ru') {
          statusText = 'Заработок станет доступен в ' + daysRemaining + ' течение нескольких дней';
        } else if (langTable === 'es') {
          statusText = 'Las ganancias estarán disponibles en ' + daysRemaining + ' día' + (daysRemaining !== 1 ? 's' : '');
        } else if (langTable === 'de') {
          statusText = 'Einnahmen verfügbar in ' + daysRemaining + ' Tag' + (daysRemaining !== 1 ? 'en' : '');
        } else {
          statusText = 'Earning will become available in ' + daysRemaining + ' day' + (daysRemaining !== 1 ? 's' : '');
        }
      }
      
      tableHTML += '<tr class="m-responsive__reset-pb">' +
        '<td class="m-responsive__before-line-over m-width-statements"><strong><span class="d-inline-block">' + dateStr + '</span><span class="d-inline-block">' + timeStr + '</span></strong></td>' +
        '<td class="m-responsive__before-line-over"><span class=""> $' + t.amount.toFixed(2) + ' </span></td>' +
        '<td class="m-responsive__before-line-over"><span class=""> $' + t.fee.toFixed(2) + ' </span></td>' +
        '<td class="m-responsive__before-line-over m-last-in-row"><strong><span class=""> $' + t.net.toFixed(2) + ' </span></strong></td>' +
        '<td class="m-responsive__border-line__over text-left"><span class="b-statements-text-table">' + description + '</span>' +
        '<div class="b-table-group-btns"><span tabindex="0" class="b-table__status-tip" data-tooltip-text="' + statusText + '">' +
        '<svg class="g-icon" data-icon-name="' + iconName + '" aria-hidden="true"><use href="#' + iconName + '" xlink:href="#' + iconName + '"></use></svg></span></div></td>' +
        '</tr>';
    });
    
      tableHTML += '</tbody></table>';
      tableDiv.innerHTML = tableHTML;
    }
    
    // Find and hide "No data during selected period" text
    var noDataEl = wrapper.querySelector('.b-elements-determinant, .g-gray-text');
    if (!noDataEl) {
      // Try to find any text node with "No data"
      var textNodes = wrapper.querySelectorAll('*');
      textNodes.forEach(function(el) {
        if (el.textContent && el.textContent.includes('No data during selected period')) {
          el.style.display = 'none';
        }
      });
    }
    
    // Find the category tabs (All, Subscriptions, Tips, etc.) and insert after them
    var tabsNav = wrapper.querySelector('.b-tabs__nav');
    if (tabsNav) {
      // Insert summary after tabs
      tabsNav.parentNode.insertBefore(summaryDiv, tabsNav.nextSibling);
      // Insert charts after summary
      summaryDiv.parentNode.insertBefore(chartDiv, summaryDiv.nextSibling);
      // Insert table after charts (only if created)
      if (tableDiv) {
        chartDiv.parentNode.insertBefore(tableDiv, chartDiv.nextSibling);
      }
    } else {
      // Fallback: prepend to wrapper
      if (tableDiv) {
        wrapper.prepend(tableDiv);
      }
      wrapper.prepend(chartDiv);
      wrapper.prepend(summaryDiv);
    }
    
    // Generate Earnings breakdown (Total, Tips, Messages) with caching (tied to Gross)
    // Pass the already calculated percentChange to ensure consistency
    var earningsBreakdown = getOrGenerateEarningsBreakdown(totalNet, totalGross, percentChange);
    
    // Find original Earnings section by header text and replace its content
    // This works on all page types (with data or "No earnings for this period")
    function findAndReplaceEarningsSection() {
      var allUsefulData = document.querySelectorAll('.b-useful-data');
      var originalEarningsSection = null;
      
      allUsefulData.forEach(function(section) {
        // Skip already processed sections
        if (section.hasAttribute('data-of-stats-processed')) return;
        
        var header = section.querySelector('.b-useful-data__header');
        if (header) {
          var hText = header.textContent.trim();
          if (hText === 'Earnings' || hText === 'Заработок' || hText === 'Ganancias' || hText === 'Provision') {
            originalEarningsSection = section;
          }
        }
      });
      
      if (originalEarningsSection) {
        // Mark as processed
        originalEarningsSection.setAttribute('data-of-stats-processed', 'true');
        
        // Hide all native children except header (don't remove — Vue would re-create them)
        var children = Array.from(originalEarningsSection.children);
        children.forEach(function(child) {
          if (!child.classList.contains('b-useful-data__header') && !child.hasAttribute('data-of-stats-earnings-generated')) {
            child.style.display = 'none';
            child.setAttribute('data-of-stats-original-hidden', 'true');
          }
        });
        
        // Only add our content if not already added
        if (!originalEarningsSection.querySelector('[data-of-stats-earnings-generated]')) {
          var contentWrapper = document.createElement('div');
          contentWrapper.className = 'b-statistics-columns m-separate-block m-rows-items';
          contentWrapper.setAttribute('data-of-stats-earnings-generated', 'true');
          contentWrapper.innerHTML = generateEarningsRowsHTML(earningsBreakdown);
          originalEarningsSection.appendChild(contentWrapper);
        }
        
        log('OF Stats: Replaced Earnings section content');
        
        // Draw mini charts
        setTimeout(function() {
          if (earningsBreakdown.miniCharts) {
            drawMiniChartsDirectly(earningsBreakdown.miniCharts);
          }
        }, 200);
        
        return true;
      }
      return false;
    }
    
    // Try to find and replace now
    if (!findAndReplaceEarningsSection()) {
      // If not found, observe for it
      var earningsObserver = new MutationObserver(function(mutations) {
        if (findAndReplaceEarningsSection()) {
          earningsObserver.disconnect();
        }
      });
      earningsObserver.observe(document.body, { childList: true, subtree: true });
      
      // Timeout to stop observing after 10 seconds
      setTimeout(function() {
        earningsObserver.disconnect();
      }, 10000);
    }
    
    // Store chart params for Gross click regeneration
    window.ofStatsLastChartParams = {
      transactions: transactions,
      grossValue: totalGross,
      earningsBreakdown: earningsBreakdown
    };
    
    // Load Chart.js and draw charts (pass grossValue for caching)
    loadChartJsAndDraw(transactions, totalGross, earningsBreakdown);
    
    // Attach click handler to Gross value for chart regeneration
    setTimeout(function() {
      var grossEl = document.getElementById('of-stats-gross-clickable');
      if (grossEl && !grossEl.getAttribute('data-of-stats-click-bound')) {
        grossEl.setAttribute('data-of-stats-click-bound', 'true');
        grossEl.addEventListener('click', function() {
          log('OF Stats: Gross clicked — full regeneration');
          // Clear ALL caches (chart, earnings breakdown, auto-transactions, gross marker,
          // AND the transactions cache itself). Without clearing transactions, the
          // right side of the 30-day chart is populated from cached real transactions
          // (same dates/amounts) → user sees identical right edge on every click.
          try {
            localStorage.removeItem('ofStatsChartDataCache');
            localStorage.removeItem('ofStatsChartGrossValue');
            localStorage.removeItem('ofStatsEarningsBreakdownCache');
            localStorage.removeItem('ofStatsAutoTransactionsData');
            localStorage.removeItem('ofStatsAutoTransactionsGross');
            // Transaction cache used by both /earnings table AND the statistics chart.
            // Clearing forces a fresh random distribution for the entire 30-day window.
            localStorage.removeItem('ofStatsEarningsData');
            localStorage.removeItem('ofStatsEarningsKey');
          } catch(e) {}
          // Destroy existing Chart.js instances
          if (typeof Chart !== 'undefined') {
            var mc = document.getElementById('of-stats-earnings-chart-main');
            var ac = document.getElementById('of-stats-earnings-chart-aside');
            if (mc) { var c = Chart.getChart(mc); if (c) c.destroy(); }
            if (ac) { var c2 = Chart.getChart(ac); if (c2) c2.destroy(); }
            document.querySelectorAll('canvas[id^="of-stats-mini-chart-"]').forEach(function(canvas) {
              var ch = Chart.getChart(canvas); if (ch) ch.destroy();
            });
          }
          // Full cleanup — remove all generated elements and re-apply from scratch
          var w = findEarningsWrapper();
          if (w) {
            w.querySelectorAll('[data-of-stats-generated]').forEach(function(el) { el.remove(); });
            w.querySelectorAll('[data-of-stats-original-hidden]').forEach(function(el) {
              el.removeAttribute('data-of-stats-original-hidden');
              el.style.display = '';
            });
            document.querySelectorAll('.b-useful-data[data-of-stats-processed]').forEach(function(el) {
              el.removeAttribute('data-of-stats-processed');
            });
            document.querySelectorAll('[data-of-stats-earnings-generated]').forEach(function(el) {
              el.remove();
            });
            w.removeAttribute('data-of-stats-applied');
          }
          applyStatisticsEarningsPage();
        });
      }
    }, 100);
    
    // Init tooltips for status icons
    initStatusTooltips();
    
    log('OF Stats: Statistics earnings page applied with', transactions.length, 'transactions');
    
    // Start/restart the global observer for hiding original elements
    // This observer watches document.body to catch all dynamically loaded content
    startOriginalElementsObserver();
  }
  
  // Global observer for hiding original elements on statistics/statements/earnings page
  function startOriginalElementsObserver() {
    // Don't start if already running
    if (window.ofStatsOriginalElementsObserver) return;
    
    // Check if disabled
    try {
      if (localStorage.getItem('ofStatsStatisticsChartDisabled') === 'true') return;
    } catch(e) {}
    
    window.ofStatsOriginalElementsObserver = new MutationObserver(function(mutations) {
      // Check if disabled flag is set
      try {
        if (localStorage.getItem('ofStatsStatisticsChartDisabled') === 'true') {
          stopOriginalElementsObserver();
          return;
        }
      } catch(e) {}
      
      // Only process if on the right page
      if (!isStatisticsEarningsPage()) return;
      
      var wrapper = findEarningsWrapper();
      if (!wrapper) return;
      
      // --- Hide original elements ---
      var currentPeriod = window.ofStatsCurrentPeriod || 'last30';
      if (currentPeriod === 'other') return;
      
      // Hide any original elements (those without our generated attribute)
      var hiddenCount = 0;
      wrapper.querySelectorAll('.b-elements-determinant:not([data-of-stats-generated]):not([data-of-stats-original-hidden])').forEach(function(el) {
        el.setAttribute('data-of-stats-original-hidden', 'true');
        el.style.display = 'none';
        hiddenCount++;
      });
      wrapper.querySelectorAll('.b-chart:not([data-of-stats-generated]):not([data-of-stats-original-hidden])').forEach(function(el) {
        el.setAttribute('data-of-stats-original-hidden', 'true');
        el.style.display = 'none';
        hiddenCount++;
      });
      // Only hide original transactions table if earnings counts are set
      if (window.ofStatsHasEarningsCounts) {
        wrapper.querySelectorAll('.b-separate-section:not([data-of-stats-generated]):not([data-of-stats-original-hidden])').forEach(function(el) {
          el.setAttribute('data-of-stats-original-hidden', 'true');
          el.style.display = 'none';
          hiddenCount++;
        });
      }
      
      if (hiddenCount > 0) {
        log('OF Stats: Hidden ' + hiddenCount + ' original elements');
      }
    });
    
    // Observe document.body to catch all changes including SPA navigation
    window.ofStatsOriginalElementsObserver.observe(document.body, { childList: true, subtree: true });
    log('OF Stats: Started original elements observer');
    
    // Also start dropdown click listener for immediate period detection
    startDropdownClickListener();
  }
  
  // Stop the global observer
  function stopOriginalElementsObserver() {
    if (window.ofStatsOriginalElementsObserver) {
      window.ofStatsOriginalElementsObserver.disconnect();
      window.ofStatsOriginalElementsObserver = null;
      log('OF Stats: Stopped original elements observer');
    }
  }
  
  // Listen for dropdown clicks to immediately detect period changes
  function startDropdownClickListener() {
    if (window.ofStatsDropdownClickListener) return;
    
    window.ofStatsDropdownClickListener = function(e) {
      if (!isStatisticsEarningsPage()) return;
      
      // Check if click is on or inside the period dropdown area
      var dropdownArea = e.target.closest('.b-sticky-position-dropdown, .b-holder-options, .dropdown-menu, .dropdown-item, .b-holder-options__title, .dropdown');
      if (!dropdownArea) return;
      
      // After dropdown item click, check period change with short delays (multiple checks)
      var delays = [150, 400, 800];
      delays.forEach(function(delay) {
        setTimeout(function() {
          var appliedPeriod = window.ofStatsCurrentPeriod || 'last30';
          var newPeriod = getSelectedStatisticsPeriod();
          if (newPeriod !== appliedPeriod) {
            log('OF Stats: Dropdown click detected period change: ' + appliedPeriod + ' -> ' + newPeriod);
            var wrapper = findEarningsWrapper();
            if (wrapper) {
              wrapper.querySelectorAll('[data-of-stats-generated]').forEach(function(el) { el.remove(); });
              wrapper.querySelectorAll('[data-of-stats-original-hidden]').forEach(function(el) {
                el.removeAttribute('data-of-stats-original-hidden');
                el.style.display = '';
              });
              document.querySelectorAll('.b-useful-data[data-of-stats-processed]').forEach(function(el) {
                el.removeAttribute('data-of-stats-processed');
              });
              document.querySelectorAll('[data-of-stats-earnings-generated]').forEach(function(el) {
                el.remove();
              });
              wrapper.removeAttribute('data-of-stats-applied');
              try {
                localStorage.removeItem('ofStatsChartDataCache');
                localStorage.removeItem('ofStatsEarningsBreakdownCache');
              } catch(e) {}
              applyStatisticsEarningsPage();
            }
          }
        }, delay);
      });
    };
    
    document.addEventListener('click', window.ofStatsDropdownClickListener, true);
    log('OF Stats: Started dropdown click listener');
  }
  
  // Export function to window for content.js to call after Apply Changes
  // forceRegenerate=true means user explicitly clicked Apply and wants fresh data
  window.ofStatsApplyStatisticsEarningsPage = function(newSettings, forceRegenerate) {
    // Only clear the statistics chart disabled flag when user explicitly clicked Apply
    // Don't clear on auto-apply (page load) - let user control when to re-enable
    if (forceRegenerate) {
      try {
        localStorage.removeItem('ofStatsStatisticsChartDisabled');
        log('OF Stats: Cleared statistics chart disabled flag (Apply Changes with forceRegenerate)');
      } catch(e) {}
    } else {
      // Check if chart generation is disabled (user clicked Reset) - don't generate if disabled
      try {
        if (localStorage.getItem('ofStatsStatisticsChartDisabled') === 'true') {
          log('OF Stats: Statistics chart generation disabled (skipping auto-apply)');
          return;
        }
      } catch(e) {}
    }
    
    // Update cachedSettings with new values
    if (newSettings) {
      cachedSettings = newSettings;
      
      // Only clear chart caches if explicitly requested (user clicked Apply button)
      // Don't clear on auto-apply (F5 reload) to preserve cached chart data
      if (forceRegenerate) {
        try {
          localStorage.removeItem('ofStatsChartDataCache');
          localStorage.removeItem('ofStatsChartGrossValue');
          localStorage.removeItem('ofStatsEarningsBreakdownCache');
          // Also clear auto-transactions cache
          localStorage.removeItem('ofStatsAutoTransactionsData');
          localStorage.removeItem('ofStatsAutoTransactionsGross');
          log('OF Stats: Cleared chart caches for Apply Changes (forceRegenerate=true)');
        } catch(e) {}
      } else {
        log('OF Stats: Preserving chart caches (forceRegenerate=false)');
      }
    } else {
      // Re-read from localStorage
      try {
        const cached = localStorage.getItem('ofStatsCache');
        if (cached) {
          cachedSettings = JSON.parse(cached);
        }
      } catch(e) {}
    }
    
    // Reset the applied flag so we can re-apply
    var wrapper = findEarningsWrapper();
    if (wrapper) {
      // Remove old generated elements
      wrapper.querySelectorAll('[data-of-stats-generated]').forEach(function(el) {
        el.remove();
      });
      wrapper.removeAttribute('data-of-stats-applied');
    }
    
    // Also reset Earnings section processed flag
    document.querySelectorAll('.b-useful-data[data-of-stats-processed]').forEach(function(el) {
      el.removeAttribute('data-of-stats-processed');
    });
    document.querySelectorAll('[data-of-stats-earnings-generated]').forEach(function(el) {
      el.remove();
    });
    
    // Remove hiding style if present
    var hideStyle = document.getElementById('of-stats-hide-earnings-content');
    if (hideStyle) hideStyle.remove();
    
    // Apply the page
    applyStatisticsEarningsPage();
  };

  // Get or generate Earnings breakdown (Total, Tips, Messages) with caching
  // Cache is tied to Gross value so it updates when Gross changes
  // percentChange is the already calculated change from the main display
  function getOrGenerateEarningsBreakdown(totalNet, totalGross, percentChange) {
    var cacheKey = 'ofStatsEarningsBreakdownCache';
    var grossKey = 'ofStatsChartGrossValue'; // Use same key as charts!
    
    // Round values for stable comparison
    var roundedNet = Math.round(totalNet * 100) / 100;
    var roundedGross = Math.round(totalGross * 100) / 100;
    
    try {
      var cachedData = localStorage.getItem(cacheKey);
      var cachedGross = localStorage.getItem(grossKey);
      
      // Use cache if Gross hasn't changed (same key as main charts)
      if (cachedData && cachedGross) {
        var cachedGrossRounded = Math.round(parseFloat(cachedGross) * 100) / 100;
        if (cachedGrossRounded === roundedGross) {
          var parsed = JSON.parse(cachedData);
          // Verify cached data has correct Total (matches current Net)
          if (parsed.total && Math.round(parsed.total.amount * 100) / 100 === roundedNet) {
            log('OF Stats: Using cached Earnings breakdown (Gross unchanged: $' + roundedGross.toFixed(2) + ')');
            return parsed;
          }
        }
      }
    } catch (e) {
      log('OF Stats: Cannot access localStorage for earnings breakdown cache');
    }
    
    log('OF Stats: Generating new Earnings breakdown for Net $' + roundedNet.toFixed(2) + ' (Gross: $' + roundedGross.toFixed(2) + ')');
    
    // Generate random split between Tips and Messages (40%-60% each way)
    var tipsPercent = 0.40 + Math.random() * 0.20; // 40% to 60%
    var tipsAmount = totalNet * tipsPercent;
    var messagesAmount = totalNet - tipsAmount;
    
    // Use the passed percentChange for Total, add variation for Tips and Messages
    var totalChange = percentChange || { value: 0, isIncrease: false };
    var tipsChange = { value: 0, isIncrease: false };
    var messagesChange = { value: 0, isIncrease: false };
    
    if (totalChange.value > 0) {
      // Calculate signed percent value
      var signedPercent = totalChange.isIncrease ? totalChange.value : -totalChange.value;
      
      // Tips and Messages changes (add some variation from the base)
      var tipsPctChange = signedPercent + (Math.random() * 30 - 15); // В±15% variation
      var messagesPctChange = signedPercent + (Math.random() * 40 - 20); // В±20% variation
      
      tipsChange = { value: Math.abs(tipsPctChange), isIncrease: tipsPctChange >= 0 };
      messagesChange = { value: Math.abs(messagesPctChange), isIncrease: messagesPctChange >= 0 };
    } else {
      // Generate random changes if no base percentage
      var randomTipsChange = (Math.random() * 60 - 30); // -30% to +30%
      var randomMessagesChange = (Math.random() * 80 - 40); // -40% to +40%
      
      tipsChange = { value: Math.abs(randomTipsChange), isIncrease: randomTipsChange >= 0 };
      messagesChange = { value: Math.abs(randomMessagesChange), isIncrease: randomMessagesChange >= 0 };
    }
    
    // Generate mini chart data and include in breakdown
    var miniChartsData = {
      total: generateMiniChartData(30, totalChange.isIncrease),
      tips: generateMiniChartData(30, tipsChange.isIncrease),
      messages: generateMiniChartData(30, messagesChange.isIncrease)
    };
    
    var breakdown = {
      total: { amount: roundedNet, change: totalChange },
      tips: { amount: Math.round(tipsAmount * 100) / 100, change: tipsChange },
      messages: { amount: Math.round(messagesAmount * 100) / 100, change: messagesChange },
      miniCharts: miniChartsData
    };
    
    // Save to cache (earnings breakdown saved separately, gross key shared with charts)
    try {
      localStorage.setItem(cacheKey, JSON.stringify(breakdown));
      log('OF Stats: Earnings breakdown cached for Net $' + roundedNet.toFixed(2));
    } catch (e) {
      log('OF Stats: Cannot save earnings breakdown to cache');
    }
    
    return breakdown;
  }
  
  
  
  
  // Generate the rows HTML (reusable)
  function generateEarningsRowsHTML(breakdown) {
    function getChangeHTML(change) {
      var iconName = change.isIncrease ? 'icon-increase' : 'icon-decrease';
      var levelClass = change.isIncrease ? 'm-level-up' : 'm-level-down';
      var sign = change.isIncrease ? '' : '-';
      return '<span class="b-statistics-level ' + levelClass + '">' +
        '<svg class="g-icon" data-icon-name="' + iconName + '" aria-hidden="true">' +
        '<use href="#' + iconName + '" xlink:href="#' + iconName + '"></use></svg> ' + 
        sign + change.value.toFixed(1) + '% </span>';
    }
    
    var rlang = getPageLanguage();
    var lTotal = rlang === 'ru' ? 'Итого' : rlang === 'es' ? 'Total' : rlang === 'de' ? 'Gesamt' : 'Total';
    var lTips = rlang === 'ru' ? 'Чаевые' : rlang === 'es' ? 'Propinas' : rlang === 'de' ? 'Trinkgelder' : 'Tips';
    var lMessages = rlang === 'ru' ? 'Сообщения' : rlang === 'es' ? 'Mensajes' : rlang === 'de' ? 'Nachrichten' : 'Messages';

    return '' +
        // Total
        '<div class="b-elements-determinant g-pointer-cursor m-rows-charts">' +
          '<div class="b-elements-determinant__unit">' +
            '<div class="b-elements-determinant__label"> ' + lTotal + ' </div>' +
            '<div class="b-elements-determinant__value">' +
              '<span class=""> $' + formatCurrency(breakdown.total.amount) + ' </span>' +
              getChangeHTML(breakdown.total.change) +
            '</div>' +
          '</div>' +
          '<div class="b-elements-determinant__unit m-chart">' +
            '<div class="b-chart-wrapper m-chart-stat">' +
              '<canvas id="of-stats-earnings-total-chart" style="display: block; box-sizing: border-box; height: 50px; width: 132px;" width="132" height="50"></canvas>' +
            '</div>' +
          '</div>' +
        '</div>' +
        // Tips
        '<div class="b-elements-determinant g-pointer-cursor m-rows-charts">' +
          '<div class="b-elements-determinant__unit">' +
            '<div class="b-elements-determinant__label"> ' + lTips + ' </div>' +
            '<div class="b-elements-determinant__value">' +
              '<span class=""> $' + formatCurrency(breakdown.tips.amount) + ' </span>' +
              getChangeHTML(breakdown.tips.change) +
            '</div>' +
          '</div>' +
          '<div class="b-elements-determinant__unit m-chart">' +
            '<div class="b-chart-wrapper m-chart-stat">' +
              '<canvas id="of-stats-earnings-tips-chart" style="display: block; box-sizing: border-box; height: 50px; width: 132px;" width="132" height="50"></canvas>' +
            '</div>' +
          '</div>' +
        '</div>' +
        // Messages
        '<div class="b-elements-determinant g-pointer-cursor m-rows-charts">' +
          '<div class="b-elements-determinant__unit">' +
            '<div class="b-elements-determinant__label"> ' + lMessages + ' </div>' +
            '<div class="b-elements-determinant__value">' +
              '<span class=""> $' + formatCurrency(breakdown.messages.amount) + ' </span>' +
              getChangeHTML(breakdown.messages.change) +
            '</div>' +
          '</div>' +
          '<div class="b-elements-determinant__unit m-chart">' +
            '<div class="b-chart-wrapper m-chart-stat">' +
              '<canvas id="of-stats-earnings-messages-chart" style="display: block; box-sizing: border-box; height: 50px; width: 132px;" width="132" height="50"></canvas>' +
            '</div>' +
          '</div>' +
        '</div>';
  }
  
  // Generate mini chart data (30 points with realistic variation and trend)
  function generateMiniChartData(points, isUptrend) {
    var data = [];
    var baseValue = 50;
    var trend = isUptrend ? 0.5 : -0.5; // Positive or negative trend
    
    for (var i = 0; i < points; i++) {
      // Add trend component
      var trendComponent = trend * i;
      // Add random variation
      var randomVariation = (Math.random() - 0.5) * 30;
      // Occasional spikes
      if (Math.random() < 0.1) {
        randomVariation += (Math.random() > 0.5 ? 1 : -1) * 20;
      }
      
      var value = baseValue + trendComponent + randomVariation;
      value = Math.max(10, Math.min(90, value)); // Keep within bounds
      data.push(Math.round(value));
    }
    
    return data;
  }
  
  // Draw mini charts with animation (manual canvas drawing)
  // Animation grows from bottom to top like b-chart--no-padding charts
  function drawMiniChartsDirectly(miniChartsData) {
    function drawMiniChart(canvasId, data, color) {
      var canvas = document.getElementById(canvasId);
      if (!canvas) {
        log('OF Stats: Mini chart canvas not found: ' + canvasId);
        return;
      }
      
      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      var width = canvas.width;
      var height = canvas.height;
      
      // Clear canvas
      ctx.clearRect(0, 0, width, height);
      
      if (!data || data.length === 0) return;
      
      // Calculate scales
      var maxVal = Math.max.apply(null, data);
      var minVal = Math.min.apply(null, data);
      var range = maxVal - minVal || 1;
      
      var padding = { left: 2, right: 2, top: 5, bottom: 5 };
      var chartWidth = width - padding.left - padding.right;
      var chartHeight = height - padding.top - padding.bottom;
      var xStep = chartWidth / (data.length - 1);
      
      // Build final points (full amplitude)
      var finalPoints = [];
      var baseY = padding.top + chartHeight; // Bottom of chart
      for (var i = 0; i < data.length; i++) {
        var x = padding.left + i * xStep;
        var y = padding.top + chartHeight * (1 - (data[i] - minVal) / range);
        finalPoints.push({ x: x, y: y, baseY: baseY });
      }
      
      // Animation: grow from bottom to top (like Chart.js y-axis animation)
      var animationDuration = 800; // ms
      var startTime = null;
      
      function animateChart(timestamp) {
        if (!startTime) startTime = timestamp;
        var progress = Math.min((timestamp - startTime) / animationDuration, 1);
        
        // Easing function (easeOutQuart like Chart.js)
        var easedProgress = 1 - Math.pow(1 - progress, 4);
        
        // Clear and redraw
        ctx.clearRect(0, 0, width, height);
        
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'miter'; // Sharp corners
        ctx.lineCap = 'butt';   // Sharp line ends
        ctx.miterLimit = 10;    // Allow sharp angles
        
        // Calculate current points (interpolate Y from baseY to finalY)
        var currentPoints = [];
        for (var i = 0; i < finalPoints.length; i++) {
          var finalY = finalPoints[i].y;
          var baseY = finalPoints[i].baseY;
          // Interpolate from baseY (bottom) to finalY (actual position)
          var currentY = baseY + (finalY - baseY) * easedProgress;
          currentPoints.push({ x: finalPoints[i].x, y: currentY });
        }
        
        // Draw the line
        ctx.moveTo(currentPoints[0].x, currentPoints[0].y);
        for (var j = 1; j < currentPoints.length; j++) {
          ctx.lineTo(currentPoints[j].x, currentPoints[j].y);
        }
        
        ctx.stroke();
        
        if (progress < 1) {
          requestAnimationFrame(animateChart);
        } else {
          log('OF Stats: Drew mini chart ' + canvasId);
        }
      }
      
      requestAnimationFrame(animateChart);
    }
    
    // Colors as specified:
    // Total = #8a96a3 (gray)
    // Tips = #9575cd (purple)
    // Messages = #00aff0 (blue)
    if (miniChartsData.total) {
      drawMiniChart('of-stats-earnings-total-chart', miniChartsData.total, '#8a96a3');
    }
    if (miniChartsData.tips) {
      drawMiniChart('of-stats-earnings-tips-chart', miniChartsData.tips, '#9575cd');
    }
    if (miniChartsData.messages) {
      drawMiniChart('of-stats-earnings-messages-chart', miniChartsData.messages, '#00aff0');
    }
  }

  // Load Chart.js and chart-drawer.js from extension (both are external files, no CSP issues)
  function loadChartJsAndDraw(transactions, grossValue, earningsBreakdown) {
    // Check if we have cached chart data and if Gross hasn't changed
    var cacheKey = 'ofStatsChartDataCache';
    var grossKey = 'ofStatsChartGrossValue';
    var cachedData = null;
    var cachedGross = null;
    
    try {
      cachedData = localStorage.getItem(cacheKey);
      cachedGross = localStorage.getItem(grossKey);
    } catch (e) {
      log('OF Stats: Cannot access localStorage for chart cache');
    }
    
    log('OF Stats Chart Cache Debug: cachedData=' + (cachedData ? 'exists' : 'null') + ', cachedGross=' + cachedGross + ', currentGross=' + grossValue);
    
    // If Gross is the same and we have cached data, use it
    if (cachedData && cachedGross && parseFloat(cachedGross) === grossValue) {
      // If charts already exist and rendered, skip completely
      var existingMainCanvas = document.getElementById('of-stats-earnings-chart-main');
      if (existingMainCanvas && typeof Chart !== 'undefined' && Chart.getChart(existingMainCanvas)) {
        log('OF Stats: Charts already rendered with cached data, skipping');
        return;
      }
      log('OF Stats: Using cached chart data (Gross unchanged: $' + grossValue + ')');
      var chartData = JSON.parse(cachedData);
      loadChartScriptsAndDraw(chartData);
      return;
    }
    
    log('OF Stats: Generating new chart data (Gross changed from $' + cachedGross + ' to $' + grossValue + ')');
    
    // All Time — generate monthly data points from earningStatsData.months
    if (window.ofStatsCurrentPeriod === 'alltime') {
      var allTimeStats = getOrGenerateEarningStatsEarly();
      if (allTimeStats && allTimeStats.months && allTimeStats.months.length > 0) {
        var monthsChron = allTimeStats.months.slice().reverse(); // chronological order
        var atLabels = [];
        var atEarnings = [];
        var atCounts = [];
        var atMonthDates = [];
        var monNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        
        var rawNetTotal = monthsChron.reduce(function(sum, m) { return sum + m.net; }, 0);
        var atScale = rawNetTotal > 0 ? grossValue / rawNetTotal : 1;
        var avgMonthNet = rawNetTotal / monthsChron.length;
        
        // Generate raw earnings with random variation (±30%) per month
        var rawAtEarnings = [];
        monthsChron.forEach(function(m) {
          atLabels.push(monNames[m.month] + ', ' + m.year);
          atMonthDates.push(new Date(m.year, m.month, 1).toISOString());
          var baseValue = m.net * atScale;
          // Random variation: 70% to 130% of base value
          var variation = 0.7 + Math.random() * 0.6;
          rawAtEarnings.push(baseValue * variation);
          // Transaction count proportional to earnings with variation
          var monthFrac = avgMonthNet > 0 ? m.net / avgMonthNet : 1;
          var baseCount = grossValue < 3000 ? 80 : grossValue < 10000 ? 200 : 400;
          atCounts.push(Math.max(5, Math.round(baseCount * monthFrac * (0.6 + Math.random() * 0.8))));
        });
        
        // Normalize so sum = grossValue
        var rawAtSum = rawAtEarnings.reduce(function(a, b) { return a + b; }, 0);
        var normFactor = rawAtSum > 0 ? grossValue / rawAtSum : 1;
        rawAtEarnings.forEach(function(val) {
          atEarnings.push(Math.round(val * normFactor * 100) / 100);
        });
        
        // Normalize earnings sum to grossValue
        var atSum = atEarnings.reduce(function(a, b) { return a + b; }, 0);
        var atDiff = grossValue - atSum;
        if (Math.abs(atDiff) > 0.01 && atEarnings.length > 0) {
          atEarnings[atEarnings.length - 1] = Math.round((atEarnings[atEarnings.length - 1] + atDiff) * 100) / 100;
        }
        
        var chartData = {
          labels: atLabels,
          earnings: atEarnings,
          counts: atCounts,
          startDate: atMonthDates[0],
          monthlyMode: true,
          monthDates: atMonthDates,
          miniCharts: {
            total: generateMiniChartData(30, earningsBreakdown.total.change.isIncrease),
            tips: generateMiniChartData(30, earningsBreakdown.tips.change.isIncrease),
            messages: generateMiniChartData(30, earningsBreakdown.messages.change.isIncrease)
          }
        };
        
        try {
          localStorage.setItem(cacheKey, JSON.stringify(chartData));
          localStorage.setItem(grossKey, grossValue.toString());
        } catch (e) {}
        
        loadChartScriptsAndDraw(chartData);
        return;
      }
    }
    
    // Prepare chart data - generate synthetic data for the entire 30-day period
    // This ensures the chart starts from day 1, not just where transactions exist
    var dailyData = {};
    var now = new Date();
    
    // Initialize all 30 days with base values
    for (var d = 0; d < 30; d++) {
      var dayDate = new Date(now);
      dayDate.setDate(dayDate.getDate() - (29 - d));
      var dayKey = dayDate.getFullYear() + '-' + 
        String(dayDate.getMonth() + 1).padStart(2, '0') + '-' + 
        String(dayDate.getDate()).padStart(2, '0');
      dailyData[dayKey] = { earnings: 0, count: 0, date: dayKey, dayIndex: d };
    }
    
    // Add actual transaction data
    transactions.forEach(function(t) {
      var dayKey = t.date.getFullYear() + '-' + 
        String(t.date.getMonth() + 1).padStart(2, '0') + '-' + 
        String(t.date.getDate()).padStart(2, '0');
      if (dailyData[dayKey]) {
        dailyData[dayKey].earnings += t.net;
        dailyData[dayKey].count += 1;
      }
    });
    
    // Calculate average daily earnings from transaction days
    var totalEarnings = 0;
    var totalCount = 0;
    var daysWithData = 0;
    Object.keys(dailyData).forEach(function(key) {
      if (dailyData[key].earnings > 0) {
        totalEarnings += dailyData[key].earnings;
        totalCount += dailyData[key].count;
        daysWithData++;
      }
    });
    
    var avgDailyEarnings = daysWithData > 0 ? totalEarnings / daysWithData : 150;
    var avgDailyCount = daysWithData > 0 ? totalCount / daysWithData : 5;
    
    // Determine max transactions per day based on Gross value
    // Small Gross (< $3000) в†’ max 20 transactions (scale 10, 20)
    // Medium Gross ($3000-$10000) в†’ max 30 transactions
    // Large Gross (> $10000) в†’ max 40 transactions
    var maxTransactionsPerDay;
    var baseAvgTransactions;
    if (grossValue < 3000) {
      maxTransactionsPerDay = 20;
      baseAvgTransactions = 3 + (grossValue / 3000) * 5; // 3-8 avg for small
    } else if (grossValue < 10000) {
      maxTransactionsPerDay = 30;
      baseAvgTransactions = 8 + ((grossValue - 3000) / 7000) * 7; // 8-15 avg for medium
    } else {
      maxTransactionsPerDay = 40;
      baseAvgTransactions = 15 + Math.min(10, (grossValue - 10000) / 5000 * 5); // 15-25 avg for large
    }
    
    // Use calculated base or actual average, whichever is appropriate
    if (avgDailyCount < baseAvgTransactions * 0.5) {
      avgDailyCount = baseAvgTransactions;
    }
    
    log('OF Stats: Gross $' + grossValue.toFixed(2) + ' в†’ max ' + maxTransactionsPerDay + ' transactions/day, avg target: ' + baseAvgTransactions.toFixed(1));
    
    // Generate realistic data for days without transactions
    // Use a growth pattern - earlier days have less, recent days have more
    Object.keys(dailyData).sort().forEach(function(key) {
      var day = dailyData[key];
      
      if (day.earnings === 0) {
        // Fully randomised distribution — no monotonic growth bias.
        // Earlier code biased recent days higher; users wanted natural noise instead.

        // Base multiplier is uniform random (no trend by day position)
        var growthMultiplier = 0.7 + Math.random() * 0.6; // 70%–130%

        // Add significant random variation (40% to 180% of average)
        var randomVariation = 0.4 + Math.random() * 1.4;

        // Some days are "slow" (20% chance of very low earnings)
        if (Math.random() < 0.2) {
          randomVariation *= 0.3;
        }
        // Some days are "hot" (15% chance of high earnings)
        else if (Math.random() < 0.15) {
          randomVariation *= 1.8;
        }

        day.earnings = avgDailyEarnings * growthMultiplier * randomVariation;

        // Generate transaction count based on Gross level — same random base
        var countVariation = 0.3 + Math.random() * 1.4; // 30% to 170% variation
        day.count = Math.max(1, Math.round(avgDailyCount * growthMultiplier * countVariation));
        
        // Some days have spikes in transactions (10% chance)
        if (Math.random() < 0.1) {
          day.count = Math.round(day.count * (1.5 + Math.random() * 1)); // 1.5x to 2.5x
        }
        // Some days have very few transactions (15% chance)
        else if (Math.random() < 0.15) {
          day.count = Math.max(1, Math.round(day.count * 0.4));
        }
        
        // Cap at max transactions based on Gross
        day.count = Math.min(maxTransactionsPerDay, day.count);
      } else {
        // For days WITH transactions, add more variation to count
        // Randomly adjust count by -30% to +50%
        var countAdjust = 0.7 + Math.random() * 0.8;
        day.count = Math.max(1, Math.round(day.count * countAdjust));
        
        // Occasional spike
        if (Math.random() < 0.12) {
          day.count = Math.round(day.count * (1.3 + Math.random() * 0.7));
        }
        
        // Cap at max transactions based on Gross
        day.count = Math.min(maxTransactionsPerDay, day.count);
      }
    });
    
    var labels = [];
    var earningsData = [];
    var countData = [];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    // First pass: collect raw earnings values
    var rawEarnings = [];
    Object.keys(dailyData).sort().forEach(function(key) {
      var dd = dailyData[key];
      var dt = new Date(dd.date);
      labels.push(months[dt.getMonth()] + ' ' + String(dt.getDate()).padStart(2, '0') + ', ' + dt.getFullYear());
      rawEarnings.push(dd.earnings);
      countData.push(dd.count);
    });
    
    // Normalize earnings so that sum equals grossValue
    var rawSum = rawEarnings.reduce(function(a, b) { return a + b; }, 0);
    var scaleFactor = rawSum > 0 ? grossValue / rawSum : 1;
    
    rawEarnings.forEach(function(val) {
      earningsData.push(Math.round(val * scaleFactor * 100) / 100);
    });
    
    // Verify the sum matches Gross (with small rounding adjustment if needed)
    var finalSum = earningsData.reduce(function(a, b) { return a + b; }, 0);
    var diff = grossValue - finalSum;
    if (Math.abs(diff) > 0.01 && earningsData.length > 0) {
      // Add the difference to the last day to ensure exact match
      earningsData[earningsData.length - 1] = Math.round((earningsData[earningsData.length - 1] + diff) * 100) / 100;
    }
    
    // Get start date (30 days ago)
    var startDateObj = new Date(now);
    startDateObj.setDate(startDateObj.getDate() - 29);
    
    // Generate mini chart data for Total, Tips, Messages (30 points each)
    var totalMiniData = generateMiniChartData(30, earningsBreakdown.total.change.isIncrease);
    var tipsMiniData = generateMiniChartData(30, earningsBreakdown.tips.change.isIncrease);
    var messagesMiniData = generateMiniChartData(30, earningsBreakdown.messages.change.isIncrease);
    
    var chartData = {
      labels: labels,
      earnings: earningsData,
      counts: countData,
      startDate: startDateObj.toISOString(),
      // Mini charts data for Earnings section
      miniCharts: {
        total: totalMiniData,
        tips: tipsMiniData,
        messages: messagesMiniData
      }
    };
    
    var chartSum = earningsData.reduce(function(a, b) { return a + b; }, 0);
    log('OF Stats: Chart data generated - earnings range: $' + Math.min.apply(null, earningsData).toFixed(2) + ' - $' + Math.max.apply(null, earningsData).toFixed(2) + ', SUM: $' + chartSum.toFixed(2) + ' (Gross: $' + grossValue.toFixed(2) + '), transactions range: ' + Math.min.apply(null, countData) + ' - ' + Math.max.apply(null, countData));
    
    // Save chart data to cache
    try {
      localStorage.setItem(cacheKey, JSON.stringify(chartData));
      localStorage.setItem(grossKey, grossValue.toString());
      log('OF Stats: Chart data cached with Gross value $' + grossValue);
    } catch (e) {
      log('OF Stats: Cannot save chart data to cache');
    }
    
    // Load scripts and draw
    loadChartScriptsAndDraw(chartData);
  }
  
  // Helper function to load Chart.js scripts and draw charts
  function loadChartScriptsAndDraw(chartData) {
    function dispatchChartEvents(data) {
      window.dispatchEvent(new CustomEvent('of-stats-draw-statistics-charts', {
        detail: data
      }));
      if (data.miniCharts) {
        setTimeout(function() {
          window.dispatchEvent(new CustomEvent('of-stats-draw-mini-charts', {
            detail: data.miniCharts
          }));
        }, 100);
      }
    }
    
    // Check if Chart.js is already loaded
    if (window.Chart) {
      log('OF Stats: Chart.js already loaded, drawing charts');
      dispatchChartEvents(chartData);
      return;
    }
    
    // Prevent multiple simultaneous script loads
    if (window.ofStatsChartScriptsLoading) {
      // Scripts are loading — queue this chartData for when they finish
      window.ofStatsPendingChartData = chartData;
      log('OF Stats: Chart scripts already loading, queued data');
      return;
    }
    window.ofStatsChartScriptsLoading = true;
    
    // Load Chart.js from extension
    var chartScript = document.createElement('script');
    chartScript.src = chrome.runtime.getURL('chart.min.js');
    chartScript.onload = function() {
      log('OF Stats: Chart.js loaded from extension');
      
      // Load chart-drawer.js from extension
      var drawerScript = document.createElement('script');
      drawerScript.src = chrome.runtime.getURL('chart-drawer.js');
      drawerScript.onload = function() {
        log('OF Stats: Chart drawer loaded');
        window.ofStatsChartScriptsLoading = false;
        // Use queued data if available (most recent), otherwise original
        var dataToUse = window.ofStatsPendingChartData || chartData;
        window.ofStatsPendingChartData = null;
        dispatchChartEvents(dataToUse);
      };
      document.head.appendChild(drawerScript);
    };
    chartScript.onerror = function() {
      logError('OF Stats: Failed to load Chart.js');
      window.ofStatsChartScriptsLoading = false;
    };
    document.head.appendChild(chartScript);
  }

  // Preload Chart.js + chart-drawer.js as soon as <head> is available, so by the
  // time SE has data to draw, the scripts are warm and the canvas renders together
  // with the surrounding DOM (no late pop-in below the rest of the page).
  function preloadChartScripts() {
    if (window.Chart || window.ofStatsChartScriptsLoading) return;
    var head = document.head || document.documentElement;
    if (!head) return;
    window.ofStatsChartScriptsLoading = true;
    var chartScript = document.createElement('script');
    chartScript.src = chrome.runtime.getURL('chart.min.js');
    chartScript.onload = function() {
      var drawerScript = document.createElement('script');
      drawerScript.src = chrome.runtime.getURL('chart-drawer.js');
      drawerScript.onload = function() {
        window.ofStatsChartScriptsLoading = false;
        // If anyone queued data while we were loading, drain it now.
        if (window.ofStatsPendingChartData) {
          var data = window.ofStatsPendingChartData;
          window.ofStatsPendingChartData = null;
          window.dispatchEvent(new CustomEvent('of-stats-draw-statistics-charts', { detail: data }));
        }
      };
      head.appendChild(drawerScript);
    };
    chartScript.onerror = function() { window.ofStatsChartScriptsLoading = false; };
    head.appendChild(chartScript);
  }
  if (document.head) {
    preloadChartScripts();
  } else {
    var preloadObs = new MutationObserver(function() {
      if (document.head) { preloadObs.disconnect(); preloadChartScripts(); }
    });
    preloadObs.observe(document.documentElement, { childList: true });
  }

  // Start observing immediately
  observer.observe(document.documentElement, {
    childList: true, 
    subtree: true 
  });
  
  // Also check existing elements periodically during load
  const checkExisting = function() {
    // Proactively cache balance from DOM for later use (when section is collapsed/expanded)
    getCurrentBalanceInteger();
    
    document.querySelectorAll(
      '[class*="balance__value"], [class*="balance_value"], ' +
      '.l-sidebar__user-data__item__count, .b-profile__sections__count, button.b-profile__sections__item'
    ).forEach(replaceContent);
    
    // Activate withdrawal button
    document.querySelectorAll('button').forEach(function(btn) {
      if (isWithdrawalButton(btn.textContent)) {
        activateWithdrawButton(btn);
      }
    });
    
    // Update Top Creators percentage
    updateTopCreatorsBanner();
    
    // Apply earnings generation
    applyEarningsEarly();
    
    // Apply earning stats page elements immediately
    if (isEarningStatsPage()) {
      // Replace category values
      document.querySelectorAll('.b-stats-row__val, .b-stats-row__total-net span').forEach(replaceContent);
      // Apply monthly earnings
      applyMonthlyEarningsEarly();
      // Apply chart
      applyChartEarly();
    }
    
    // Apply earning stats page (full version with click handlers etc)
    applyEarningStats();
    
    // Apply statistics/statements/earnings page - but only if not disabled by Reset
    try {
      if (localStorage.getItem('ofStatsStatisticsChartDisabled') !== 'true') {
        applyStatisticsEarningsPage();
      }
    } catch(e) {
      applyStatisticsEarningsPage();
    }
  };
  
  // Run checks during page load - more frequently for faster appearance
  checkExisting();
  setTimeout(checkExisting, 10);
  setTimeout(checkExisting, 30);
  setTimeout(checkExisting, 50);
  setTimeout(checkExisting, 100);
  setTimeout(checkExisting, 150);
  setTimeout(checkExisting, 250);
  setTimeout(checkExisting, 400);
  setTimeout(checkExisting, 600);
  setTimeout(checkExisting, 1000);
  setTimeout(checkExisting, 1500);
  setTimeout(checkExisting, 2000);
  setTimeout(checkExisting, 3000);
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkExisting);
  }
  
  // Handle SPA navigation (when user navigates between tabs)
  var lastUrl = window.location.href;
  var urlCheckInterval = setInterval(function() {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      log('OF Stats: URL changed, re-checking elements');

      // Clean up Top Creators blocks from previous page.
      // These are outside Vue's component tree so Vue never removes them.
      ['of-stats-top-creators', 'of-stats-top-creators-rated',
       'of-stats-top-creators-style', 'of-stats-top-creators-rated-style',
       'of-stats-hide-native-top-rated'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.remove();
      });
      
      // Reset flags for earning stats page if we're on it
      if (isEarningStatsPage()) {
        // Reset content ready flag
        var contentContainer = document.querySelector('.b-stats-row__content');
        if (contentContainer) {
          contentContainer.removeAttribute('data-of-stats-ready');
        }
        // Reset months applied flag
        var statsWrap = document.querySelector('.b-stats-wrap');
        if (statsWrap) {
          statsWrap.removeAttribute('data-of-stats-months-applied');
        }
        // Reset modified flags on values
        document.querySelectorAll('[data-of-stats-modified]').forEach(function(el) {
          el.removeAttribute('data-of-stats-modified');
        });
      }
      
      // Handle statistics/statements/earnings page SPA navigation
      if (isStatisticsEarningsPage()) {
        // Check if disabled
        var isDisabled = false;
        try {
          isDisabled = localStorage.getItem('ofStatsStatisticsChartDisabled') === 'true';
        } catch(e) {}
        
        if (!isDisabled) {
          var wrapper = findEarningsWrapper();
          if (wrapper) {
            // DON'T reset the applied flag - just ensure originals are hidden
            // Hide any original elements that may have appeared
            wrapper.querySelectorAll('.b-elements-determinant:not([data-of-stats-generated]):not([data-of-stats-original-hidden])').forEach(function(el) {
              el.setAttribute('data-of-stats-original-hidden', 'true');
              el.style.display = 'none';
            });
            wrapper.querySelectorAll('.b-chart:not([data-of-stats-generated]):not([data-of-stats-original-hidden])').forEach(function(el) {
              el.setAttribute('data-of-stats-original-hidden', 'true');
              el.style.display = 'none';
            });
            // Only hide original transactions table if earnings counts are set
            if (window.ofStatsHasEarningsCounts) {
              wrapper.querySelectorAll('.b-separate-section:not([data-of-stats-generated]):not([data-of-stats-original-hidden])').forEach(function(el) {
                el.setAttribute('data-of-stats-original-hidden', 'true');
                el.style.display = 'none';
              });
            }
            
            // Start/restart observer to catch any future original elements
            startOriginalElementsObserver();
            
            // If our content doesn't exist yet, apply it
            if (!wrapper.getAttribute('data-of-stats-applied')) {
              // Re-add the hiding style if it was removed
              if (!document.getElementById('of-stats-hide-earnings-content')) {
                var hideEarningsStyle = document.createElement('style');
                hideEarningsStyle.id = 'of-stats-hide-earnings-content';
                hideEarningsStyle.textContent = `
                  .b-statistics-page-content__wrapper:not([data-of-stats-subs-active]) .b-useful-data:not([data-of-stats-processed]) .b-statistics-columns,
                  .b-statistics-page-content__wrapper:not([data-of-stats-subs-active]) .b-useful-data:not([data-of-stats-processed]) .b-useful-data__empty {
                    visibility: hidden !important;
                    height: 0 !important;
                    overflow: hidden !important;
                  }
                  .b-statistics-page-content__wrapper:not([data-of-stats-subs-active]) .b-useful-data[data-of-stats-processed] > *:not(.b-useful-data__header):not([data-of-stats-earnings-generated]) {
                    display: none !important;
                  }
                  .b-statistics-page-content__wrapper[data-of-stats-applied]:not([data-of-stats-subs-active]) .b-elements-determinant:not([data-of-stats-generated]),
                  .b-statistics-page-content__wrapper[data-of-stats-applied]:not([data-of-stats-subs-active]) .b-chart:not([data-of-stats-generated]) {
                    display: none !important;
                  }
                  [data-of-stats-original-hidden]:not(.b-separate-section) {
                    display: none !important;
                  }
                ` + (window.ofStatsHasEarningsCounts ? `
                  .b-statistics-page-content__wrapper[data-of-stats-applied]:not([data-of-stats-subs-active]) .b-separate-section:not([data-of-stats-generated]),
                  [data-of-stats-original-hidden].b-separate-section {
                    display: none !important;
                  }
                ` : '');
                document.documentElement.appendChild(hideEarningsStyle);
              }
            }
          }
        }
      } else {
        // If navigated away from statistics/statements/earnings page, stop the observer
        stopOriginalElementsObserver();
      }
      
      // Re-run checks
      checkExisting();
      setTimeout(checkExisting, 100);
      setTimeout(checkExisting, 300);
      setTimeout(checkExisting, 500);
      setTimeout(checkExisting, 1000);
    }
  }, 200);

  // ==================================================================
  // FANS / SUBSCRIPTIONS PAGE — custom subscribers count + bottom chart
  // /my/statistics/fans/subscriptions
  // ==================================================================
  (function fansSubscriptionsPageModule() {
    var SERIES_KEY = 'ofStatsCustomSubscribersSeries';
    var CHART_OVERLAY_FLAG = 'data-of-stats-subs-chart';

    function isFansSubsPage() {
      return window.location.pathname.indexOf('/my/statistics/fans/subscriptions') === 0;
    }

    // ---------- Eliminate flash-of-original-chart AND of-old-subscriber-number ----------
    // CSS hides OF's native .b-chart on the subs page. The subscribers value flash
    // is prevented per-element by JS (hideSubsValueImmediate): we mark ONLY the
    // determinant whose label is "Subscribers" with `data-of-stats-subs-pending`,
    // and the CSS rule below hides ONLY that marked element. The other Summary
    // determinants (New subs/Renews, Subscriptions earnings) are never touched —
    // so a late-mounting Summary block can't leave its inner content hidden.
    function installSubsHideStyle() {
      if (document.getElementById('of-stats-subs-hide-style')) return;
      var style = document.createElement('style');
      style.id = 'of-stats-subs-hide-style';
      style.textContent =
        'html[data-of-stats-on-subs-page="true"] .b-statistics-page-content__wrapper .b-chart:not(.of-stats-subs-chart-box) {' +
        '  display: none !important;' +
        '}' +
        '.b-elements-determinant[data-of-stats-subs-pending="true"] {' +
        '  visibility: hidden !important;' +
        '}';
      (document.head || document.documentElement).appendChild(style);
    }

    // Hide only the Subscribers determinant (the one we replace) — leaves all
    // other Summary determinants visible from the moment Vue mounts them.
    // Runs synchronously from the MutationObserver so the hide is set BEFORE
    // the next paint, eliminating the OF-value flash.
    function hideSubsValueImmediate() {
      if (!isFansSubsPage()) return;
      if (getCustomSubs() === null) return;
      var subsDet = findSummaryDeterminantByLabel('subscribers');
      if (!subsDet) return;
      if (subsDet.hasAttribute('data-of-stats-subs-pending')) return; // already pending
      if (subsDet.hasAttribute('data-of-stats-subs-processed')) return; // already processed
      subsDet.setAttribute('data-of-stats-subs-pending', 'true');
    }

    // Reveal the subscribers determinant after applyFromSettings updated its text
    function revealSubsValue(subsDet) {
      if (!subsDet) return;
      subsDet.removeAttribute('data-of-stats-subs-pending');
      subsDet.setAttribute('data-of-stats-subs-processed', 'true');
    }

    // Strip our markers — called when leaving subs page or popup value changes.
    function stripProcessedMarkers() {
      var processed = document.querySelectorAll('[data-of-stats-subs-processed],[data-of-stats-subs-pending]');
      for (var i = 0; i < processed.length; i++) {
        processed[i].removeAttribute('data-of-stats-subs-processed');
        processed[i].removeAttribute('data-of-stats-subs-pending');
      }
    }

    // Mark every existing .b-statistics-page-content__wrapper as subs-active
    // when on subs page. This is the gate that the earnings hide-CSS uses to
    // skip subs wrappers — without this marker the Summary content gets hidden
    // because the wrapper still has stale `data-of-stats-applied` from a prior
    // earnings visit (Vue keep-alive reuses wrappers).
    function markAllWrappersSubsActive() {
      var wrappers = document.querySelectorAll('.b-statistics-page-content__wrapper');
      for (var i = 0; i < wrappers.length; i++) {
        if (!wrappers[i].hasAttribute('data-of-stats-subs-active')) {
          wrappers[i].setAttribute('data-of-stats-subs-active', 'true');
        }
      }
    }

    function clearAllWrappersSubsActive() {
      var wrappers = document.querySelectorAll('.b-statistics-page-content__wrapper[data-of-stats-subs-active]');
      for (var i = 0; i < wrappers.length; i++) {
        wrappers[i].removeAttribute('data-of-stats-subs-active');
      }
    }

    function syncSubsPageFlag() {
      var html = document.documentElement;
      if (!html) return;
      if (isFansSubsPage()) {
        if (html.getAttribute('data-of-stats-on-subs-page') !== 'true') {
          html.setAttribute('data-of-stats-on-subs-page', 'true');
        }
        // CRITICAL: mark every wrapper as subs-active IMMEDIATELY so the earnings
        // hide-CSS (`...[data-of-stats-applied]:not([data-of-stats-subs-active])...`)
        // doesn't strip Summary content while we're on the subs subtab.
        markAllWrappersSubsActive();
        // Override-active is informational (used by the chart-hide rule).
        if (getCustomSubs() !== null) {
          if (html.getAttribute('data-of-stats-subs-override-active') !== 'true') {
            html.setAttribute('data-of-stats-subs-override-active', 'true');
            // Strip markers on transition INTO subs page — re-applies always run
            stripProcessedMarkers();
            // Try to hide ASAP — if Subscribers det already exists from prior visit
            hideSubsValueImmediate();
          }
        } else {
          if (html.hasAttribute('data-of-stats-subs-override-active')) {
            html.removeAttribute('data-of-stats-subs-override-active');
          }
        }
      } else {
        if (html.hasAttribute('data-of-stats-on-subs-page')) {
          html.removeAttribute('data-of-stats-on-subs-page');
        }
        if (html.hasAttribute('data-of-stats-subs-override-active')) {
          html.removeAttribute('data-of-stats-subs-override-active');
        }
        // Strip per-element markers so OF's UI is shown as-is on other pages
        stripProcessedMarkers();
        // Clear subs-active markers so earnings page can apply its hide CSS again
        clearAllWrappersSubsActive();
      }
    }

    // Install the style immediately and sync the flag on every URL change.
    installSubsHideStyle();
    syncSubsPageFlag();

    // Hook history.pushState/replaceState so the flag updates SYNCHRONOUSLY on
    // navigation — eliminates the flash/lag from the 500ms URL polling.
    (function patchHistoryForSubsFlag() {
      if (window._ofStatsSubsHistoryPatched) return;
      window._ofStatsSubsHistoryPatched = true;
      var origPush = history.pushState;
      var origReplace = history.replaceState;
      history.pushState = function () {
        var r = origPush.apply(this, arguments);
        try { syncSubsPageFlag(); } catch (e) {}
        return r;
      };
      history.replaceState = function () {
        var r = origReplace.apply(this, arguments);
        try { syncSubsPageFlag(); } catch (e) {}
        return r;
      };
      window.addEventListener('popstate', function () {
        try { syncSubsPageFlag(); } catch (e) {}
      });
    })();

    // Read subscriber count from popup settings (cachedSettings.subscribersCount).
    // Returns null if not set / not a positive integer — in which case we leave OF's
    // native value alone (no DOM mutation, no chart override).
    function getCustomSubs() {
      try {
        if (!cachedSettings) return null;
        var raw = cachedSettings.subscribersCount;
        if (raw === undefined || raw === null || raw === '') return null;
        var n = parseInt(raw, 10);
        return (isFinite(n) && n > 0) ? n : null;
      } catch (e) { return null; }
    }

    function getCachedSeries() {
      try {
        var raw = localStorage.getItem(SERIES_KEY);
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === 30) return parsed;
      } catch (e) {}
      return null;
    }
    function setCachedSeries(arr) {
      try { localStorage.setItem(SERIES_KEY, JSON.stringify(arr)); } catch (e) {}
    }

    // ---------- DOM finders ----------
    function findSubsItem() {
      // Returns only VISIBLE items — not orphans from Vue keep-alive (display:none ancestors).
      // offsetParent === null means hidden via display:none somewhere in the ancestor chain.
      var nodes = document.querySelectorAll('.b-engagements-summary__item');
      for (var i = 0; i < nodes.length; i++) {
        var span = nodes[i].querySelector('span.m-capitalize');
        if (span && /^\s*subscribers\s*$/i.test(span.textContent || '') && document.body.contains(nodes[i])
            && nodes[i].offsetParent !== null) {
          return nodes[i];
        }
      }
      return null;
    }

    // ---------- Apply custom subscribers count to DOM ----------
    function applyCountToDOM(item, n) {
      if (!item) return;
      var formatted = ' ' + n.toLocaleString('en-US') + ' ';
      var changed = false;
      for (var i = 0; i < item.childNodes.length; i++) {
        var node = item.childNodes[i];
        if (node.nodeType === Node.TEXT_NODE && /\d/.test(node.nodeValue)) {
          node.nodeValue = formatted;
          changed = true;
          break;
        }
      }
      if (!changed) {
        var span = item.querySelector('span.m-capitalize');
        if (span) item.insertBefore(document.createTextNode(formatted), span);
      }
    }

    function readDomCount(item) {
      if (!item) return null;
      for (var i = 0; i < item.childNodes.length; i++) {
        var n = item.childNodes[i];
        if (n.nodeType === Node.TEXT_NODE) {
          var m = (n.nodeValue || '').match(/\d[\d,\.\s]*/);
          if (m) return parseInt(m[0].replace(/[,\s]/g, ''), 10);
        }
      }
      return null;
    }

    // ---------- Generate random daily series summing to `total` ----------
    function generateDailySeries(total, days) {
      days = days || 30;
      if (!total || total < 1) return new Array(days).fill(0);
      var raw = [];
      var rawSum = 0;
      for (var i = 0; i < days; i++) {
        var base = 0.7 + Math.random() * 0.6;        // 70%–130% uniform
        if (Math.random() < 0.18) base *= 0.3;       // slow day
        else if (Math.random() < 0.12) base *= 1.9;  // hot day
        raw.push(base);
        rawSum += base;
      }
      var scale = rawSum > 0 ? (total / rawSum) : 0;
      var out = raw.map(function (v) { return Math.max(0, Math.round(v * scale)); });
      var sum = out.reduce(function (a, b) { return a + b; }, 0);
      var diff = total - sum;
      if (diff !== 0) out[out.length - 1] = Math.max(0, out[out.length - 1] + diff);
      return out;
    }

    // ---------- Replace OF's chart container with SE's own structure ----------
    // Same pattern as /my/statistics/statements/earnings page: kill OF's chart entirely,
    // build our own HTML with canvases that have SE IDs, then let chart-drawer.js (loaded
    // via loadChartScriptsAndDraw in page context) render with Chart.js.
    function lang() {
      try { return (document.documentElement.lang || 'en').toLowerCase().slice(0, 2); } catch (e) { return 'en'; }
    }
    function tEarnings() {
      var l = lang();
      return l === 'ru' ? 'Заработок' : l === 'es' ? 'Ganancias' : l === 'de' ? 'Verdienst' : 'Earnings';
    }
    function tSubscribers() {
      var l = lang();
      return l === 'ru' ? 'Подписчики' : l === 'es' ? 'Suscriptores' : l === 'de' ? 'Abonnenten' : 'Subscribers';
    }

    // Find the subs-page-scoped .b-chart container. Uses `.closest` to pin to the
    // SAME route wrapper as the subs item, then queries within. Also marks the wrapper
    // with `data-of-stats-subs-active` so earnings-page logic (via findEarningsWrapper)
    // skips it when both DOMs co-exist under Vue keep-alive.
    function findChartContainer() {
      var subsItem = findSubsItem();
      if (!subsItem) return null;
      var wrapper = subsItem.closest('.b-statistics-page-content__wrapper')
                 || subsItem.closest('.b-statistics-page-content')
                 || subsItem.closest('.l-main-wrapper');
      if (!wrapper) return null;
      // Mark this wrapper so earnings logic ignores it
      if (wrapper.classList && wrapper.classList.contains('b-statistics-page-content__wrapper')) {
        if (!wrapper.hasAttribute('data-of-stats-subs-active')) {
          wrapper.setAttribute('data-of-stats-subs-active', 'true');
        }
      }
      return wrapper.querySelector('.b-chart');
    }

    function buildSEChartHTML() {
      var earningsLabel = tEarnings();
      var subscribersLabel = tSubscribers();
      // Reuse the SAME canvas IDs as earnings page so the existing chart-drawer.js
      // (well-tested) handles rendering. Vue does NOT keep-alive these pages — the DOMs
      // never coexist, so shared IDs are safe. Earnings cleanup runs only on earnings URL,
      // so our subs container (with `.of-stats-subs-chart-box` class and our own marker)
      // is never touched while we're on the subs page.
      // Subs page uses its OWN canvas IDs to avoid conflict with earnings page
      // when Vue keep-alive holds both DOMs alive simultaneously. Earnings keeps
      // `of-stats-earnings-chart-*`, subs uses `of-stats-subs-chart-*`. The chart-drawer
      // event accepts `mainCanvasId` / `asideCanvasId` overrides for this reason.
      return '<div class="b-chart__wrapper" style="position: relative; width: 100%; height: 112px;">' +
        '<canvas height="196" class="b-chart__double-line__main" style="display: block; box-sizing: border-box; height: 112px; width: 100%;" id="of-stats-subs-chart-main"></canvas>' +
        '<div class="b-chart__tooltip of-stats-tooltip" id="of-stats-subs-chart-tooltip" style="opacity: 0; left: 0px; top: 4.5px; width: 156px;">' +
          '<div class="b-chart__tooltip__title">&nbsp;</div>' +
          '<div class="b-chart__tooltip__text">' +
            '<div class="b-chart__tooltip__circle" style="background: rgb(0, 175, 240);"></div>' +
            '<div class="b-chart__tooltip__text__title"> ' + earningsLabel + ' </div>' +
            '<div class="b-chart__tooltip__text__value"> $0.00 </div>' +
          '</div>' +
          '<div class="b-chart__tooltip__text">' +
            '<div class="b-chart__tooltip__circle" style="background: rgb(138, 150, 163);"></div>' +
            '<div class="b-chart__tooltip__text__title"> ' + subscribersLabel + ' </div>' +
            '<div class="b-chart__tooltip__text__value"> 0 </div>' +
          '</div>' +
        '</div>' +
        '</div>' +
        '<div class="b-chart__wrapper" style="position: relative; width: 100%; height: 90px;">' +
        '<canvas height="160" class="b-chart__double-line__aside" style="display: block; box-sizing: border-box; height: 90px; width: 100%;" id="of-stats-subs-chart-aside"></canvas>' +
        '</div>';
    }

    // SUBS-SPECIFIC marker — different from earnings page's `data-of-stats-generated`.
    var SUBS_GEN_ATTR = 'data-of-stats-subs-generated';
    // Use a separate container class that does NOT match earnings logic's `.b-chart` queries.
    // Earnings logic hides/removes any `.b-chart` element via display:none / remove(). Our
    // container uses `of-stats-subs-chart-box` instead so it's never targeted.
    var SUBS_BOX_CLASS = 'of-stats-subs-chart-box';

    // Find the stable subs page route container — survives earnings cleanup
    function findSubsRouteRoot() {
      var subsItem = findSubsItem();
      if (!subsItem) return null;
      var wrapper = subsItem.closest('.b-statistics-page-content__wrapper')
                 || subsItem.closest('.b-statistics-page-content');
      if (!wrapper) return null;
      // Mark for earnings logic isolation
      if (wrapper.classList && wrapper.classList.contains('b-statistics-page-content__wrapper')) {
        if (!wrapper.hasAttribute('data-of-stats-subs-active')) {
          wrapper.setAttribute('data-of-stats-subs-active', 'true');
        }
      }
      return wrapper;
    }

    function ensureSEChartContainer(forceFresh) {
      var root = findSubsRouteRoot();
      if (!root) return null;

      // Try to find our existing SE box anywhere within the subs route
      var ourBox = root.querySelector('.' + SUBS_BOX_CLASS);

      // Always hide OF's native .b-chart in this subtree (avoid double-render)
      root.querySelectorAll('.b-chart').forEach(function (c) {
        if (!c.classList.contains(SUBS_BOX_CLASS) && c.style.display !== 'none') {
          c.style.display = 'none';
        }
      });

      // Reuse existing box if it's healthy and we're not forcing refresh
      if (ourBox && !forceFresh && ourBox.querySelector('canvas')) return ourBox;

      // Refresh existing box content (forceFresh, or box exists but lost its canvases)
      if (ourBox) {
        ourBox.innerHTML = buildSEChartHTML();
        return ourBox;
      }

      // Create our box fresh. Anchor it next to OF's .b-chart if available,
      // otherwise append to the subs content area as a fallback.
      ourBox = document.createElement('div');
      ourBox.className = SUBS_BOX_CLASS;
      ourBox.setAttribute(SUBS_GEN_ATTR, 'true');
      ourBox.style.cssText = 'margin-top: 5px;';
      ourBox.innerHTML = buildSEChartHTML();

      var ofBox = root.querySelector('.b-chart');
      if (ofBox && ofBox.parentNode) {
        ofBox.parentNode.insertBefore(ourBox, ofBox.nextSibling);
      } else {
        // No OF .b-chart left — append to a stable subs content area
        var content = root.querySelector('.b-statistics-page-content') || root;
        content.appendChild(ourBox);
      }
      return ourBox;
    }

    function renderChart(_unused, data, forceFresh) {
      if (!data) return false;
      var container = ensureSEChartContainer(!!forceFresh);
      if (!container) return false;

      // Build labels — 30 days ending today
      var labels = [];
      var now = new Date();
      var monNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      for (var i = 29; i >= 0; i--) {
        var d = new Date(now); d.setDate(d.getDate() - i);
        labels.push(monNames[d.getMonth()] + ' ' + String(d.getDate()).padStart(2, '0') + ', ' + d.getFullYear());
      }

      var startDate = new Date(now); startDate.setDate(startDate.getDate() - 29);
      var chartData = {
        labels: labels,
        earnings: new Array(30).fill(0),
        counts: data,
        startDate: startDate.toISOString(),
        // Override canvas IDs so chart-drawer renders into subs-specific canvases.
        // Earnings page omits these and falls back to its default IDs.
        mainCanvasId: 'of-stats-subs-chart-main',
        asideCanvasId: 'of-stats-subs-chart-aside',
        tooltipId: 'of-stats-subs-chart-tooltip'
      };

      // Use the shared earnings-page chart loader. With unique canvas IDs above,
      // there is NO conflict even when Vue keep-alive holds both DOMs alive.
      try {
        loadChartScriptsAndDraw(chartData);
      } catch (e) { return false; }

      var asideCanvas = document.getElementById('of-stats-subs-chart-aside');
      if (asideCanvas) asideCanvas.setAttribute(CHART_OVERLAY_FLAG, 'true');
      return true;
    }

    function redrawChart(count, regenerate) {
      // Don't gate on findBottomCanvas — ensureSEChartContainer creates the canvas
      // if absent, so we need to call it even when no canvas exists yet (first visit).
      var data;
      if (regenerate) {
        data = generateDailySeries(count, 30);
        setCachedSeries(data);
      } else {
        data = getCachedSeries();
        if (!data) {
          data = generateDailySeries(count, 30);
          setCachedSeries(data);
        }
      }
      // forceFresh on regenerate so canvases are recreated (no Chart.js ghost from old data)
      return renderChart(null, data, !!regenerate);
    }

    // ---------- Summary block sync ----------
    // Random pct and renews ratio are CACHED per applied value — they don't re-randomize
    // on every MutationObserver tick. Regenerated only when user applies a new value.
    var PCT_KEY = 'ofStatsCustomSubsPct';
    var RENEWS_KEY = 'ofStatsCustomSubsRenews';

    function getCachedPct() {
      try { var v = localStorage.getItem(PCT_KEY); return v === null ? null : parseFloat(v); } catch (e) { return null; }
    }
    function setCachedPct(v) { try { localStorage.setItem(PCT_KEY, String(v)); } catch (e) {} }
    function getCachedRenews() {
      try { var v = localStorage.getItem(RENEWS_KEY); return v === null ? null : parseInt(v, 10); } catch (e) { return null; }
    }
    function setCachedRenews(v) { try { localStorage.setItem(RENEWS_KEY, String(v)); } catch (e) {} }

    function regenerateSummaryRandoms(count) {
      // pct between -25 and +25, one decimal
      var pct = Math.round((Math.random() * 50 - 25) * 10) / 10;
      setCachedPct(pct);
      // renews 0% to 40% of count
      var renews = Math.round(count * Math.random() * 0.4);
      setCachedRenews(renews);
    }

    // Find the subs-page subtree root (ancestor that contains both the Subscribers
    // item and the summary block). Used to scope queries away from earnings page DOM.
    function findSubsPageRoot() {
      var subsItem = findSubsItem();
      if (!subsItem) return document;
      var node = subsItem.parentElement;
      var lastWithSummary = null;
      while (node && node !== document.body) {
        if (node.querySelector && node.querySelector('.b-elements-determinant__label')) {
          lastWithSummary = node;
        }
        node = node.parentElement;
      }
      return lastWithSummary || document;
    }

    function findSummaryDeterminantByLabel(text) {
      var root = findSubsPageRoot();
      var nodes = root.querySelectorAll('.b-elements-determinant');
      var needle = (text || '').trim().toLowerCase();
      // First pass: exact match (preferred)
      for (var i = 0; i < nodes.length; i++) {
        var label = nodes[i].querySelector('.b-elements-determinant__label');
        if (label && (label.textContent || '').trim().toLowerCase() === needle) {
          return nodes[i];
        }
      }
      // Second pass: substring match (handles "Active subscribers", "Total subscribers",
      // localized labels with extra words, etc.)
      for (var j = 0; j < nodes.length; j++) {
        var label2 = nodes[j].querySelector('.b-elements-determinant__label');
        if (label2 && (label2.textContent || '').trim().toLowerCase().indexOf(needle) !== -1) {
          return nodes[j];
        }
      }
      return null;
    }

    function syncSummary(count) {
      var pct = getCachedPct();
      var renews = getCachedRenews();
      // Defensive: if cache missing, generate once (e.g. legacy users with cached subs but no pct)
      if (pct === null || renews === null) {
        regenerateSummaryRandoms(count);
        pct = getCachedPct();
        renews = getCachedRenews();
      }
      // Clamp renews to <= count (safety against stale cache when value shrinks)
      if (renews > count) renews = Math.round(count * 0.2);

      // --- Subscribers value + pct chip ---
      var subsDet = findSummaryDeterminantByLabel('subscribers');
      if (subsDet) {
        var valEl = subsDet.querySelector('.b-elements-determinant__value');
        if (valEl) {
          var newText = ' ' + count.toLocaleString('en-US') + ' ';
          var replaced = false;
          for (var i = 0; i < valEl.childNodes.length; i++) {
            var ch = valEl.childNodes[i];
            if (ch.nodeType === Node.TEXT_NODE) {
              if (ch.nodeValue !== newText) ch.nodeValue = newText;
              replaced = true;
              break;
            }
          }
          if (!replaced) valEl.insertBefore(document.createTextNode(newText), valEl.firstChild);

          var chip = valEl.querySelector('.b-statistics-level');
          if (chip) {
            var isUp = pct >= 0;
            var wantClass = isUp ? 'm-level-up' : 'm-level-down';
            var hasUp = chip.classList.contains('m-level-up');
            var hasDown = chip.classList.contains('m-level-down');
            if (!(isUp && hasUp && !hasDown) && !(!isUp && hasDown && !hasUp)) {
              chip.classList.remove('m-level-up', 'm-level-down');
              chip.classList.add(wantClass);
            }
            var iconName = isUp ? 'icon-increase' : 'icon-decrease';
            var desiredHTML = '<svg class="g-icon" data-icon-name="' + iconName + '" aria-hidden="true"><use href="#' + iconName + '" xlink:href="#' + iconName + '"></use></svg> ' +
              (isUp ? '+' : '') + pct.toFixed(1) + '% ';
            if (chip.innerHTML !== desiredHTML) chip.innerHTML = desiredHTML;
          }
        }
      }

      // --- New subs / Renews split ---
      var renewsDet = findSummaryDeterminantByLabel('new subs/renews') || findSummaryDeterminantByLabel('новые/продления');
      if (renewsDet) {
        var renewsVal = renewsDet.querySelector('.b-elements-determinant__value');
        if (renewsVal) {
          var newSubs = count - renews;
          var splitText = ' ' + newSubs.toLocaleString('en-US') + ' / ' + renews.toLocaleString('en-US') + ' ';
          var replaced2 = false;
          for (var j = 0; j < renewsVal.childNodes.length; j++) {
            var ch2 = renewsVal.childNodes[j];
            if (ch2.nodeType === Node.TEXT_NODE) {
              if (ch2.nodeValue !== splitText) ch2.nodeValue = splitText;
              replaced2 = true;
              break;
            }
          }
          if (!replaced2) renewsVal.insertBefore(document.createTextNode(splitText), renewsVal.firstChild);
        }
      }
    }

    // Helper: is our SE chart container in place AND has live canvas with our flag?
    function isSEChartReady() {
      var root = findSubsRouteRoot();
      if (!root) return false;
      var ourBox = root.querySelector('.' + SUBS_BOX_CLASS);
      if (!ourBox) return false;
      var canvas = ourBox.querySelector('#of-stats-subs-chart-aside');
      return !!(canvas && canvas.getAttribute(CHART_OVERLAY_FLAG) === 'true');
    }

    // Track the count we last drew the chart for, so we know when popup value
    // changed and we need to regenerate the daily series (vs reuse the cache).
    var lastAppliedCount = null;

    // Apply the popup value to DOM + chart + summary. Idempotent: if value matches
    // what we already applied AND DOM/chart are intact, this is a no-op.
    // Returns true only after the *determinant* has been updated — that's the
    // user-visible flash, not the optional engagements summary widget.
    function applyFromSettings() {
      if (!isFansSubsPage()) return false;
      var n = getCustomSubs();
      if (n === null) return false;

      // Value changed (popup updated) → regenerate series + summary randoms
      var valueChanged = (lastAppliedCount !== n);
      if (valueChanged) {
        regenerateSummaryRandoms(n);
        lastAppliedCount = n;
      }

      // Engagements summary item is OPTIONAL — only present on some sub-pages.
      // Don't gate the whole apply on its presence (used to cause flash because
      // determinant was never updated until item appeared).
      var item = findSubsItem();
      if (item && readDomCount(item) !== n) applyCountToDOM(item, n);

      // Update the subscriber determinant + the New subs/Renews split, then
      // reveal ONLY the subscribers determinant (which was hidden by us).
      // We never touch other Summary determinants — they stay visible always.
      var subsDet = findSummaryDeterminantByLabel('subscribers');
      if (subsDet) {
        syncSummary(n);
        revealSubsValue(subsDet);
      }

      if (valueChanged || !isSEChartReady()) {
        redrawChart(n, valueChanged);
      }
      return !!subsDet;
    }

    // ---------- Observer: only re-apply CACHED state, fully idempotent ----------
    // Use requestAnimationFrame instead of a setTimeout debounce — apply runs
    // BEFORE the next browser paint, so user never sees OF's value rendered.
    // Idempotent applyFromSettings means we can safely fire on every observer
    // tick; rAF coalesces to at most once per frame.
    var applyScheduled = false;
    function tryApply() {
      if (!isFansSubsPage()) return;
      if (applyScheduled) return;
      applyScheduled = true;
      requestAnimationFrame(function () {
        applyScheduled = false;
        applyFromSettings();
      });
    }

    // Initial + early retries: fire ASAP so override beats OF's first paint.
    [0, 30, 80, 200, 500, 1000, 2000].forEach(function (d) { setTimeout(tryApply, d); });

    // Observer combines: synchronous subs-value hide (no flash window) + rAF apply.
    function observerHandler() {
      if (isFansSubsPage()) {
        // Catch wrappers Vue mounts AFTER syncSubsPageFlag ran — keep them marked
        // so the earnings hide-CSS never matches them on subs page.
        markAllWrappersSubsActive();
      }
      hideSubsValueImmediate();  // sync — runs in same microtask as DOM mutation
      tryApply();                 // rAF-throttled full update
    }

    if (document.body) {
      var mo = new MutationObserver(observerHandler);
      mo.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        var mo = new MutationObserver(observerHandler);
        mo.observe(document.body, { childList: true, subtree: true });
      });
    }

    // URL change detection (SPA navigation) — backup to the history.pushState hook.
    var lastUrl = location.href;
    setInterval(function () {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        syncSubsPageFlag();
        if (isFansSubsPage()) {
          [50, 150, 400, 1000].forEach(function (d) { setTimeout(tryApply, d); });
        }
      }
    }, 250);

    // Safety net: while on subs page, periodically check that DOM + chart still
    // reflect popup value (Vue re-renders / earnings cleanup could wipe them).
    setInterval(function () { applyFromSettings(); }, 800);

    // React to Apply Changes from popup — re-read settings, re-apply immediately.
    // Debounced because popup may fire multiple storage.set calls for each field.
    var storageRenderTimer = null;
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (!changes.ofStatsSettings) return;
        // Pull fresh settings into cachedSettings (the outer module owns it, but
        // we read it directly — outer listener also updates it).
        try {
          var newVal = changes.ofStatsSettings.newValue;
          if (newVal && typeof newVal === 'object') cachedSettings = newVal;
        } catch (e) {}
        // Re-sync the override flag (popup value may have been added/removed)
        // and strip processed markers so the CSS rule re-hides until we re-apply.
        // Also schedule a safety force-stamp in case re-apply misses anything.
        try {
          syncSubsPageFlag();
          stripProcessedMarkers();
          if (isFansSubsPage() && getCustomSubs() !== null) hideSubsValueImmediate();
        } catch (e) {}
        if (storageRenderTimer) clearTimeout(storageRenderTimer);
        storageRenderTimer = setTimeout(function () {
          storageRenderTimer = null;
          // Force a fresh apply: clear lastAppliedCount so series regenerates if
          // the popup value changed.
          lastAppliedCount = null;
          applyFromSettings();
        }, 150);
      });
    } catch (e) {}
  })();
})();
