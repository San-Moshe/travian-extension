/**
 * Travian 3.6 10x Companion - Content Script
 * 
 * This is the core engine that implements all 5 features.
 * Each feature is modular and can be toggled via the popup settings.
 * 
 * DOM SELECTORS - Update these if your server's HTML structure changes
 * Look for comments like "UPDATE THIS SELECTOR" to find potential changes needed
 */

/**
 * === CONTEXT SAFETY HELPERS ===
 */
function t10xIsContextValid() {
  return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
}

/**
 * Check if the current page is an actual Travian game page
 */
function t10xIsTravianGame() {
  const path = window.location.pathname;
  
  // 1. Check for common Travian T3.6 PHP filenames
  const travianPages = [
    'dorf1.php', 'dorf2.php', 'village1.php', 'village2.php', 
    'map.php', 'karte.php', 'build.php', 'spieler.php', 
    'statistiken.php', 'berichte.php', 'nachrichten.php', 
    'allianz.php', 'positions.php', 'ajax.php'
  ];
  
  if (travianPages.some(p => path.includes(p))) return true;
  
  // 2. Check for strong DOM indicators (resource bar, village map, etc)
  const hasResourceBar = !!(
    document.getElementById('res') || 
    document.getElementById('resource_bar') || 
    document.querySelector('.resources') || 
    document.querySelector('#resources')
  );
  
  if (hasResourceBar) return true;

  const hasGameIndicators = !!(
    document.querySelector('.village-name') || 
    document.querySelector('.coords') ||
    document.getElementById('side_info') ||
    document.getElementById('village_map') ||
    document.getElementById('vlist') // Village list
  );

  if (hasGameIndicators) return true;

  // 3. Check for session key in URL or page source
  if (/[?&]k=[a-f0-9]+/i.test(window.location.search) || 
      document.documentElement.innerHTML.match(/[?&]k=([a-f0-9]+)/i)) {
    return true;
  }
  
  return false;
}

/**
 * Remove all T10X UI components from the page
 */
function t10xCleanupUI() {
  const selectors = [
    '.t10x-container',
    '.t10x-side-panel',
    '#t10x-side-panel',
    '#t10x-overflow-panel',
    '#t10x-queue-panel',
    '#t10x-oasis-dashboard',
    '#t10x-protection-panel',
    '#t10x-roi-table',
    '.t10x-radar-results'
  ];
  
  selectors.forEach(selector => {
    document.querySelectorAll(selector).forEach(el => el.remove());
  });
  
  // Stop any active intervals
  if (t10xState.overflowInterval) {
    clearInterval(t10xState.overflowInterval);
    t10xState.overflowInterval = null;
  }
  if (t10xState.queueInterval) {
    clearInterval(t10xState.queueInterval);
    t10xState.queueInterval = null;
  }
  if (t10xState.roiInterval) {
    clearInterval(t10xState.roiInterval);
    t10xState.roiInterval = null;
  }
}

async function t10xGetSettings(keys, defaults) {
  if (!t10xIsContextValid()) {
    return defaults;
  }
  try {
    const res = await chrome.storage.local.get(keys);
    return { ...defaults, ...res };
  } catch (e) {
    return defaults;
  }
}

async function t10xSetSettings(data) {
  if (!t10xIsContextValid()) {
    console.warn('T10X: context invalidated - cannot save settings. Refresh required.');
    return;
  }
  try {
    await chrome.storage.local.set(data);
  } catch (e) {}
}

const T10X_SELECTORS = {
  // === OVERFLOW MONITOR SELECTORS ===
  resourceBar: 'table',
  
  // === QUEUE ALARM SELECTORS ===
  queueTable: 'table',
  
  // === CROP RADAR SELECTORS ===
  mapGrid: '#map, .map-container, #karte .map, #map_content',
  mapTile: '.tile, .map-cell, #karte .tile, area',
  mapTileCoords: '.coord, .tile-coord, [data-x], [data-y]',
  tileType: '.tile-type, .typ, .tile-image',
  tileCrop: '9, 15',
  
  // === ROI CALCULATOR SELECTORS ===
  fieldContainer: '.content > .leaflet, #village_map',
  fieldLevel: '.content > a, #village_map a',
  fieldType: '.content > a, #village_map a',
  fieldCost: '.content > a, #village_map a',

  // === PROTECTION TRACKER SELECTORS ===
  playerProfile: '.content > .player-profile, .content, #profile',
  playerRegDate: '.content, #profile',
  playerPop: '.content, #profile',
  playerName: '.content, #profile'
};

// Configuration
const T10X_CONFIG = {
  overflowWarningThreshold: 85,
  overflowCriticalThreshold: 95,
  overflowCheckInterval: 1000,
  protectionHours: 72,
  costMultiplier: 1.15,
  fieldBaseCosts: {
    wood: { wood: 50, clay: 50, iron: 50, crop: 50 },
    clay: { wood: 65, clay: 50, iron: 50, crop: 50 },
    iron: { wood: 75, clay: 75, iron: 50, crop: 50 },
    crop: { wood: 70, clay: 80, iron: 70, crop: 50 }
  },
  scanConcurrency: 50,
  scanBaseDelay: 10,
  scanJitter: 50,
  scanRestTiles: 1000,
  scanRestDuration: 1000
};

const T10X_ANIMALS = {
  'rat': { name: 'Rat', off: 10, defInf: 25, defCav: 20 },
  'spider': { name: 'Spider', off: 20, defInf: 35, defCav: 40 },
  'snake': { name: 'Snake', off: 60, defInf: 40, defCav: 60 },
  'bat': { name: 'Bat', off: 80, defInf: 66, defCav: 50 },
  'boar': { name: 'Wild Boar', off: 50, defInf: 70, defCav: 33 },
  'wolf': { name: 'Wolf', off: 100, defInf: 80, defCav: 70 },
  'bear': { name: 'Bear', off: 250, defInf: 140, defCav: 200 },
  'crocodile': { name: 'Crocodile', off: 450, defInf: 380, defCav: 240 },
  'tiger': { name: 'Tiger', off: 200, defInf: 170, defCav: 250 },
  'elephant': { name: 'Elephant', off: 600, defInf: 440, defCav: 520 }
};

// Common units for T3.6 (Simplified for calculations)
const T10X_TROOPS = {
  // Romans
  'legionnaire': { name: 'Legionnaire', off: 40, isCav: false },
  'praetorian': { name: 'Praetorian', off: 30, isCav: false },
  'imperian': { name: 'Imperian', off: 70, isCav: false },
  'imperatoris': { name: 'Equites Imperatoris', off: 120, isCav: true },
  'caesaris': { name: 'Equites Caesaris', off: 180, isCav: true },
  // Gauls
  'phalanx': { name: 'Phalanx', off: 15, isCav: false },
  'swordsman': { name: 'Swordsman', off: 65, isCav: false },
  'pathfinder': { name: 'Pathfinder', off: 0, isCav: true },
  'theutates': { name: 'Theutates Thunder', off: 90, isCav: true },
  'druidrider': { name: 'Druidrider', off: 45, isCav: true },
  'haeduan': { name: 'Haeduan', off: 140, isCav: true },
  // Teutons
  'clubswinger': { name: 'Clubswinger', off: 40, isCav: false },
  'spearman': { name: 'Spearman', off: 10, isCav: false },
  'axeman': { name: 'Axeman', off: 60, isCav: false },
  'scout': { name: 'Scout', off: 0, isCav: true },
  'paladin': { name: 'Paladin', off: 55, isCav: true },
  'teutonicknight': { name: 'Teutonic Knight', off: 150, isCav: true }
};

// State
const t10xState = {
  overflowMonitor: true,
  queueAlarm: true,
  cropRadar: true,
  oasisScanner: true,
  scanRadius: 70,
  roiCalculator: true,
  protectionTracker: true,
  roiCalculating: false,
  resources: { wood: 0, clay: 0, iron: 0, crop: 0 },
  production: { wood: 0, clay: 0, iron: 0, crop: 0 }
};

// Listen for settings changes from popup AND background auto-farm engine
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.storage) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!t10xIsContextValid()) return;
    if (area === 'local') {
      for (let [key, { newValue }] of Object.entries(changes)) {
        t10xState[key] = newValue;
        if (key === 'cached_oases') {
          t10xState.cachedOases = newValue;
          if (newValue && newValue.length > 0) t10xShowScannerDashboard(newValue);
          else {
            const dash = document.getElementById('t10x-oasis-dashboard');
            if (dash) dash.remove();
          }
        }
        // === AUTO-FARM REAL-TIME SYNC ===
        if (key === 'active_farm_list') {
          t10xSyncFarmRowHighlights(newValue || []);
        }
        if (key === 'is_autofarming_active') {
          t10xSyncMasterSwitch(newValue);
        }
      }
    }
  });
}

// Global Session Key
let t10xSessionKey = '';

async function t10xInit() {
  // 1. Safety Check: Only run on actual Travian game pages
  if (!t10xIsTravianGame()) {
    t10xCleanupUI();
    return;
  }

  // Capture session key from any link or script
  const kMatch = document.documentElement.innerHTML.match(/[?&]k=([a-f0-9]+)/i);
  if (kMatch) t10xSessionKey = kMatch[1];

  let defaults = { overflowMonitor: true, queueAlarm: true, cropRadar: true, oasisScanner: true, scanRadius: 70, roiCalculator: true, protectionTracker: true };
  const settings = await t10xGetSettings([
    'overflowMonitor',
    'queueAlarm', 
    'cropRadar',
    'oasisScanner',
    'scanRadius',
    'roiCalculator',
    'protectionTracker',
    'cached_oases'
  ], defaults);
  
  if (settings.cached_oases) {
    t10xState.cachedOases = settings.cached_oases;
  }

  t10xState.overflowMonitor = settings.overflowMonitor !== false;
  t10xState.queueAlarm = settings.queueAlarm !== false;
  t10xState.cropRadar = settings.cropRadar !== false;
  t10xState.oasisScanner = settings.oasisScanner !== false;
  t10xState.scanRadius = parseInt(settings.scanRadius) || 70;
  t10xState.roiCalculator = settings.roiCalculator !== false;
  t10xState.protectionTracker = settings.protectionTracker !== false;

  const currentPage = window.location.pathname;

  if (t10xState.overflowMonitor) {
    initOverflowMonitor();
  }

  if (t10xState.queueAlarm && (currentPage.includes('village') || currentPage.includes('dorf'))) {
    initQueueAlarm();
  }

  if (t10xState.cropRadar && currentPage.includes('map.php')) {
    initCropRadar();
  }

  if (t10xState.oasisScanner) {
    initOasisScanner();
    // PERMANENT DASHBOARD: Show on every page if we have data
    if (t10xState.cachedOases && t10xState.cachedOases.length > 0) {
       t10xShowScannerDashboard(t10xState.cachedOases);
    }
  }
  // Detect army when on rally point or dorf1/village1
  if (currentPage.includes('build.php?id=39') || currentPage.includes('dorf1.php') || currentPage.includes('village1.php')) {
    t10xDetectArmy();
  }

  // --- Task Manager Data Scrapers ---
  if (currentPage.includes('village1.php') || currentPage.includes('dorf1.php') || currentPage.includes('village2.php') || currentPage.includes('dorf2.php')) {
    t10xScrapeVillageBuildings();
  }
  
  if (currentPage.includes('build.php')) {
    t10xInjectQueueButtons();
  }
  
  initTaskManagerUI();
  // Initialize ROI Calculator
  if (t10xState.roiCalculator) {
    // Try to load cached fields
    try {
      const cached = localStorage.getItem('t10x-cached-fields');
      if (cached) {
        t10xState.cachedFields = JSON.parse(cached);
      }
    } catch (e) {}
    
    // Always init - if no cached fields, calculateROI will try to find them
    initROICalculator();
  }
  
  if (t10xState.protectionTracker && currentPage.includes('spieler.php')) {
    initProtectionTracker();
  }
}

/**
 * Detect player's offensive army
 */
async function t10xDetectArmy() {
  const army = {};

  // Update this logic based on actual T3.6 HTML structure
  // Usually, troops are in a table with specific images or alt text
  const troopElements = document.querySelectorAll('img.unit, .unit, .unit_img');

  troopElements.forEach(img => {
    const title = (img.getAttribute('title') || img.getAttribute('alt') || '').toLowerCase();
    const parent = img.parentElement;
    const countText = parent ? parent.textContent.match(/(\d+)/) : null;

    if (countText) {
      const count = parseInt(countText[1]);
      // Match title with T10X_TROOPS keys
      for (const key in T10X_TROOPS) {
        if (title.includes(T10X_TROOPS[key].name.toLowerCase())) {
          army[key] = count;
        }
      }
    }
  });

  if (Object.keys(army).length > 0) {
    console.log('T10X: Detected army:', army);
    await t10xSetSettings({ current_offensive_army: army });
  }
}

/**
* Simulate an oasis battle based on T3.6 mechanics
*/
function simulateOasisBattle(attackerArmy, defenderAnimals) {
  if (!attackerArmy || Object.keys(attackerArmy).length === 0) return { win: false, lossPercent: 100, message: 'No army stored' };

  let offInf = 0;
  let offCav = 0;
  let totalAttackerUnits = 0;

  for (const [unitKey, count] of Object.entries(attackerArmy)) {
    const unit = T10X_TROOPS[unitKey];
    if (unit) {
      if (unit.isCav) offCav += unit.off * count;
      else offInf += unit.off * count;
      totalAttackerUnits += count;
    }
  }

  const offTotal = offInf + offCav;
  if (offTotal === 0) return { win: false, lossPercent: 100, message: 'Army has 0 attack' };

  let defInf = 0;
  let defCav = 0;
  let totalDefenderUnits = 0;

  for (const [animalKey, count] of Object.entries(defenderAnimals)) {
    const animal = T10X_ANIMALS[animalKey];
    if (animal) {
      defInf += animal.defInf * count;
      defCav += animal.defCav * count;
      totalDefenderUnits += count;
    }
  }

  // Calculate weighted defense
  const defTotal = (defInf * (offInf / offTotal)) + (defCav * (offCav / offTotal));
  const totalUnits = totalAttackerUnits + totalDefenderUnits;

  // K-Factor calculation
  let k = 1.5;
  if (totalUnits > 1000) {
    k = 2 * (1.8592 - Math.pow(totalUnits, 0.015));
    if (k < 1.2578) k = 1.2578;
    if (k > 1.5) k = 1.5;
  }

  const win = offTotal > defTotal;
  let lossPercent = 0;

  if (win) {
    // Attacker wins
    const x = 100 * Math.pow((defTotal / offTotal), k);
    // Raid formula: 100 * (x / (100 + x))
    lossPercent = 100 * (x / (100 + x));
  } else {
    // Defender wins (Attacker loses everything in simulation for simplicity, or 100% loss)
    lossPercent = 100;
  }

  return {
    win,
    lossPercent: Math.round(lossPercent * 10) / 10,
    offTotal,
    defTotal: Math.round(defTotal)
  };
}


// ============================================================
// FEATURE 1: ZERO-WASTE OVERFLOW MONITOR
// ============================================================

function initOverflowMonitor() {
  const panel = document.createElement('div');
  panel.className = 't10x-container t10x-panel';
  panel.id = 't10x-overflow-panel';
  
  const resources = ['wood', 'clay', 'iron', 'crop'];
  resources.forEach(res => {
    const indicator = document.createElement('div');
    indicator.className = 't10x-resource-indicator t10x-' + res;
    indicator.dataset.resource = res;
    indicator.innerHTML = `
      <div class="t10x-res-row">
        <div class="t10x-resource-icon t10x-${res}"></div>
        <span class="t10x-resource-name">${res.charAt(0).toUpperCase() + res.slice(1)}</span>
        <span class="t10x-percentage">0%</span>
      </div>
      <div class="t10x-time-to-full">--</div>
      <div class="t10x-res-bar-bg"><div class="t10x-res-bar-fill"></div></div>
    `;
    panel.appendChild(indicator);
  });
  
  document.body.appendChild(panel);
  
  t10xState.overflowInterval = setInterval(updateOverflowMonitor, T10X_CONFIG.overflowCheckInterval);
  updateOverflowMonitor();
}

function t10xFormatTimeRemaining(hours, isEmptying = false) {
  if (hours === Infinity || isNaN(hours) || hours > 10000) return '--';
  if (hours <= 0) return isEmptying ? 'EMPTY' : 'FULL';
  
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  
  const prefix = isEmptying ? 'Empty in ' : 'Full in ';
  
  if (h > 999) return prefix + '>999h';
  if (h > 0) return prefix + `${h}h ${m}m`;
  return prefix + `${m}m`;
}

function updateOverflowMonitor() {
  t10xUpdateState();
  const resources = ['wood', 'clay', 'iron', 'crop'];
  
  resources.forEach(res => {
    const indicator = document.querySelector('.t10x-resource-indicator[data-resource="' + res + '"]');
    if (!indicator) return;
    
    const current = t10xState.resources[res];
    const max = t10xState.maxResources[res] || 0;
    const percentage = max > 0 ? Math.floor((current / max) * 100) : 0;
    
    const percentSpan = indicator.querySelector('.t10x-percentage');
    if (percentSpan) {
      percentSpan.textContent = percentage + '%';
    }
    
    // Update Progress Bar
    const barFill = indicator.querySelector('.t10x-res-bar-fill');
    if (barFill) {
      barFill.style.width = Math.min(100, percentage) + '%';
    }
    
    // Calculate Time to Full/Empty
    const timeSpan = indicator.querySelector('.t10x-time-to-full');
    if (timeSpan) {
      const prod = t10xState.production[res] || 0;
      if (prod > 0) {
        const remaining = max - current;
        const hours = remaining / prod;
        timeSpan.textContent = t10xFormatTimeRemaining(hours, false);
      } else if (prod < 0) {
        // Emptying (usually crop)
        const hours = current / Math.abs(prod);
        timeSpan.textContent = t10xFormatTimeRemaining(hours, true);
      } else {
        timeSpan.textContent = '--';
      }
    }
    
    indicator.classList.remove('t10x-warning', 't10x-critical', 't10x-ok');
    if (percentage >= T10X_CONFIG.overflowCriticalThreshold) {
      indicator.classList.add('t10x-critical');
    } else if (percentage >= T10X_CONFIG.overflowWarningThreshold) {
      indicator.classList.add('t10x-warning');
    } else {
      indicator.classList.add('t10x-ok');
    }
  });
}

// Helper to parse numbers like 1.5k, 2M
function t10xParseK(text) {
  if (text === null || text === undefined) return 0;
  text = text.toString().toLowerCase().trim();
  if (!text) return 0;

  let factor = 1;
  if (text.endsWith('k')) { factor = 1000; text = text.slice(0, -1); }
  else if (text.endsWith('m')) { factor = 1000000; text = text.slice(0, -1); }
  else if (text.includes('k')) { factor = 1000; text = text.replace('k', ''); }
  else if (text.includes('m')) { factor = 1000000; text = text.replace('m', ''); }

  // Clean characters: only numbers, dots, and commas
  text = text.replace(/[^0-9.,]/g, '');

  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');
  
  if (lastDot !== -1 && lastComma !== -1) {
    if (lastDot < lastComma) {
      // 1.234,56 -> remove dots, change comma to dot
      text = text.replace(/\./g, '').replace(',', '.');
    } else {
      // 1,234.56 -> remove commas
      text = text.replace(/,/g, '');
    }
  } else if (lastDot !== -1) {
    // 1.234 or 1.23
    const parts = text.split('.');
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
      text = text.replace(/\./g, '');
    }
  } else if (lastComma !== -1) {
    // 1,234 or 1,23
    const parts = text.split(',');
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
      text = text.replace(/,/g, '');
    } else {
      text = text.replace(',', '.');
    }
  }

  const val = parseFloat(text);
  return isNaN(val) ? 0 : Math.floor(val * factor);
}

function t10xUpdateState() {
  // console.log('T10X: Updating state...');
  
  // Ensure objects exist
  if (!t10xState.resources) t10xState.resources = { wood: 0, clay: 0, iron: 0, crop: 0 };
  if (!t10xState.production) t10xState.production = { wood: 0, clay: 0, iron: 0, crop: 0 };
  if (!t10xState.maxResources) t10xState.maxResources = { wood: 800, clay: 800, iron: 800, crop: 800 };

  const resourceNames = ['wood', 'clay', 'iron', 'crop'];

  // 1. Update Resources & Max Resources
  let foundByLIds = false;
  for (let i = 0; i < 4; i++) {
    const el = document.getElementById('l' + (i + 1));
    if (el) {
      const resName = resourceNames[i];
      const text = el.textContent.trim();
      const title = el.getAttribute('title') || '';
      
      // Pattern 1: "Current / Max" in text
      const slashMatch = text.match(/([\d.,km]+)\s*[\/|]\s*([\d.,km]+)(?!%)/i);
      if (slashMatch) {
        t10xState.resources[resName] = t10xParseK(slashMatch[1]);
        t10xState.maxResources[resName] = t10xParseK(slashMatch[2]);
        foundByLIds = true;
      } else {
        // Pattern 2: Current in text, Max in title
        t10xState.resources[resName] = t10xParseK(text);
        const titleMatch = title.match(/([\d.,km]+)(?!%)/);
        if (titleMatch) {
          t10xState.maxResources[resName] = t10xParseK(titleMatch[1]);
          foundByLIds = true;
        }
      }
    }
  }

  if (!foundByLIds) {
    let resourceBar = document.getElementById('res') || document.getElementById('resource_bar') || document.querySelector('.resources') || document.querySelector('#resources');
    
    if (resourceBar) {
      const text = resourceBar.textContent;
      // Look for matches of "current/max"
      const matches = Array.from(text.matchAll(/([\d.,km]+)\s*[\/|]\s*([\d.,km]+)(?!%)/gi));
      if (matches.length >= 4) {
        matches.forEach((match, index) => {
          if (index < 4) {
            const resName = resourceNames[index];
            t10xState.resources[resName] = t10xParseK(match[1]);
            t10xState.maxResources[resName] = t10xParseK(match[2]);
          }
        });
      } else {
        // If not in current/max format, try matching standalone numbers in the bar
        const numbers = text.match(/[\d.,km]+(?!%)/gi) || [];
        for (let i = 0; i < Math.min(numbers.length, 4); i++) {
          t10xState.resources[resourceNames[i]] = t10xParseK(numbers[i]);
        }
      }
    } else {
      // Fallback: search ALL table cells for patterns
      let resFound = 0;
      document.querySelectorAll('td').forEach(td => {
        const t = td.textContent;
        const match = t.match(/([\d.,km]+)\s*[\/|]\s*([\d.,km]+)(?!%)/i);
        if (match && resFound < 4) {
          const resName = resourceNames[resFound];
          t10xState.resources[resName] = t10xParseK(match[1]);
          t10xState.maxResources[resName] = t10xParseK(match[2]);
          resFound++;
        }
      });
    }
  }

  // 2. Update Production Rates
  const allElements = Array.from(document.querySelectorAll('table, div, b, td, span, li'));
  
  const findNumberAfter = (text, keyword) => {
    const regexForward = new RegExp('(?:' + keyword + ')[^0-9,.km]*?([0-9.,km]+)(?!%)', 'i');
    const regexBackward = new RegExp('([0-9.,km]+)(?!%)[^0-9,.km]*?(?:' + keyword + ')', 'i');
    
    let match = text.match(regexForward);
    if (match && match[1]) return t10xParseK(match[1]);
    
    match = text.match(regexBackward);
    if (match && match[1]) return t10xParseK(match[1]);
    
    return null;
  };

  const woodNames = ['wood', 'holz', 'bois', 'legno', 'madera', 'lumber'];
  const clayNames = ['clay', 'lehm', 'terre cuite', 'argilla', 'barro', 'brick'];
  const ironNames = ['iron', 'eisen', 'fer', 'ferro', 'hierro', 'ore'];
  const cropNames = ['crop', 'getreide', 'céréales', 'grano', 'cereales', 'wheat', 'corn'];

  const prodSection = allElements.find(el => {
    const t = el.textContent.toLowerCase();
    return (t.includes('production') || t.includes('produktion') || t.includes('per hour')) && t.length < 500;
  });

  if (prodSection) {
    const text = prodSection.textContent.toLowerCase();
    const w = findNumberAfter(text, woodNames.join('|'));
    const c = findNumberAfter(text, clayNames.join('|'));
    const i = findNumberAfter(text, ironNames.join('|'));
    const cr = findNumberAfter(text, cropNames.join('|'));
    
    if (w !== null && !isNaN(w)) t10xState.production.wood = w;
    if (c !== null && !isNaN(c)) t10xState.production.clay = c;
    if (i !== null && !isNaN(i)) t10xState.production.iron = i;
    if (cr !== null && !isNaN(cr)) t10xState.production.crop = cr;
  }

  // Final Production Fallback
  resourceNames.forEach(res => {
    if (t10xState.production[res] <= 0) {
      const names = res === 'wood' ? woodNames : res === 'clay' ? clayNames : res === 'iron' ? ironNames : cropNames;
      const specificEl = allElements.find(el => {
        const t = el.textContent.toLowerCase();
        return names.some(n => t.includes(n)) && /[0-9.]+[km]?/.test(t) && t.length < 60;
      });
      
      if (specificEl) {
        const val = findNumberAfter(specificEl.textContent.toLowerCase(), names.join('|'));
        if (val !== null && !isNaN(val)) t10xState.production[res] = val;
      }
    }
  });

  // Last resort body scan
  if (t10xState.production.wood === 0) {
    const bodyText = document.body.textContent.toLowerCase();
    resourceNames.forEach(res => {
      if (t10xState.production[res] === 0) {
        const names = res === 'wood' ? woodNames : res === 'clay' ? clayNames : res === 'iron' ? ironNames : cropNames;
        const val = findNumberAfter(bodyText, names.join('|'));
        if (val !== null && !isNaN(val)) t10xState.production[res] = val;
      }
    });
  }
  
  // console.log('T10X: Resources:', t10xState.resources);
  // console.log('T10X: Production:', t10xState.production);
}

// ============================================================
// FEATURE 2: IDLE QUEUE ALARM
// ============================================================

function initQueueAlarm() {
  const queuePanel = document.createElement('div');
  queuePanel.id = 't10x-queue-panel';
  queuePanel.className = 't10x-container t10x-queue-panel';
  queuePanel.innerHTML = '<span class="t10x-queue-status">Queue: Checking...</span>';
  document.body.appendChild(queuePanel);
  
  t10xState.queueInterval = setInterval(updateQueueAlarm, 5000);
  updateQueueAlarm();
}

function updateQueueAlarm() {
  const queuePanel = document.getElementById('t10x-queue-panel');
  if (!queuePanel) return;
  
  // Look for construction queue table by finding any table that mentions "Construction"
  const allTables = document.querySelectorAll('table');
  let queueTable = null;
  for (const table of allTables) {
    if (table.textContent.includes('Construction')) {
      queueTable = table;
      break;
    }
  }
  
  const queueStatus = queuePanel.querySelector('.t10x-queue-status');
  
  if (!queueTable || !queueStatus) return;
  
  const rows = queueTable.querySelectorAll('tr');
  let hasEmptySlot = false;
  const cells = queueTable.querySelectorAll('td');
  for (const cell of cells) {
    if (cell.textContent.trim() === '') {
      hasEmptySlot = true;
      break;
    }
  }
  
  if (rows.length <= 1 || hasEmptySlot) {
    queueStatus.textContent = 'Queue: EMPTY - Build now!';
    queueStatus.classList.add('t10x-queue-empty');
    queueStatus.classList.remove('t10x-queue-active');
    
    if (!t10xState.notifiedQueueEmpty) {
      t10xState.notifiedQueueEmpty = true;
      t10xSendNotification('Queue Empty!', 'Your building queue is empty. Build something!');
    }
  } else {
    queueStatus.textContent = 'Queue: Active (' + (rows.length - 1) + ')';
    queueStatus.classList.add('t10x-queue-active');
    queueStatus.classList.remove('t10x-queue-empty');
    t10xState.notifiedQueueEmpty = false;
  }
}

// ============================================================
// FEATURE 3: 15-CROPPER & OASIS RADAR
// ============================================================

/**
 * Get or create the unified side panel
 */
function t10xGetSidePanel() {
  let panel = document.getElementById('t10x-side-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 't10x-side-panel';
    panel.className = 't10x-side-panel';
    document.body.appendChild(panel);
  }
  return panel;
}

function initCropRadar() {
  const panel = t10xGetSidePanel();
  const radarBtn = document.createElement('button');
  radarBtn.className = 't10x-radar-button t10x-crop-btn';
  radarBtn.textContent = 'Scan for Crop';
  radarBtn.addEventListener('click', scanMapForCroppers);
  
  const existing = document.querySelector('.t10x-crop-btn');
  if (existing) existing.remove();
  
  panel.appendChild(radarBtn);
}

// ============================================================
// FEATURE 6: DEEP MAP OASIS SCANNER
// ============================================================

function initOasisScanner() {
  const panel = t10xGetSidePanel();
  const scannerBtn = document.createElement('button');
  scannerBtn.className = 't10x-radar-button t10x-oasis-btn';
  scannerBtn.textContent = 'Deep Oasis Scan';
  scannerBtn.addEventListener('click', startOasisScan);
  
  const existing = document.querySelector('.t10x-oasis-btn');
  if (existing) existing.remove();
  
  panel.appendChild(scannerBtn);
}

function getSpiralCoordinates(radius, centerX, centerY, step = 7) {
  const coords = [];
  // Jump by step (1 for deep scan, 7 for block scan)
  for (let x = centerX - radius; x <= centerX + radius; x += step) {
    for (let y = centerY - radius; y <= centerY + radius; y += step) {
      // Calculate circular distance to prioritize closer points
      const dist = Math.sqrt(Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2));
      if (dist <= radius) {
        coords.push({ x, y, dist });
      }
    }
  }
  
  // Sort by distance to scan from center outwards
  coords.sort((a, b) => a.dist - b.dist);
  
  return coords;
}

async function startOasisScan() {
  if (!t10xIsContextValid()) {
    alert('Extension was reloaded or updated. Please refresh the page to continue scanning.');
    return;
  }

  // Always get latest radius from storage right before scanning
  const settings = await t10xGetSettings(['scanRadius', 'current_offensive_army'], { scanRadius: 70, current_offensive_army: {} });
  const radius = parseInt(settings.scanRadius) || 70;
  const army = settings.current_offensive_army || {};

  // Get current coordinates from the map or sidebar
  let centerX = 0, centerY = 0;
  const coordText = document.querySelector('#coordinates, .coords, .village-location')?.textContent || document.body.textContent;
  const match = coordText.match(/\((-?\d+)[,\s|]+(-?\d+)\)/);
  if (match) {
    centerX = parseInt(match[1]);
    centerY = parseInt(match[2]);
  }

  if (centerX === 0 && centerY === 0) {
    const urlParams = new URLSearchParams(window.location.search);
    centerX = parseInt(urlParams.get('x')) || 0;
    centerY = parseInt(urlParams.get('y')) || 0;
  }

  // --- PHASE 1: DISCOVERY (Map Blocks) ---
  // We hop through the map in a 7x7 grid to locate 49 tiles at a time
  const blockCoords = getSpiralCoordinates(radius, centerX, centerY, 7);
  const totalBlocks = blockCoords.length;
  let blocksProcessed = 0;
  const discoveredOasisIds = new Set(); 

  t10xShowScannerProgress(0, totalBlocks, 'Phase 1: Discovering Map Blocks...');

  const runDiscoveryWorker = async () => {
    while (blockCoords.length > 0) {
      const coord = blockCoords.shift();
      if (!coord) break;

      const centerId = t10xGetIdFromCoords(coord.x, coord.y);
      try {
        const oasisIds = await fetchOasisIdsFromMapBlockById(centerId);
        oasisIds.forEach(id => discoveredOasisIds.add(id));
      } catch (e) {
        console.warn(`Discovery failed at block ${coord.x}, ${coord.y}`, e);
      }

      blocksProcessed++;
      if (blocksProcessed % 10 === 0 || blocksProcessed === totalBlocks) {
         t10xShowScannerProgress(blocksProcessed, totalBlocks, 'Phase 1: Discovering Map Blocks...');
      }
    }
  };

  const discoveryWorkers = [];
  const discoveryConcurrency = Math.min(T10X_CONFIG.scanConcurrency, 20); // Keep max 20 for map blocks
  for (let i = 0; i < discoveryConcurrency; i++) {
    discoveryWorkers.push(runDiscoveryWorker());
  }
  await Promise.all(discoveryWorkers);

  // Filter and calculate wrapped-distance for the discovered oases to ensure they fall within the scanned radius
  const validOasesQueue = [];
  for (const id of discoveredOasisIds) {
      const coords = t10xGetCoordsFromId(id);
      
      let dx = Math.abs(coords.x - centerX);
      if (dx > 200) dx = 400 - dx;
      
      let dy = Math.abs(coords.y - centerY);
      if (dy > 200) dy = 400 - dy;
      
      const dist = Math.sqrt(dx*dx + dy*dy);
      
      if (dist <= radius) {
          validOasesQueue.push({ id, ...coords, dist });
      }
  }

  // Sort by nearest first
  validOasesQueue.sort((a, b) => a.dist - b.dist);

  // --- PHASE 2: DEEP SCAN (Detected Oases Only) ---
  const totalOases = validOasesQueue.length;
  let oasesProcessed = 0;
  const foundOases = [];
  
  t10xShowScannerProgress(0, totalOases, `Phase 2: Scanning ${totalOases} Oases...`);

  // Worker implementation for parallel processing
  const runDeepWorker = async () => {
    while (validOasesQueue.length > 0) {
      const target = validOasesQueue.shift();
      if (!target) break;

      // Anti-bot jitter delay
      const jitter = Math.random() * T10X_CONFIG.scanJitter;
      if (T10X_CONFIG.scanBaseDelay + jitter > 0) {
         await new Promise(r => setTimeout(r, T10X_CONFIG.scanBaseDelay + jitter));
      }

      // Periodic Micro-Nap for human-like behavior
      if (oasesProcessed > 0 && oasesProcessed % T10X_CONFIG.scanRestTiles === 0) {
        const nap = Math.random() * T10X_CONFIG.scanRestDuration + 1000;
        await new Promise(r => setTimeout(r, nap));
      }

      try {
        const oasis = await fetchOasisFromID(target.id, target.x, target.y);
        if (oasis) {
          oasis.distance = target.dist;
          oasis.simulation = simulateOasisBattle(army, oasis.animals);
          foundOases.push(oasis);
        }
      } catch (e) {
        console.warn('Scan failed for tile', target.id, e);
      }

      oasesProcessed++;
      if (oasesProcessed % 5 === 0 || oasesProcessed === totalOases) {
        t10xShowScannerProgress(oasesProcessed, totalOases, `Phase 2: Scanning ${totalOases} Oases...`);
      }
    }
  };

  const deepConcurrency = parseInt(T10X_CONFIG.scanConcurrency) || 100;
  const deepWorkers = [];
  for (let i = 0; i < deepConcurrency; i++) {
    deepWorkers.push(runDeepWorker());
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 10)); // Stagger
  }

  await Promise.all(deepWorkers);

  // Save results
  t10xState.cachedOases = foundOases;
  await t10xSetSettings({ cached_oases: foundOases });
  
  t10xShowScannerDashboard(foundOases);
  
  if (t10xIsContextValid()) {
    chrome.runtime.sendMessage({ action: 'force_farm_check' });
  }
}

/**
 * Fetch a map block and extract all oasis IDs found within it.
 * Covers 7x7 tiles per request (id based)
 */
async function fetchOasisIdsFromMapBlockById(centerId) {
  const kParam = t10xSessionKey ? `&k=${t10xSessionKey}` : '';
  const url = `map.php?id=${centerId}${kParam}`;
  const found = [];

  try {
    const response = await fetch(url);
    const html = await response.text();
    
    if (!/map_content/i.test(html)) return [];

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    // Select all potential oasis area tags
    const areas = doc.querySelectorAll('area[alt*="Oas"], area[alt*="oas"], area[alt*="Oase"], area[alt*="oase"], area[title*="Oas"], area[title*="oas"], area[title*="Oase"], area[title*="oase"]');
    
    areas.forEach(area => {
      const idStr = area.getAttribute('href')?.match(/id=(\d+)/)?.[1];
      if (idStr) {
        found.push(parseInt(idStr));
      }
    });

    return found;
  } catch (e) {
    return [];
  }
}

/**
 * Reverse calculate map coordinates from unique tile ID
 */
function t10xGetCoordsFromId(id) {
  const mapWidth = 400;
  const zeroBased = id - 1;
  const x_idx = Math.floor(zeroBased / mapWidth);
  const y_idx = zeroBased % mapWidth;
  
  // Convert 0-399 back to -199 to +200 map bounds standard 
  let x = x_idx > 200 ? x_idx - mapWidth : x_idx;
  let y = y_idx > 200 ? y_idx - mapWidth : y_idx;
  
  return {x, y};
}
function t10xGetIdFromCoords(x, y) {
  // Correct pattern for Zravian's 400x400 map
  // Wraps negative coordinates correctly using modulo arithmetic
  const mapWidth = 400;
  const x_idx = ((x % mapWidth) + mapWidth) % mapWidth;
  const y_idx = ((y % mapWidth) + mapWidth) % mapWidth;
  
  return (x_idx * mapWidth) + y_idx + 1;
}

async function fetchOasisFromID(id, x, y) {
  const kParam = t10xSessionKey ? `&k=${t10xSessionKey}` : '';
  const url = `village3.php?id=${id}${kParam}`;
  
  try {
    const response = await fetch(url);
    const html = await response.text();
    
    // FAST REGEX CHECK: Avoid DOMParser overhead for the initial "is it an oasis" validation
    // drastically speeds up scan performance for the thousands of 'empty' tiles
    if (!/unoccupied|oasis|occupied|oase/i.test(html)) return null;
    if (html.match(/player|spieler|clan|alliance/i) && !/unoccupied|unbesetzt/i.test(html)) return null;

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    
    const textContent = doc.body.textContent || '';

    // Detect Oasis Type
    let type = 'Oasis';
    if (/wood|holz|lumber/i.test(textContent)) type = 'Wood Oasis';
    else if (/clay|lehm|brick/i.test(textContent)) type = 'Clay Oasis';
    else if (/iron|eisen|ore/i.test(textContent)) type = 'Iron Oasis';
    else if (/crop|grain|getreide|wheat/i.test(textContent)) type = 'Crop Oasis';

    const animals = {};
    const troopTable = doc.querySelector('table#troop_info');
    if (troopTable) {
      const rows = troopTable.querySelectorAll('tbody tr');
      rows.forEach(row => {
        const img = row.querySelector('img.unit');
        const countCell = row.querySelector('td.val');
        if (img && countCell) {
          const title = (img.getAttribute('title') || img.getAttribute('alt') || '').toLowerCase();
          const count = parseInt(countCell.textContent.replace(/\D/g, '')) || 0;
          for (const key in T10X_ANIMALS) {
            if (title.includes(T10X_ANIMALS[key].name.toLowerCase()) || title.includes(key)) {
              animals[key] = (animals[key] || 0) + count;
            }
          }
        }
      });
    } else {
      // Fallback for older versions or different UI
      const unitImages = doc.querySelectorAll('img.unit, .unit_img, img[class*="unit"]');
      unitImages.forEach(img => {
        const title = (img.getAttribute('title') || img.getAttribute('alt') || '').toLowerCase();
        const row = img.closest('tr');
        if (row) {
          const cells = row.querySelectorAll('td');
          let count = 0;
          cells.forEach(cell => {
            const val = parseInt(cell.textContent.replace(/\D/g, ''));
            if (!isNaN(val) && val > count) count = val;
          });

          for (const key in T10X_ANIMALS) {
            if (title.includes(T10X_ANIMALS[key].name.toLowerCase()) || title.includes(key)) {
              animals[key] = (animals[key] || 0) + count;
            }
          }
        }
      });
    }
    
    return { id, x, y, type, animals };
  } catch (e) {
    console.error(`T10X: Failed to fetch tile ${id}`, e);
    return null;
  }
}

function t10xShowScannerProgress(current, total, phase = 'Scanning Map...') {
  let progress = document.getElementById('t10x-scan-progress');
  if (!progress) {
    progress = document.createElement('div');
    progress.id = 't10x-scan-progress';
    progress.style = 'position:fixed; top:20px; left:50%; transform:translateX(-50%); background:#1a1a2e; border:2px solid #4ecca3; padding:10px 20px; color:#fff; z-index:100000; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.5); font-weight:bold; width: 300px; text-align: center;';
    document.body.appendChild(progress);
  }
  
  if (current >= total && phase.includes('Phase 2')) {
    progress.textContent = 'Scan Complete! Generating Dashboard...';
    setTimeout(() => progress.remove(), 2000);
  } else {
    const percent = Math.round((current / total) * 100);
    progress.innerHTML = `
      <div style="margin-bottom: 5px;">${phase}</div>
      <div style="font-size: 11px; color: #888;">${current} / ${total} items (${percent}%)</div>
      <div style="background: #000; height: 4px; border-radius: 2px; margin-top: 8px;">
        <div style="background: #4ecca3; height: 100%; width: ${percent}%; transition: width 0.3s; border-radius: 2px;"></div>
      </div>
    `;
  }
}

async function t10xShowScannerDashboard(oases) {
  const sidePanel = t10xGetSidePanel();

  // (Bottom panel Auto-Farm control removed per user request)

  // Load auto-farm state from storage
  const farmState = await t10xGetSettings(
    ['is_autofarming_active', 'active_farm_list'],
    { is_autofarming_active: false, active_farm_list: [] }
  );
  const isMasterOn = farmState.is_autofarming_active;
  const farmList = farmState.active_farm_list || [];

  const existing = document.getElementById('t10x-oasis-dashboard');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 't10x-oasis-dashboard';
  panel.className = 't10x-oasis-dashboard';

  // === MASTER SWITCH ===
  const masterDiv = document.createElement('div');
  masterDiv.className = 't10x-master-switch' + (isMasterOn ? ' t10x-master-on' : '');
  masterDiv.id = 't10x-master-switch';

  const masterLabel = document.createElement('span');
  masterLabel.className = 't10x-master-switch-label';
  masterLabel.textContent = 'Auto-Farm';

  const masterStatus = document.createElement('span');
  masterStatus.className = 't10x-master-switch-status';
  masterStatus.id = 't10x-master-status';
  masterStatus.textContent = isMasterOn ? 'ACTIVE' : 'OFF';

  const masterToggle = document.createElement('label');
  masterToggle.className = 't10x-autofarm-toggle';
  const masterInput = document.createElement('input');
  masterInput.type = 'checkbox';
  masterInput.checked = isMasterOn;
  masterInput.id = 't10x-master-input';
  const masterSlider = document.createElement('span');
  masterSlider.className = 't10x-autofarm-slider';
  masterToggle.appendChild(masterInput);
  masterToggle.appendChild(masterSlider);

  masterInput.addEventListener('change', async () => {
    const isOn = masterInput.checked;
    await t10xSetSettings({ is_autofarming_active: isOn });
    const switchEl = document.getElementById('t10x-master-switch');
    const statusEl = document.getElementById('t10x-master-status');
    if (switchEl) switchEl.classList.toggle('t10x-master-on', isOn);
    if (statusEl) statusEl.textContent = isOn ? 'ACTIVE' : 'OFF';
  });

  masterDiv.appendChild(masterLabel);
  masterDiv.appendChild(masterStatus);
  masterDiv.appendChild(masterToggle);
  panel.appendChild(masterDiv);

  // === DASHBOARD HEADER ===
  const headerDiv = document.createElement('div');
  headerDiv.className = 't10x-dashboard-header';
  const headerInner = document.createElement('div');
  headerInner.style.cssText = 'display:flex; justify-content:space-between; align-items:center; width:100%;';
  const h3 = document.createElement('h3');
  h3.textContent = `Oasis Radar (${oases ? oases.length : 0})`;
  const resetBtn = document.createElement('button');
  resetBtn.className = 't10x-refresh-btn';
  resetBtn.textContent = 'Reset';
  resetBtn.addEventListener('click', () => {
    if (t10xIsContextValid()) {
      chrome.storage.local.set({ cached_oases: [] }, () => location.reload());
    }
  });
  headerInner.appendChild(h3);
  headerInner.appendChild(resetBtn);
  headerDiv.appendChild(headerInner);
  panel.appendChild(headerDiv);

  if (!oases || oases.length === 0) {
    const noResults = document.createElement('div');
    noResults.className = 't10x-no-results';
    noResults.innerHTML = 'No oases found in range.<br>Try increasing radius in settings<br>and click "Deep Oasis Scan".';
    panel.appendChild(noResults);
  } else {
    // Sort by priority: 0 animals first, then distance
    oases.sort((a, b) => {
      const aAnimals = Object.values(a.animals || {}).reduce((sum, c) => sum + c, 0);
      const bAnimals = Object.values(b.animals || {}).reduce((sum, c) => sum + c, 0);
      if (aAnimals === 0 && bAnimals > 0) return -1;
      if (bAnimals === 0 && aAnimals > 0) return 1;
      return a.distance - b.distance;
    });

    // Filters
    const filtersDiv = document.createElement('div');
    filtersDiv.className = 't10x-dashboard-filters';
    ['safe', 'near', 'all'].forEach(type => {
      const btn = document.createElement('button');
      btn.textContent = type.charAt(0).toUpperCase() + type.slice(1);
      btn.addEventListener('click', () => window.t10xFilterOases(type));
      filtersDiv.appendChild(btn);
    });

    const enableAllBtn = document.createElement('button');
    enableAllBtn.className = 't10x-enable-all-btn';
    enableAllBtn.textContent = 'Enable All Empty';
    enableAllBtn.title = 'Add all oases with 0 animals to the farm list';
    enableAllBtn.addEventListener('click', () => t10xEnableAllEmptyOases(oases));
    filtersDiv.appendChild(enableAllBtn);

    panel.appendChild(filtersDiv);

    // Table
    const contentDiv = document.createElement('div');
    contentDiv.className = 't10x-dashboard-content';
    const table = document.createElement('table');
    table.className = 't10x-radar-table';

    // Build farm lookup for O(1) access
    const farmLookup = {};
    farmList.forEach(f => { farmLookup[f.coords] = f; });

    // Header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    ['Coords', 'Ani', 'Dist', 'Last', 'Live', 'Fill', 'State', 'Auto'].forEach(col => {
      const th = document.createElement('th');
      th.textContent = col;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    tbody.id = 't10x-oasis-tbody';

    oases.forEach(o => {
      const coordStr = `${o.x}|${o.y}`;
      const animalCount = Object.values(o.animals || {}).reduce((sum, c) => sum + c, 0);
      const lossVal = o.simulation ? o.simulation.lossPercent : 0;
      const lossColor = lossVal > 5 ? '#ff4444' : (lossVal > 0 ? '#ffcc00' : '#4ecca3');
      const animalList = Object.entries(o.animals || {})
        .map(([key, count]) => count > 0 ? `${count} ${key}` : '')
        .filter(s => s !== '').join(', ');

      // Check if this oasis is in the farm list
      const farmEntry = farmLookup[coordStr];
      const isInFarmList = !!farmEntry;
      const farmState = farmEntry ? farmEntry.state : null;

      const tr = document.createElement('tr');
      tr.className = 't10x-oasis-row';
      tr.dataset.animals = animalCount;
      tr.dataset.dist = o.distance;
      tr.dataset.coords = coordStr;
      tr.dataset.tileId = o.id;

      // Apply row highlight based on farm state
      if (isInFarmList) {
        if (farmState === 'paused_animals') tr.classList.add('t10x-row-paused');
        else if (farmState === 'dead') tr.classList.add('t10x-row-dead');
        else tr.classList.add('t10x-row-farming');
      }

      // Coords cell
      const tdCoords = document.createElement('td');
      const coordLink = document.createElement('a');
      coordLink.href = `village3.php?id=${o.id}`;
      coordLink.textContent = coordStr;
      tdCoords.appendChild(coordLink);

      // Animals cell
      const tdAni = document.createElement('td');
      tdAni.title = animalList;
      tdAni.textContent = animalCount;

      // Distance cell
      const tdDist = document.createElement('td');
      tdDist.textContent = Math.round(o.distance);

      // Loss check (kept for animal count vs simulation, but column is now "Last/Live/Fill")
      // const tdLoss = document.createElement('td');
      // tdLoss.style.color = lossColor;
      // tdLoss.textContent = `${lossVal}%`;

      // Last Raid cell
      const tdLast = document.createElement('td');
      tdLast.className = 't10x-last-raid-cell';
      if (farmEntry) {
        const lastArrival = farmEntry.exactArrivalTime;
        const lastHit = farmEntry.lastHit;
        if (lastArrival) {
          tdLast.textContent = lastArrival;
          tdLast.title = 'Exact arrival from report';
        } else if (lastHit) {
          const diffMin = Math.floor((Date.now() - lastHit) / 60000);
          tdLast.textContent = diffMin < 60 ? `${diffMin}m` : `${Math.floor(diffMin/60)}h`;
          tdLast.title = 'Time since dispatch';
        } else {
          tdLast.textContent = '—';
        }
      } else {
        tdLast.textContent = '—';
      }

      // Live status cell
      const tdLive = document.createElement('td');
      tdLive.className = 't10x-live-status-cell';
      if (farmEntry && farmEntry.estimatedArrivalTime && Date.now() < farmEntry.estimatedArrivalTime) {
        const liveDot = document.createElement('span');
        liveDot.className = 't10x-live-indicator';
        liveDot.title = 'Raid incoming...';
        tdLive.appendChild(liveDot);
      } else {
        tdLive.textContent = '—';
      }

      // Fill percentage cell
      const tdFill = document.createElement('td');
      tdFill.className = 't10x-fill-percent-cell';
      if (farmEntry && farmEntry.lastBountyPercent !== undefined) {
        const p = farmEntry.lastBountyPercent;
        tdFill.textContent = `${p}%`;
        tdFill.style.color = p > 90 ? '#ffcc00' : (p > 50 ? '#4ecca3' : '#888');
        tdFill.title = `Last bounty: ${p}% of capacity`;
      } else {
        tdFill.textContent = '—';
      }

      // State badge cell
      const tdState = document.createElement('td');
      if (isInFarmList && farmState) {
        const badge = document.createElement('span');
        badge.className = 't10x-farm-status-badge';
        const stateLabels = {
          'unknown': ['?', 't10x-badge-unknown'],
          'overflow': ['OVF', 't10x-badge-overflow'],
          'steady_state': ['STD', 't10x-badge-steady'],
          'paused_animals': ['ANI!', 't10x-badge-paused'],
          'dead': ['DEAD', 't10x-badge-dead'],
          'active': ['NEW', 't10x-badge-active']
        };
        const [label, cls] = stateLabels[farmState] || ['—', 't10x-badge-unknown'];
        badge.textContent = label;
        badge.classList.add(cls);
        if (farmState === 'paused_animals') badge.title = 'Animals detected — auto-farming paused';
        if (farmState === 'dead') badge.title = 'Casualties detected — blacklisted for 48h';
        tdState.appendChild(badge);
      } else {
        tdState.textContent = '—';
      }

      // Auto toggle cell (with mini raid link)
      const tdAuto = document.createElement('td');
      const actionDiv = document.createElement('div');
      actionDiv.className = 't10x-action-cell';

      // Mini manual raid link
      const raidLink = document.createElement('a');
      raidLink.href = `v2v.php?id=${o.id}`;
      raidLink.target = '_blank';
      raidLink.className = 't10x-raid-link-mini';
      raidLink.textContent = '➜';
      raidLink.title = 'Manual raid';
      actionDiv.appendChild(raidLink);

      // Auto toggle switch
      const toggleLabel = document.createElement('label');
      toggleLabel.className = 't10x-autofarm-toggle';
      if (farmState === 'paused_animals') toggleLabel.classList.add('t10x-toggle-paused');
      if (farmState === 'dead') toggleLabel.classList.add('t10x-toggle-dead');

      const toggleInput = document.createElement('input');
      toggleInput.type = 'checkbox';
      toggleInput.checked = isInFarmList;
      toggleInput.dataset.coords = coordStr;
      toggleInput.dataset.tileId = o.id;
      toggleInput.dataset.x = o.x;
      toggleInput.dataset.y = o.y;
      toggleInput.dataset.dist = o.distance;

      const toggleSlider = document.createElement('span');
      toggleSlider.className = 't10x-autofarm-slider';

      // Toggle event handler
      toggleInput.addEventListener('change', async function() {
        const coords = this.dataset.coords;
        const isOn = this.checked;
        await t10xToggleFarmTarget({
          coords,
          id: parseInt(this.dataset.tileId),
          x: parseInt(this.dataset.x),
          y: parseInt(this.dataset.y),
          dist: parseFloat(this.dataset.dist),
          isOn
        });
      });

      toggleLabel.appendChild(toggleInput);
      toggleLabel.appendChild(toggleSlider);
      actionDiv.appendChild(toggleLabel);

      tdAuto.appendChild(actionDiv);

      // Assemble row
      tr.appendChild(tdCoords);
      tr.appendChild(tdAni);
      tr.appendChild(tdDist);
      tr.appendChild(tdLast);
      tr.appendChild(tdLive);
      tr.appendChild(tdFill);
      tr.appendChild(tdState);
      tr.appendChild(tdAuto);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    contentDiv.appendChild(table);
    panel.appendChild(contentDiv);

    // Farm stats footer
    const activeFarms = farmList.filter(f => f.state !== 'dead' && f.state !== 'paused_animals').length;
    const statsDiv = document.createElement('div');
    statsDiv.className = 't10x-farm-stats';
    statsDiv.innerHTML = `
      <span>Farms: <span class="t10x-stat-value">${farmList.length}</span></span>
      <span>Active: <span class="t10x-stat-value">${activeFarms}</span></span>
      <span>Master: <span class="t10x-stat-value">${isMasterOn ? 'ON' : 'OFF'}</span></span>
    `;
    panel.appendChild(statsDiv);
  }

  sidePanel.appendChild(panel);
}

/**
 * Toggle a farm target ON/OFF in the active_farm_list
 */
async function t10xToggleFarmTarget({ coords, id, x, y, dist, isOn }) {
  const { active_farm_list } = await t10xGetSettings(['active_farm_list'], { active_farm_list: [] });
  let farmList = active_farm_list || [];

  if (isOn) {
    // Add to farm list
    const exists = farmList.find(f => f.coords === coords);
    if (!exists) {
      farmList.push({
        coords,
        id,
        x,
        y,
        dist,
        lastHit: null,
        lastBountyFull: false,
        lastTroopsSent: 0,
        pop: 15, // default oasis population estimate
        state: 'unknown',
        type: 'oasis',
        timeEmptied: null,
        deadSince: null
      });
    }
  } else {
    // Remove from farm list
    farmList = farmList.filter(f => f.coords !== coords);
  }

  await t10xSetSettings({ active_farm_list: farmList });

  // Update the row highlight immediately
  const row = document.querySelector(`.t10x-oasis-row[data-coords="${coords}"]`);
  if (row) {
    row.classList.remove('t10x-row-farming', 't10x-row-paused', 't10x-row-dead');
    if (isOn) row.classList.add('t10x-row-farming');
  }

  // Trigger immediate farm check in background
  if (isOn && t10xIsContextValid()) {
    try {
      chrome.runtime.sendMessage({ action: 'force_farm_check' });
    } catch (e) {
      console.warn('T10X: Could not trigger background farm check', e);
    }
  }
}

/**
 * Handle "Enable All Empty" button - bulk enrols all 0-animal oases from cached_oases
 */
async function t10xEnableAllEmptyOases(oases) {
  if (!oases || oases.length === 0) return;
  
  const { active_farm_list } = await t10xGetSettings(['active_farm_list'], { active_farm_list: [] });
  let farmList = active_farm_list || [];
  let addedAny = false;

  oases.forEach(o => {
    const animalCount = Object.values(o.animals || {}).reduce((sum, c) => sum + c, 0);
    if (animalCount === 0) {
      const coordStr = `${o.x}|${o.y}`;
      const exists = farmList.find(f => f.coords === coordStr);
      if (!exists) {
        farmList.push({
          coords: coordStr,
          id: o.id,
          x: o.x,
          y: o.y,
          dist: o.distance || 0,
          lastHit: null,
          lastBountyFull: false,
          lastTroopsSent: 0,
          pop: 15,
          state: 'unknown',
          type: 'oasis',
          timeEmptied: null,
          deadSince: null
        });
        addedAny = true;
      }
    }
  });

  if (addedAny) {
    await t10xSetSettings({ active_farm_list: farmList });
    // Trigger immediate farm check in background
    if (t10xIsContextValid()) {
      try {
        chrome.runtime.sendMessage({ action: 'force_farm_check' });
      } catch (e) {}
    }
  }
}

/**
 * Sync farm row highlights when active_farm_list changes (called by storage listener)
 */
function t10xSyncFarmRowHighlights(farmList) {
  const farmLookup = {};
  (farmList || []).forEach(f => { farmLookup[f.coords] = f; });

  document.querySelectorAll('.t10x-oasis-row').forEach(row => {
    const coords = row.dataset.coords;
    if (!coords) return;

    const farmEntry = farmLookup[coords];
    const toggle = row.querySelector('.t10x-autofarm-toggle input');
    const toggleLabel = row.querySelector('.t10x-autofarm-toggle');
    const stateCell = row.querySelectorAll('td')[4]; // State column (5th)

    // Update row classes
    row.classList.remove('t10x-row-farming', 't10x-row-paused', 't10x-row-dead');
    if (toggleLabel) {
      toggleLabel.classList.remove('t10x-toggle-paused', 't10x-toggle-dead');
    }

    if (farmEntry) {
      // Update toggle state
      if (toggle) toggle.checked = true;

      // Apply state-specific styling
      if (farmEntry.state === 'paused_animals') {
        row.classList.add('t10x-row-paused');
        if (toggleLabel) toggleLabel.classList.add('t10x-toggle-paused');
      } else if (farmEntry.state === 'dead') {
        row.classList.add('t10x-row-dead');
        if (toggleLabel) toggleLabel.classList.add('t10x-toggle-dead');
      } else {
        row.classList.add('t10x-row-farming');
      }

      // Update state badge
      if (stateCell) {
        stateCell.innerHTML = '';
        const badge = document.createElement('span');
        badge.className = 't10x-farm-status-badge';
        const stateLabels = {
          'unknown': ['?', 't10x-badge-unknown'],
          'overflow': ['OVF', 't10x-badge-overflow'],
          'steady_state': ['STD', 't10x-badge-steady'],
          'paused_animals': ['ANI!', 't10x-badge-paused'],
          'dead': ['DEAD', 't10x-badge-dead'],
          'active': ['NEW', 't10x-badge-active']
        };
        const [label, cls] = stateLabels[farmEntry.state] || ['—', 't10x-badge-unknown'];
        badge.textContent = label;
        badge.classList.add(cls);
        stateCell.appendChild(badge);
      }
    } else {
      if (toggle) toggle.checked = false;
      if (stateCell) stateCell.textContent = '—';
    }
  });
}

/**
 * Sync master switch UI when is_autofarming_active changes (called by storage listener)
 */
function t10xSyncMasterSwitch(isOn) {
  const switchEl = document.getElementById('t10x-master-switch');
  const statusEl = document.getElementById('t10x-master-status');
  const inputEl = document.getElementById('t10x-master-input');

  if (switchEl) switchEl.classList.toggle('t10x-master-on', !!isOn);
  if (statusEl) statusEl.textContent = isOn ? 'ACTIVE' : 'OFF';
  if (inputEl) inputEl.checked = !!isOn;
}

/**
 * Filter oasis table rows
 * Globally accessible for inline onclick handlers
 */
window.t10xFilterOases = (type) => {
  const rows = document.querySelectorAll('.t10x-oasis-row');
  rows.forEach(row => {
    const animals = parseInt(row.dataset.animals);
    const dist = parseFloat(row.dataset.dist);
    if (type === 'safe') {
      row.style.display = animals === 0 ? '' : 'none';
    } else if (type === 'near') {
      row.style.display = dist < 25 ? '' : 'none';
    } else {
      row.style.display = '';
    }
  });
};



function scanMapForCroppers() {
  const tiles = [];
  
  // UPDATE THESE SELECTORS for your server's map
  const mapTiles = document.querySelectorAll('.tile, .map-cell, #karte .tile');
  
  mapTiles.forEach(tile => {
    // Look for crop resource (usually tiles 9, 15 or similar)
    const tileType = tile.textContent || '';
    const isCrop = tileType.match(/crop|wheat|15|9/i);
    const coordsEl = tile.querySelector('.coord, .tile-coord, [data-x], [data-y]');
    
    let x = 0, y = 0;
    if (coordsEl) {
      const coordText = coordsEl.textContent || coordsEl.dataset.x || '';
      const coordMatch = coordText.match(/(\d+)[,\s]+(\d+)/);
      if (coordMatch) {
        x = parseInt(coordMatch[1]);
        y = parseInt(coordMatch[2]);
      }
    }
    
    if (isCrop && (x !== 0 || y !== 0)) {
      tiles.push({ x, y, type: 'crop' });
    }
  });
  
  t10xShowRadarResults('Found ' + tiles.length + ' crop tiles', tiles);
}

function t10xShowRadarResults(message, tiles) {
  const existing = document.getElementById('t10x-radar-results');
  if (existing) existing.remove();
  
  const panel = document.createElement('div');
  panel.id = 't10x-radar-results';
  panel.className = 't10x-radar-results';
  
  let html = '<button class="t10x-radar-close" onclick="document.getElementById(\'t10x-radar-results\').remove()">×</button>' +
    '<h3>' + message + '</h3>';
  
  if (tiles.length === 0) {
    html += '<p class="t10x-no-results">Try panning the map to different areas.</p>';
  } else {
    html += '<table class="t10x-radar-table"><thead><tr><th>Coords</th><th>Crop</th></tr></thead><tbody>';
    
    tiles.forEach(tile => {
      html += '<tr><td>' + tile.x + ',' + tile.y + '</td><td>15</td></tr>';
    });
    
    html += '</tbody></table>';
  }
  
  panel.innerHTML = html;
  document.body.appendChild(panel);
}

// ============================================================
// FEATURE 4: RAPID ROI CALCULATOR
// ============================================================

function initROICalculator() {
  window.t10xRefreshROI = function() { calculateROI(); };
  renderROITable([], true);
  calculateROI();
  if (t10xState.roiInterval) clearInterval(t10xState.roiInterval);
  t10xState.roiInterval = setInterval(calculateROI, 20000);
}

async function calculateROI() {
  // console.log('T10X: Starting ROI Calculation...');
  if (t10xState.roiCalculating) {
    // console.log('T10X: Already calculating, skipping...');
    return;
  }
  t10xState.roiCalculating = true;

  // Visual feedback
  renderROITable([], true);

  // 1. Get Fields (Cached or Scanned)
  const isVillage1 = window.location.pathname.includes('village1.php') || window.location.pathname.includes('dorf1.php');
  const fieldData = t10xGetFieldData();
  let fieldsToFetch = t10xState.cachedFields || [];
  
  if ((isVillage1 && fieldData.length > 5) || (fieldsToFetch.length === 0 && fieldData.length > 0)) {
    // console.log('T10X: Updating cached fields from current page...');
    fieldsToFetch = deduplicateFields(fieldData);
    t10xState.cachedFields = fieldsToFetch;
    localStorage.setItem('t10x-cached-fields', JSON.stringify(fieldsToFetch));
  }

  if (fieldsToFetch.length === 0) {
    renderROITable([], false, 'No fields cached. Go to Village Overview to scan.');
    t10xState.roiCalculating = false;
    return;
  }

  try {
    const costs = await fetchAllFieldCosts(fieldsToFetch);
    renderROITable(costs, false);
  } catch (e) {
    console.error('ROI Calc Error:', e);
    renderROITable([], false, 'Error fetching costs');
  } finally {
    t10xState.roiCalculating = false;
  }
}

function t10xGetFieldData() {
  // Broader search for links and areas
  var contentArea = document.querySelector('.wrapper, .content, #content, #main, body');
  if (!contentArea) return [];
  
  var typeMap = {
    'wood': ['wood', 'forest', 'woodcutter', 'holz'],
    'clay': ['clay', 'pit', 'lehm'],
    'iron': ['iron', 'mine', 'eisen'],
    'crop': ['crop', 'farm', 'getreide', 'cropland']
  };
  
  var fields = [];
  // Include <area> tags which are common for the map
  var allLinks = contentArea.querySelectorAll('a, area');
  
  // console.log('T10X: Scanning ' + allLinks.length + ' potential elements');
  
  for (var i = 0; i < allLinks.length; i++) {
    var link = allLinks[i];
    var href = link.getAttribute('href') || '';
    
    // Support multiple link formats
    var idMatch = href.match(/[?&]id=(\d+)/);
    if (!idMatch) continue;
    
    var buildId = parseInt(idMatch[1]);
    
    // IDs 1-18 are ALWAYS resource fields in village1.php/dorf1.php
    var isResourceFieldId = (buildId >= 1 && buildId <= 18);
    if (!isResourceFieldId && !href.includes('village1.php') && !href.includes('dorf1.php')) continue;

    // Get text from multiple sources
    var text = (link.textContent || '').toLowerCase();
    var alt = (link.getAttribute('alt') || '').toLowerCase();
    var title = (link.getAttribute('title') || '').toLowerCase();
    var fullText = text + ' ' + alt + ' ' + title;
    
    var type = '';
    for (var resType in typeMap) {
      var keywords = typeMap[resType];
      for (var k = 0; k < keywords.length; k++) {
        if (fullText.includes(keywords[k])) {
          type = resType;
          break;
        }
      }
      if (type) break;
    }
    
    // Final fallback if it's a resource field ID but we couldn't determine the type
    if (!type && isResourceFieldId) {
      // We'll try to get it from the class or parent's class
      var className = (link.className || '') + ' ' + (link.parentElement.className || '');
      if (className.includes('gid1')) type = 'wood';
      else if (className.includes('gid2')) type = 'clay';
      else if (className.includes('gid3')) type = 'iron';
      else if (className.includes('gid4')) type = 'crop';
    }
    
    var levelMatch = fullText.match(/level\s*(\d+)/i);
    var level = levelMatch ? parseInt(levelMatch[1]) : 0;
    
    if (type && isResourceFieldId) {
      fields.push({ type: type, level: level, buildId: buildId });
    } else if (isResourceFieldId) {
      // If we know it's a field but don't know the type, it's still worth logging
      /* console.log('T10X: Found potential field but no type:', { buildId, fullText, className: link.className }); */
    }
  }
  
  return fields;
}

function deduplicateFields(fields) {
  var seen = {};
  var result = [];
  
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    // We want to see the best ROI for each type/level combo
    var key = f.type + '-' + f.level;
    if (!seen[key]) {
      seen[key] = true;
      result.push(f);
    }
  }
  
  return result;
}

async function fetchAllFieldCosts(fields) {
  var results = [];
  
  // Get k parameter if it exists
  var kParam = '';
  var kMatch = document.documentElement.innerHTML.match(/k=([a-f0-9]+)/i);
  if (kMatch) kParam = '&k=' + kMatch[1];
  
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    
    try {
      var url = 'build.php?id=' + field.buildId + kParam;
      var response = await fetch(url, { credentials: 'same-origin' });
      var html = await response.text();
      
      var parser = new DOMParser();
      var doc = parser.parseFromString(html, 'text/html');
      
      // 1. DYNAMIC PRODUCTION EXTRACTION (Precision targeted)
      let currentProd = 0;
      let nextProd = 0;
      
      const buildValue = doc.querySelector('#build_value');
      if (buildValue) {
        const rows = Array.from(buildValue.querySelectorAll('tr'));
        rows.forEach(row => {
          const header = (row.querySelector('th')?.textContent || '').toLowerCase();
          const val = t10xParseK(row.querySelector('td, b')?.textContent || '');
          if (header.includes('current')) currentProd = val;
          else if (header.includes('at level')) nextProd = val;
        });
      } else {
        // Fallback for different T3.6 versions
        const infoTable = doc.querySelector('#building_info, table.transparent, .build_details');
        if (infoTable) {
          const rows = Array.from(infoTable.querySelectorAll('tr'));
          rows.forEach(row => {
            const t = row.textContent.toLowerCase();
            const val = t10xParseK(row.querySelector('td, .value, b')?.textContent || '');
            if (t.includes('current') || t.includes('production:')) currentProd = val;
            else if (t.includes('next level') || t.includes('at level')) nextProd = val;
          });
        }
      }

      // 2. DYNAMIC COST EXTRACTION (Precision targeted)
      let wood = 0, clay = 0, iron = 0, crop = 0;
      
      const contract = doc.querySelector('#contract, .build_details, #contract_details');
      if (contract) {
        const getCostFromImg = (rClass) => {
          const img = contract.querySelector('img.' + rClass);
          if (img && img.nextSibling) {
            // Extracts the specific number following the image, avoiding concatenation with others
            const textMatch = img.nextSibling.textContent.match(/[\d.,km]+/);
            return textMatch ? t10xParseK(textMatch[0]) : 0;
          }
          return 0;
        };
        wood = getCostFromImg('r1');
        clay = getCostFromImg('r2');
        iron = getCostFromImg('r3');
        crop = getCostFromImg('r4');
      }

      // Final fallback if precision targeted extraction fails
      if (wood === 0) {
        const costMatch = doc.body.textContent.match(/level\s*\d+:.*?([\d.,km]+)\s*\|\s*([\d.,km]+)\s*\|\s*([\d.,km]+)\s*\|\s*([\d.,km]+)/i);
        if (costMatch) {
          wood = t10xParseK(costMatch[1]);
          clay = t10xParseK(costMatch[2]);
          iron = t10xParseK(costMatch[3]);
          crop = t10xParseK(costMatch[4]);
        }
      }

      const totalCost = wood + clay + iron + crop;
      const gain = nextProd - currentProd;
      
      // ROI = Payback Speed Score (Higher is better)
      // Standard ROI: gain / totalCost
      // For display, we use a score that makes sense (e.g. production per 1k resources)
      const roi = (totalCost > 0 && gain > 0) ? (gain / totalCost) * 1000 : 0;
      
      if (totalCost > 0) {
        results.push({
          type: field.type,
          level: field.level + 1,
          costs: { wood, clay, iron, crop },
          production: nextProd,
          gain: gain,
          roi: roi
        });
      }
    } catch (e) {
      console.warn('T10X: Failed to fetch cost/benefit for field', field.buildId, e);
    }
  }
  
  return results;
}

function getProduction(type, level) {
  // Base production for 10x server
  var baseProd = 300; 
  return Math.floor(baseProd * Math.pow(1.1, level - 1));
}

function renderROITable(upgradeData, isLoading, errorMsg) {
  errorMsg = errorMsg || '';
  
  const sidePanel = t10xGetSidePanel();
  var tableContainer = document.getElementById('t10x-roi-table');
  
  if (!tableContainer) {
    tableContainer = document.createElement('div');
    tableContainer.id = 't10x-roi-table';
    tableContainer.className = 't10x-roi-table';
    sidePanel.prepend(tableContainer);
  } else if (isLoading && tableContainer.querySelector('table')) {
    // If we're loading but already have a table, just show a loading state on the button
    // This prevents the whole table from disappearing and the UI jumping
    var btn = tableContainer.querySelector('.t10x-refresh-btn');
    if (btn) btn.textContent = '↻ Scanning...';
    tableContainer.style.opacity = '0.6';
    tableContainer.style.pointerEvents = 'none';
    return;
  }
  
  tableContainer.style.opacity = '1';
  tableContainer.style.pointerEvents = 'auto';
  
  var html = '<h3>ROI Calculator <button class="t10x-refresh-btn">↻ Refresh</button></h3>';
  
  if (isLoading) {
    html += '<div class="t10x-loading">Scaning fields & fetching costs...</div>';
  } else if (errorMsg) {
    html += '<div class="t10x-error">' + errorMsg + '</div>';
  } else if (upgradeData.length === 0) {
    html += '<div class="t10x-error">No upgrade data found.</div>';
  } else {
    html += '<table><thead><tr><th>Resource</th><th>Level</th><th>Cost</th><th>ROI</th><th>Status</th></tr></thead><tbody>';
    
    var sortedData = upgradeData.slice().sort(function(a, b) { return b.roi - a.roi; });
    
    // Ensure we have latest resource data
    t10xUpdateState();
    
    for (var i = 0; i < sortedData.length; i++) {
      var item = sortedData[i];
      var isBest = i === 0;
      var totalCost = item.costs.wood + item.costs.clay + item.costs.iron + item.costs.crop;
      
      // Calculate resource status
      var canAfford = true;
      var maxWaitSeconds = 0;
      var missingRes = [];
      
      const resources = ['wood', 'clay', 'iron', 'crop'];
      resources.forEach(res => {
        const cost = item.costs[res];
        const current = t10xState.resources[res];
        const prod = t10xState.production[res];
        
        if (current < cost) {
          canAfford = false;
          missingRes.push(res);
          if (prod > 0) {
            const waitHours = (cost - current) / prod;
            maxWaitSeconds = Math.max(maxWaitSeconds, waitHours * 3600);
          } else {
            maxWaitSeconds = Infinity;
          }
        }
      });
      
      var statusHtml = '';
      if (canAfford) {
        statusHtml = '<span class="t10x-status-ready">Ready</span>';
      } else if (maxWaitSeconds === Infinity) {
        statusHtml = '<span class="t10x-status-waiting">Never</span>';
      } else {
        var h = Math.floor(maxWaitSeconds / 3600);
        var m = Math.floor((maxWaitSeconds % 3600) / 60);
        statusHtml = '<span class="t10x-status-waiting">' + (h > 0 ? h + 'h ' : '') + m + 'm</span>';
      }

      html += '<tr class="' + (canAfford ? 't10x-row-ready' : 't10x-row-waiting') + '">' +
        '<td class="t10x-resource-' + item.type + '">' + item.type.charAt(0).toUpperCase() + item.type.slice(1) + '</td>' +
        '<td>L' + item.level + '</td>' +
        '<td class="t10x-cost-cell" title="' + item.costs.wood + '|' + item.costs.clay + '|' + item.costs.iron + '|' + item.costs.crop + '">' + 
          (totalCost > 1000 ? (totalCost/1000).toFixed(1) + 'k' : totalCost) + 
        '</td>' +
        '<td class="' + (isBest ? 't10x-best-roi' : '') + '">' + item.roi.toFixed(5) + '</td>' +
        '<td>' + statusHtml + '</td>' +
        '</tr>';
    }
    
    html += '</tbody></table>';
  }
  
  tableContainer.innerHTML = html;
  
  var refreshBtn = tableContainer.querySelector('.t10x-refresh-btn');
  if (refreshBtn) {
    refreshBtn.onclick = function(e) {
      e.preventDefault();
      e.stopPropagation();
      console.log('T10X: ROI Refresh Clicked');
      calculateROI(); 
    };
  }
}

// ============================================================
// FEATURE 5: NEWBIE PROTECTION DROP TRACKER
// ============================================================

function initProtectionTracker() {
  calculateProtectionDrop();
}

function calculateProtectionDrop() {
  var regDate = null;
  var population = 0;
  
  var regDateEl = document.querySelector('.reg-date, .registration-date, [data-reg-date], .player-info .date, #spieler .reg_date, .profile .registered');
  
  if (regDateEl) {
    var dateText = regDateEl.textContent || regDateEl.dataset.regDate;
    regDate = t10xParseDate(dateText);
  }
  
  var popEl = document.querySelector('.population, .pop, [data-population], .player-info .population');
  
  if (popEl) {
    var popMatch = popEl.textContent.match(/(\d+)/);
    if (popMatch) population = parseInt(popMatch[1]);
  }
  
  if (!regDate && population > 0) {
    var hoursAgo = population / 10;
    regDate = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  }
  
  if (!regDate) {
    regDate = new Date();
  }
  
  var protectionMs = T10X_CONFIG.protectionHours * 60 * 60 * 1000;
  var dropDate = new Date(regDate.getTime() + protectionMs);
  
  displayProtectionInfo(dropDate, population);
}

function displayProtectionInfo(dropDate, population) {
  var existing = document.getElementById('t10x-protection-panel');
  if (existing) existing.remove();
  
  var panel = document.createElement('div');
  panel.id = 't10x-protection-panel';
  panel.className = 't10x-container t10x-protection-panel';
  
  var now = new Date();
  var msRemaining = dropDate.getTime() - now.getTime();
  
  var hours = Math.floor(msRemaining / (1000 * 60 * 60));
  var minutes = Math.floor((msRemaining % (1000 * 60 * 60)) / (1000 * 60));
  
  var statusText = hours > 0 ? hours + 'h ' + minutes + 'm remaining' : 'Protection dropped!';
  var statusClass = hours > 0 ? 't10x-protected' : 't10x-exposed';
  
  panel.innerHTML = '<span class="t10x-protection-status ' + statusClass + '">Protection: ' + statusText + '</span>';
  document.body.appendChild(panel);
}

function t10xParseNumber(element, type) {
  var text = element.textContent || '';
  var match = text.match(/(\d+)/);
  return match ? parseInt(match[1]) : 0;
}

function t10xParseDate(text) {
  if (!text) return null;
  
  var match = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
  }
  
  match = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (match) {
    return new Date(parseInt(match[3]), parseInt(match[1]) - 1, parseInt(match[2]));
  }
  
  return null;
}

function t10xSendNotification(title, message) {
  if (typeof chrome !== 'undefined' && chrome.notifications) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon.png',
      title: title,
      message: message
    });
  }
}

// ============================================================
// INFINITE TASK MANAGER
// ============================================================

async function t10xScrapeVillageBuildings() {
  const isVillage1 = window.location.pathname.includes('village1.php') || window.location.pathname.includes('dorf1.php');
  const isVillage2 = window.location.pathname.includes('village2.php') || window.location.pathname.includes('dorf2.php');
  
  if (!isVillage1 && !isVillage2) return;

  const contentArea = document.querySelector('.wrapper, .content, #content, #main, body');
  if (!contentArea) return;

  // --- Tribe Detection ---
  let player_tribe = 'unknown';
  const tribeImg = document.querySelector('img.unit, .sideInfo img[src*="unit"]');
  if (tribeImg) {
    const src = tribeImg.getAttribute('src');
    if (src.includes('u1.gif') || src.includes('u2.gif') || src.includes('u3.gif')) player_tribe = 'roman';
    else if (src.includes('u11.gif')) player_tribe = 'teuton';
    else if (src.includes('u21.gif')) player_tribe = 'gaul';
  }

  // --- Queue Detection ---
  const native_queue_blocks = [];
  const buildList = document.querySelector('.buildingList, #content .boxes.content table, .build_details');
  if (buildList) {
    const rows = buildList.querySelectorAll('tr, li');
    rows.forEach(row => {
      const text = row.textContent.toLowerCase();
      if (text.includes('level') || text.includes('stufe')) {
        // Simple heuristic: buildId 1-18 are fields
        // In the building list, we can usually see the name
        const isField = /wood|clay|iron|crop|holz|lehm|eisen|getreide/i.test(text);
        native_queue_blocks.push({ type: isField ? 'field' : 'building' });
      }
    });
  }

  const allLinks = contentArea.querySelectorAll('a, area');
  const extracted = {};

  for (let i = 0; i < allLinks.length; i++) {
    const link = allLinks[i];
    const href = link.getAttribute('href') || '';
    const idMatch = href.match(/[?&]id=(\d+)/);
    
    if (!idMatch) continue;
    
    const buildId = parseInt(idMatch[1]);
    const text = (link.textContent || '').toLowerCase();
    const alt = (link.getAttribute('alt') || '').toLowerCase();
    const title = (link.getAttribute('title') || '').toLowerCase();
    const fullText = text + ' ' + alt + ' ' + title;
    
    const levelMatch = fullText.match(/level\s*(\d+)/i);
    const level = levelMatch ? parseInt(levelMatch[1]) : 0;
    
    let name = 'Unknown';
    const nameMatch = (title || alt).match(/^([^<0-9]+)/);
    if (nameMatch) {
      name = nameMatch[1].trim();
    } else if (text) {
      name = text.split('\n')[0].trim();
    }
    
    if (buildId >= 1 && buildId <= 40) {
      extracted[buildId] = {
        buildId,
        level,
        name: name,
        isField: buildId >= 1 && buildId <= 18
      };
    }
  }

  const storageData = await chrome.storage.local.get(['village_buildings']);
  const buildings = storageData.village_buildings || {};
  
  for (const id in extracted) {
    buildings[id] = extracted[id];
  }
  
  await chrome.storage.local.set({ 
    village_buildings: buildings,
    native_queue_blocks,
    player_tribe
  });
}

function t10xInjectQueueButtons() {
  // Extract node ID from current URL
  const idMatch = window.location.href.match(/[?&]id=(\d+)/);
  if (!idMatch) return;
  const buildId = parseInt(idMatch[1]);

  const contractArea = document.getElementById('contract');
  if (contractArea && !contractArea.dataset.t10xButtonInjected) {
    contractArea.dataset.t10xButtonInjected = "true";
    
    // Look for target level in the contract text (e.g., "to upgrade to level 3:")
    const textContent = contractArea.textContent;
    const match = textContent.match(/level\s*(\d+)/i);
    const targetLevel = match ? parseInt(match[1]) : null;

    if (targetLevel) {
      const qBtn = document.createElement('button');
      qBtn.className = 't10x-queue-plus-btn';
      qBtn.style.marginLeft = '10px';
      qBtn.textContent = 'Queue +';
      qBtn.title = `Add Level ${targetLevel} to Infinite Queue`;
      
      qBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        const { task_queue } = await chrome.storage.local.get('task_queue');
        const queue = task_queue || [];
        queue.push({
          id: 'task_' + Date.now() + '_' + Math.floor(Math.random()*1000),
          type: 'building',
          buildId: buildId,
          target_level: targetLevel,
          priority: 1,
          status: 'waiting'
        });
        await chrome.storage.local.set({ task_queue: queue });
        qBtn.textContent = 'Queued ✓';
        qBtn.style.background = '#4ecca3';
      };
      
      // Find the best place to append
      const link = contractArea.querySelector('a.build');
      const noneSpan = contractArea.querySelector('span.none');
      if (link) {
         link.parentNode.insertBefore(qBtn, link.nextSibling);
      } else if (noneSpan) {
         noneSpan.parentNode.appendChild(qBtn);
      } else {
         contractArea.appendChild(qBtn);
      }
    }
  }
}

async function initTaskManagerUI() {
  let bottomPanel = document.getElementById('t10x-bottom-panel');
  if (!bottomPanel) {
    bottomPanel = document.createElement('div');
    bottomPanel.id = 't10x-bottom-panel';
    bottomPanel.className = 't10x-bottom-panel';
    document.body.appendChild(bottomPanel);
  }

  // Load saved position
  const savedPos = await chrome.storage.local.get('t10x_taskmgr_pos');
  if (savedPos.t10x_taskmgr_pos) {
    bottomPanel.style.top = savedPos.t10x_taskmgr_pos.top;
    bottomPanel.style.left = savedPos.t10x_taskmgr_pos.left;
    bottomPanel.style.bottom = 'auto'; // Disable bottom anchor
  }

  let taskPanel = document.getElementById('t10x-task-mgr');
  
  if (!taskPanel) {
    taskPanel = document.createElement('div');
    taskPanel.id = 't10x-task-mgr';
    taskPanel.className = 't10x-task-mgr-container';
    
    taskPanel.innerHTML = `
      <div class="t10x-task-header" id="t10x-task-drag-handle" style="cursor: move;">
        <div style="display:flex; flex-direction:column; pointer-events:none;">
          <h3 style="pointer-events:none;">Development Queue</h3>
          <span id="t10x-task-status-text" style="font-size: 8px; color: #4ecca3; text-transform: uppercase;">Idle</span>
        </div>
        <label class="t10x-switch">
          <input type="checkbox" id="t10x-task-mgr-toggle">
          <span class="t10x-slider round"></span>
        </label>
      </div>
      <div class="t10x-task-list" id="t10x-queued-tasks">
        <div class="t10x-empty-queue">Queue is empty</div>
      </div>
      <div class="t10x-task-actions">
        <button id="t10x-btn-next-roi" title="Queue the best ROI field">Queue Best ROI</button>
        <button id="t10x-btn-equalize" title="Queue lowest field">Equalize Fields</button>
        <button id="t10x-btn-clear" title="Clear entire queue" style="background: #900;">Clear All</button>
      </div>
    `;

    // --- Drag Logic ---
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    const dragHandle = taskPanel.querySelector('#t10x-task-drag-handle');
    
    dragHandle.onmousedown = (e) => {
      // Don't drag if clicking the switch
      if (e.target.closest('.t10x-switch')) return;
      
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    };

    function elementDrag(e) {
      e.preventDefault();
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;
      bottomPanel.style.top = (bottomPanel.offsetTop - pos2) + "px";
      bottomPanel.style.left = (bottomPanel.offsetLeft - pos1) + "px";
      bottomPanel.style.bottom = 'auto';
    }

    async function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
      // Save position
      await chrome.storage.local.set({ 
        t10x_taskmgr_pos: { 
          top: bottomPanel.style.top, 
          left: bottomPanel.style.left 
        } 
      });
    }
    
    const autoFarmExt = document.getElementById('t10x-autofarm-mgr');
    if (autoFarmExt && autoFarmExt.parentElement === bottomPanel) {
      bottomPanel.insertBefore(taskPanel, autoFarmExt);
    } else {
      bottomPanel.appendChild(taskPanel);
    }

    // Attach listeners
    const toggle = document.getElementById('t10x-task-mgr-toggle');
    const { is_task_manager_active } = await chrome.storage.local.get('is_task_manager_active');
    toggle.checked = !!is_task_manager_active;
    
    toggle.addEventListener('change', async (e) => {
      await chrome.storage.local.set({ is_task_manager_active: e.target.checked });
    });

    document.getElementById('t10x-btn-next-roi').textContent = '+1 All Fields';
    document.getElementById('t10x-btn-next-roi').onclick = async () => {
      const { village_buildings, task_queue } = await chrome.storage.local.get(['village_buildings', 'task_queue']);
      const buildings = village_buildings || {};
      const queue = task_queue || [];

      // Queue every field (1-18) to the next level
      let added = 0;
      for (let id = 1; id <= 18; id++) {
        if (buildings[id]) {
          queue.push({
            id: 'task_' + Date.now() + '_' + Math.floor(Math.random()*1000),
            type: 'building',
            buildId: id,
            target_level: buildings[id].level + 1,
            priority: 1,
            status: 'waiting'
          });
          added++;
        }
      }
      await chrome.storage.local.set({ task_queue: queue });
      t10xRenderTaskQueue();
      alert(`Queued +1 level for ${added} resource fields!`);
    };

    document.getElementById('t10x-btn-equalize').onclick = async () => {
      const { village_buildings, task_queue } = await chrome.storage.local.get(['village_buildings', 'task_queue']);
      const buildings = village_buildings || {};
      const queue = task_queue || [];

      // Find the lowest field
      let lowestField = null;
      for (let id = 1; id <= 18; id++) {
        if (buildings[id]) {
          if (!lowestField || buildings[id].level < lowestField.level) {
            lowestField = buildings[id];
          }
        }
      }

      if (lowestField) {
        queue.push({
          id: 'task_' + Date.now() + '_' + Math.floor(Math.random()*1000),
          type: 'building',
          buildId: lowestField.buildId,
          target_level: lowestField.level + 1,
          priority: 2, // High priority
          status: 'waiting'
        });
        await chrome.storage.local.set({ task_queue: queue });
        t10xRenderTaskQueue();
        alert(`Queued lowest field: ${lowestField.name} to level ${lowestField.level + 1}`);
      }
    };
    
    document.getElementById('t10x-btn-clear').onclick = async () => {
      if (confirm('Are you sure you want to clear the entire queue?')) {
        await chrome.storage.local.set({ task_queue: [], task_manager_status: 'Idle' });
        t10xRenderTaskQueue();
      }
    };

    // Render list loop
    setInterval(t10xRenderTaskQueue, 2000);
    t10xRenderTaskQueue();
  }
}

async function t10xRenderTaskQueue() {
  const listEl = document.getElementById('t10x-queued-tasks');
  const statusEl = document.getElementById('t10x-task-status-text');
  if (!listEl) return;

  const { task_queue, village_buildings, task_manager_status } = await chrome.storage.local.get(['task_queue', 'village_buildings', 'task_manager_status']);
  const queue = task_queue || [];
  
  if (statusEl) {
    statusEl.textContent = task_manager_status || 'Idle';
  }
  
  if (queue.length === 0) {
    listEl.innerHTML = '<div class="t10x-empty-queue">Queue is empty</div>';
    return;
  }

  listEl.innerHTML = '';
  queue.forEach((task, idx) => {
    let name = task.type === 'macro' ? task.target : 'Unknown Node';
    if (task.type === 'building' && village_buildings && village_buildings[task.buildId]) {
      name = village_buildings[task.buildId].name;
    }
    
    const item = document.createElement('div');
    item.className = 't10x-task-item';
    item.innerHTML = `
      <div class="t10x-task-info">
        <span class="t10x-task-num">${idx+1}.</span> 
        <span class="t10x-task-name">${name} &rarr; Lvl ${task.target_level || '?'}</span>
      </div>
      <button class="t10x-task-del" data-id="${task.id}">×</button>
    `;
    
    item.querySelector('.t10x-task-del').onclick = async () => {
      const { task_queue } = await chrome.storage.local.get('task_queue');
      const newQ = (task_queue || []).filter(t => t.id !== task.id);
      await chrome.storage.local.set({ task_queue: newQ });
      t10xRenderTaskQueue();
    };
    
    listEl.appendChild(item);
  });
}

// ============================================================
// INITIALIZE
// ============================================================

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', t10xInit);
} else {
  t10xInit();
}

var lastUrl = location.href;
new MutationObserver(function() {
  var url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    t10xInit();
  }
}).observe(document, { subtree: true, childList: true });
