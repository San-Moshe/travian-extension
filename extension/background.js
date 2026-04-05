/**
 * Travian 3.6 10x Companion — Background Service Worker
 * 
 * Auto-Farm Engine with Dynamic Yield Calibration Algorithm
 * 
 * State Machine: unknown → overflow → steady_state → dead
 * Each farm target transitions between states based on report analysis.
 */

// ============================================================
// CONSTANTS & DEFAULTS
// ============================================================

const AUTOFARM_DEFAULTS = {
  is_autofarming_active: false,
  active_farm_list: [],
  autofarm_interval_sec: 10,
  autofarm_hit_cooldown_sec: 120,
  selected_troop_id: 't1',
  troop_carry_capacity: 50,
  base_probe_size: 3,
  overflow_multiplier: 2.0,
  overflow_multiplier: 2.0,
  dead_blacklist_hours: 48,
  auto_enable_zero_animals: true
};

const TASK_MANAGER_DEFAULTS = {
  is_task_manager_active: false,
  task_queue: [],
  village_buildings: {},
  player_tribe: 'unknown',
  auto_npc_enabled: false,
  native_queue_blocks: []
};

const ALARM_NAME = 'autofarm-loop';
const TASK_ALARM_NAME = 'task-manager-loop';

// Animal definitions (mirrors content.js T10X_ANIMALS)
const BG_ANIMALS = {
  'rat': { name: 'Rat' },
  'spider': { name: 'Spider' },
  'snake': { name: 'Snake' },
  'bat': { name: 'Bat' },
  'boar': { name: 'Wild Boar' },
  'wolf': { name: 'Wolf' },
  'bear': { name: 'Bear' },
  'crocodile': { name: 'Crocodile' },
  'tiger': { name: 'Tiger' },
  'elephant': { name: 'Elephant' }
};

// ============================================================
// INITIALIZATION
// ============================================================

chrome.runtime.onInstalled.addListener(() => {
  console.log('T10X AutoFarm: Extension installed/updated');
  initializeDefaults();
  setupAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('T10X AutoFarm: Browser started');
  setupAlarm();
});

async function initializeDefaults() {
  const allDefaults = { ...AUTOFARM_DEFAULTS, ...TASK_MANAGER_DEFAULTS };
  const existing = await chrome.storage.local.get(Object.keys(allDefaults));
  const toSet = {};
  for (const [key, defaultVal] of Object.entries(allDefaults)) {
    if (existing[key] === undefined) {
      toSet[key] = defaultVal;
    }
  }
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
    console.log('T10X: Initialized defaults', toSet);
  }
}

async function setupAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 10 / 60 }); // ~10 seconds (dev mode)
  
  await chrome.alarms.clear(TASK_ALARM_NAME);
  chrome.alarms.create(TASK_ALARM_NAME, { periodInMinutes: 30 / 60 }); // 30 seconds
  console.log('T10X: Alarms created');
}

// ============================================================
// ALARM HANDLER — Main Entry Point
// ============================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await runFarmCycle();
  } else if (alarm.name === TASK_ALARM_NAME) {
    await runTaskManagerCycle();
  }
});

// ============================================================
// MESSAGE HANDLER — Force immediate check from content script
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'force_farm_check') {
    console.log('T10X AutoFarm: Force check triggered from content script');
    runFarmCycle().then(() => sendResponse({ ok: true }));
    return true; // keep channel open for async response
  }
});

// ============================================================
// CORE FARM CYCLE
// ============================================================

let isFarmCycleRunning = false;

async function runFarmCycle() {
  console.log('T10X AutoFarm: [DEBUG] Starting farm cycle check...');
  if (isFarmCycleRunning) {
    console.log('T10X AutoFarm: [SKIP] Cycle already running');
    return;
  }
  isFarmCycleRunning = true;

  try {
    const settings = await chrome.storage.local.get([
      'is_autofarming_active',
      'active_farm_list',
      'cached_oases',
      'autofarm_hit_cooldown_sec',
      'selected_troop_id',
      'troop_carry_capacity',
      'base_probe_size',
      'overflow_multiplier',
      'dead_blacklist_hours',
      'auto_enable_zero_animals'
    ]);

    console.log('T10X AutoFarm: [CHECK] Settings loaded:', {
      active: settings.is_autofarming_active,
      farmCount: settings.active_farm_list?.length || 0,
      troop: settings.selected_troop_id,
      carry: settings.troop_carry_capacity
    });

    // 1. Check master switch
    if (!settings.is_autofarming_active) {
      console.log('T10X AutoFarm: [ABORT] Master switch is OFF');
      return;
    }

    const farmList = settings.active_farm_list || [];
    if (farmList.length === 0) {
      console.log('T10X AutoFarm: [ABORT] No farms in active list');
      return;
    }

    const cooldownMs = (settings.autofarm_hit_cooldown_sec || 120) * 1000;
    const deadBlacklistMs = (settings.dead_blacklist_hours || 48) * 3600 * 1000;
    const globalSettings = {
      selected_troop_id: settings.selected_troop_id || 't1',
      troop_carry_capacity: settings.troop_carry_capacity || 50,
      base_probe_size: settings.base_probe_size || 3,
      overflow_multiplier: settings.overflow_multiplier || 2.0
    };

    // 2. Get session key from the active tab
    const sessionKey = await getSessionKey();
    if (!sessionKey) {
      console.warn('T10X AutoFarm: [ABORT] No session key found! (Must have a game tab open)');
      return;
    }
    console.log('T10X AutoFarm: [READY] Session found, processing targets...');

    // 2.5 Deterministic Report Sync Engine - Sync and process all latest reports first
    console.log('T10X AutoFarm: [SYNC] Updating report cache with latest battles...');
    await syncReports(globalSettings);
    await processFarmTransitions();

    // 2.7 Auto-Enable Logic: Add oases with 0 animals to farm list if enabled
    if (settings.auto_enable_zero_animals) {
      const { cached_oases, active_farm_list } = await chrome.storage.local.get(['cached_oases', 'active_farm_list']);
      const currentList = active_farm_list || [];
      const oases = cached_oases || [];
      let addedAny = false;

      oases.forEach(o => {
        const animalCount = Object.values(o.animals || {}).reduce((sum, c) => sum + c, 0);
        if (animalCount === 0) {
          const coordStr = `${o.x}|${o.y}`;
          const exists = currentList.find(f => f.coords === coordStr);
          if (!exists) {
            console.log(`T10X AutoFarm: Auto-enabling empty oasis at ${coordStr}`);
            currentList.push({
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
        await chrome.storage.local.set({ active_farm_list: currentList });
        console.log('T10X AutoFarm: Updated farm list with auto-enabled oases');
      }
    }

    // Re-fetch the farm list since processFarmTransitions might have mutated it
    const updatedSettings = await chrome.storage.local.get(['active_farm_list']);
    const currentFarmList = updatedSettings.active_farm_list || farmList;

    // 3. Prioritize targets: Full bounty > Never hit > Normal
    // This ensures limited troops are sent to the most profitable oases first.
    currentFarmList.sort((a, b) => {
      const getPriority = (f) => {
        if (f.lastBountyFull) return 2;
        if (!f.lastHit) return 1;
        return 0;
      };
      
      const priA = getPriority(a);
      const priB = getPriority(b);
      
      if (priA !== priB) return priB - priA; // Higher priority first
      
      // Tie-breaker: oldest hit first (least recently raided)
      return (a.lastHit || 0) - (b.lastHit || 0);
    });

    // 4. Process each farm target
    for (let i = 0; i < currentFarmList.length; i++) {
      const farm = currentFarmList[i];

      // Skip dead farms (blacklisted)
      if (farm.state === 'dead') {
        if (farm.deadSince && (Date.now() - farm.deadSince) > deadBlacklistMs) {
          console.log(`T10X AutoFarm: Reviving dead farm ${farm.coords} after blacklist period`);
          farm.state = 'unknown';
          farm.deadSince = null;
          await atomicUpdateFarm(farm.id, { state: 'unknown', deadSince: null });
        } else {
          continue;
        }
      }

      // Check cooldown:
      // Priority: nextAttackTime (exact, round-trip aware)
      // Fallback 1: estimatedArrivalTime + 60s report buffer (when nextAttackTime not set)
      // Fallback 2: lastHit + flat cooldownMs (legacy)
      const waitUntil = farm.nextAttackTime
        || (farm.estimatedArrivalTime ? farm.estimatedArrivalTime + 60000 : null)
        || (farm.lastHit ? farm.lastHit + cooldownMs : 0);
      if (Date.now() < waitUntil) {
        const remainSec = Math.ceil((waitUntil - Date.now()) / 1000);
        console.log(`T10X AutoFarm: [SKIP] ${farm.coords} — cooldown, ${remainSec}s remaining`);
        continue;
      }

      console.log(`T10X AutoFarm: Processing ${farm.coords} (state: ${farm.state})`);

      // 3.5 Pre-filter via Oasis Radar scan data (Radar Knowledge Integration)
      const cachedOasis = (settings.cached_oases || []).find(o => o.id === farm.id);
      if (cachedOasis) {
        const cachedAnimalCount = Object.values(cachedOasis.animals || {}).reduce((sum, c) => sum + c, 0);
        if (cachedAnimalCount > 0) {
          console.log(`T10X AutoFarm: SKIPPING ${farm.coords} — Radar scan already flags animals (${cachedAnimalCount})`);
          if (farm.state !== 'paused_animals') {
            farm.state = 'paused_animals';
            await atomicUpdateFarm(farm.id, { state: 'paused_animals' });
          }
          continue;
        }
      }

      // 4. Safety Check — scrape oasis for animals
      const animalCheck = await checkOasisAnimals(farm.id, sessionKey);
      
      // Update Radar knowledge with latest animal count
      await updateRadarKnowledge(farm.id, animalCheck.animals || {});

      if (animalCheck.hasAnimals) {
        console.log(`T10X AutoFarm: Animals detected at ${farm.coords} — pausing`);
        farm.state = 'paused_animals';
        await atomicUpdateFarm(farm.id, { state: 'paused_animals' });
        continue;
      }

      // Clear paused state if animals are gone
      if (farm.state === 'paused_animals') {
        farm.state = 'unknown';
        await atomicUpdateFarm(farm.id, { state: 'unknown' });
      }

      // 5. Calculate optimal troop count via State Machine
      const troopCount = calculateOptimalTroops(farm, globalSettings);
      if (troopCount <= 0) {
        console.warn(`T10X AutoFarm: Calculated 0 troops for ${farm.coords} — skipping`);
        continue;
      }

      console.log(`T10X AutoFarm: Sending ${troopCount}x ${globalSettings.selected_troop_id} to ${farm.coords}`);

      // 6. Execute attack
      const attackResult = await executeAttack(farm, troopCount, globalSettings.selected_troop_id, sessionKey);

      if (attackResult.success && attackResult.dispatchTime) {
        // Use exact travel time from confirmation page, fall back to estimate
        const travelTimeMs = attackResult.travelSec 
          ? attackResult.travelSec * 1000 
          : estimateTravelTime(farm.dist);
        farm.lastHit = attackResult.dispatchTime;
        farm.lastTroopsSent = troopCount;
        farm.estimatedArrivalTime = attackResult.dispatchTime + travelTimeMs;
        farm.exactArrivalTime = attackResult.arrivalTime || null;
        // Next attack allowed after troops arrive + 60s report buffer
        farm.nextAttackTime = attackResult.dispatchTime + travelTimeMs + 60000;
        
        await atomicUpdateFarm(farm.id, {
          lastHit: farm.lastHit,
          lastTroopsSent: farm.lastTroopsSent,
          estimatedArrivalTime: farm.estimatedArrivalTime,
          exactArrivalTime: farm.exactArrivalTime,
          nextAttackTime: farm.nextAttackTime
        });

        console.log(`T10X AutoFarm: Attack sent to ${farm.coords}! Travel: ${Math.round(travelTimeMs/1000)}s, Arrival: ${attackResult.arrivalTime || 'unknown'}, Next in: ${Math.round((farm.nextAttackTime - Date.now())/1000)}s`);

        // Removed legacy setTimeout scrape: Reports are now deterministically synced by syncReports() on the next cycles
      } else if (attackResult.error === 'no_troops') {
        // We lack troops globally. DO NOT penalize this farm's cooldown! 
        // By leaving its nextAttackTime in the past, it will remain at the top of the queue 
        // to receive the exact returning troops on the very next cycle.
        console.log(`T10X AutoFarm: [WAITING] ${farm.coords} — no troops available. Reserving spot and aborting cycle.`);
        break;
      } else {
        console.warn(`T10X AutoFarm: Attack FAILED for ${farm.coords}:`, attackResult.error);
      }

      // Add jitter between attacks to not hammer the server
      await delay(2000 + Math.random() * 3000);
    }

  } catch (e) {
    console.error('T10X AutoFarm: Cycle error', e);
  } finally {
    isFarmCycleRunning = false;
  }
}

// ============================================================
// ATOMIC STORAGE UPDATES
// ============================================================

async function atomicUpdateFarm(farmId, updates) {
  const { active_farm_list } = await chrome.storage.local.get('active_farm_list');
  if (!active_farm_list) return;
  const idx = active_farm_list.findIndex(f => f.id === farmId);
  if (idx !== -1) {
    active_farm_list[idx] = { ...active_farm_list[idx], ...updates };
    await chrome.storage.local.set({ active_farm_list });
  }
}

// ============================================================
// DYNAMIC YIELD CALIBRATION — State Machine
// ============================================================

/**
 * Calculate the exact number of troops to send based on the farm's current state.
 * 
 * States:
 *   'unknown'       → Probe with base_probe_size
 *   'overflow'      → Multiply last troop count by overflow_multiplier
 *   'steady_state'  → Calculate from estimated production * time elapsed
 *   'dead'          → Should never reach here (filtered above)
 *   'paused_animals' → Should never reach here (filtered above)
 * 
 * @param {Object} farm - The farm target object
 * @param {Object} gs - Global settings
 * @returns {number} Exact integer of troops to send
 */
function calculateOptimalTroops(farm, gs) {
  const state = farm.state || 'unknown';

  switch (state) {
    // ---- State A: The Probe ----
    case 'unknown': {
      return Math.max(gs.base_probe_size, 2);
    }

    // ---- State B: The Multiplier ----
    case 'overflow': {
      const lastSent = farm.lastTroopsSent || Math.max(gs.base_probe_size, 2);
      return Math.max(Math.floor(lastSent * gs.overflow_multiplier), 2);
    }

    // ---- State C: The Optimization ----
    case 'steady_state': {
      const pop = farm.pop || 15; // default oasis "population" estimate
      const pEst = pop * 10; // 10x server hourly production estimate
      const timeEmptied = farm.timeEmptied || farm.lastHit || Date.now();
      const deltaHours = (Date.now() - timeEmptied) / 3600000;
      const totalRes = pEst * deltaHours;
      const troopsNeeded = Math.ceil(totalRes / gs.troop_carry_capacity) + 1;
      // Don't send fewer than probe size, and absolutely never less than 2
      return Math.max(troopsNeeded, gs.base_probe_size, 2);
    }

    // ---- Fallback ----
    default: {
      return Math.max(gs.base_probe_size, 2);
    }
  }
}

// ============================================================
// SAFETY CHECK — Scrape oasis for animals
// ============================================================

async function checkOasisAnimals(tileId, sessionKey) {
  try {
    const tabId = await getGameTabId();
    if (!tabId) throw new Error('No game tab found');

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (url) => {
        try {
          const response = await fetch(url);
          if (!response.ok) return { hasAnimals: true, count: -1, animals: {} };
          const html = await response.text();
          
          // FAST REGEX CHECK: Skip DOMParser if no animals are present
          if (!/troop_info|unit_img|unit/i.test(html)) return { hasAnimals: false, count: 0, animals: {} };

          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');

          let totalAnimals = 0;
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
                
                const knownAnimals = {
                  'rat': 'rat', 'spider': 'spider', 'snake': 'snake', 'bat': 'bat',
                  'wild boar': 'boar', 'boar': 'boar', 'wolf': 'wolf', 'bear': 'bear',
                  'crocodile': 'crocodile', 'tiger': 'tiger', 'elephant': 'elephant'
                };
                
                for (const [k, v] of Object.entries(knownAnimals)) {
                  if (title.includes(k)) {
                    animals[v] = (animals[v] || 0) + count;
                    totalAnimals += count;
                    break;
                  }
                }
              }
            });
          }
          return { hasAnimals: totalAnimals > 0, count: totalAnimals, animals };
        } catch (e) {
          return { hasAnimals: true, count: -1, animals: {} };
        }
      },
      args: [`${sessionKey}/village3.php?id=${tileId}`]
    });

    const checkRes = results?.[0]?.result;
    if (!checkRes) return { hasAnimals: true, count: -1, animals: {} };
    return checkRes;
  } catch (e) {
    console.error('T10X AutoFarm: Animal check failed for tile', tileId, e);
    return { hasAnimals: true, count: -1, animals: {} };
  }
}

/**
 * Update cached_oases with animal data found during background check
 * This ensures the Oasis Radar UI (Content Script) reflects background changes.
 */
async function updateRadarKnowledge(tileId, animalsFound) {
  const { cached_oases } = await chrome.storage.local.get('cached_oases');
  const oases = cached_oases || [];
  const idx = oases.findIndex(o => o.id === tileId);
  
  if (idx !== -1) {
    oases[idx].animals = animalsFound;
    await chrome.storage.local.set({ cached_oases: oases });
    console.log(`T10X: Updated Radar knowledge for oasis ${tileId}`);
  }
}

// ============================================================
// ATTACK EXECUTION — Headless fetch to Rally Point (v2v.php)
// ============================================================

/**
 * Execute a raid attack against a target.
 * 
 * Flow:
 *   1. GET v2v.php?id=<tileId> — Load rally page, extract CSRF token + form fields
 *   2. POST v2v.php — Submit troop deployment form (step 1: confirm page)
 *   3. POST v2v.php — Submit confirmation (step 2: execute)
 */
async function executeAttack(farm, troopCount, troopId, sessionKey) {
  let attackTab = null;
  try {
    const attackUrl = `${sessionKey}/v2v.php?id=${farm.id}`;
    console.log(`T10X AutoFarm: Opening hidden attack tab: ${attackUrl}`);

    // Open a hidden background tab and navigate to the rally point page
    attackTab = await chrome.tabs.create({ url: attackUrl, active: false });

    // Wait for the page to fully load
    await waitForTabLoad(attackTab.id);

    // Fill the form and submit it via DOM — exactly as a real user would
    const troopIndex = parseInt(troopId.replace('t', ''));
    const fillResult = await chrome.scripting.executeScript({
      target: { tabId: attackTab.id },
      func: (troopCount, troopIndex, b) => {
        try {
          // Dump all forms on the page for diagnostics
          const forms = [...document.querySelectorAll('form')].map(f => ({
            name: f.name, action: f.action, inputs: [...f.querySelectorAll('input,select,button')].map(el => ({
              type: el.type, name: el.name, value: el.value, id: el.id, tag: el.tagName
            }))
          }));

          // Fill in the troop count
          const input = document.querySelector(`input[name="t[${troopIndex}]"]`) 
                     || document.getElementById(`t${troopIndex}`);
          if (!input) return { ok: false, error: `Troop input t[${troopIndex}] not found`, forms };

          // Check available troops:
          // When troops ARE available: <a href="#" onclick="_('t1').value=N">(N)</a> + input class="text"
          // When troops are 0: <span class="none">(0)</span> + input class="text disabled"
          if (input.classList.contains('disabled')) {
            return { ok: false, error: 'no_troops', available: 0 };
          }
          const availLink = input.closest('td')?.querySelector('a[onclick]');
          const availSpan = input.closest('td')?.querySelector('span.none');
          const availMatch = availLink?.textContent?.match(/(\d+)/) || availSpan?.textContent?.match(/(\d+)/);
          const available = availMatch ? parseInt(availMatch[1]) : null;
          if (available !== null && available === 0) {
            return { ok: false, error: 'no_troops', available: 0 };
          }
          // Cap requested count to what's available
          const sendCount = (available !== null) ? Math.min(troopCount, available) : troopCount;
          // Rule: Never send just 1 troop, it will die to base defense. Wait for more troops to build up instead.
          if (sendCount < 2) return { ok: false, error: 'no_troops', available };

          input.value = sendCount;

          // Set attack type if there's a select
          const bSelect = document.querySelector('select[name="b"]');
          if (bSelect) bSelect.value = b;

          // Find and click the submit button — s1 first, then any submit
          const submitBtn = document.querySelector('input[name="s1"]')
                         || document.querySelector('button[name="s1"]')
                         || document.querySelector('input[type="submit"]')
                         || document.querySelector('button[type="submit"]');

          const submitInfo = submitBtn 
            ? { found: true, name: submitBtn.name, type: submitBtn.type, value: submitBtn.value }
            : { found: false };

          if (!submitBtn) return { ok: false, error: 'No submit button found', forms, submitInfo };

          submitBtn.click();
          return { ok: true, submitInfo, troopIndex, troopCount, bSelect: !!bSelect, forms };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
      args: [troopCount, troopIndex, 4]
    });

    const fillRes = fillResult?.[0]?.result;
    console.log(`T10X AutoFarm: [DIAG] Form fill result:`, fillRes);

    if (!fillRes?.ok) {
      return { success: false, error: fillRes?.error || 'Form fill failed' };
    }

    // Wait for the page to load after clicking submit (redirect to confirmation or success)
    await waitForTabLoad(attackTab.id);

    // Check the resulting page
    const checkResult = await chrome.scripting.executeScript({
      target: { tabId: attackTab.id },
      func: () => {
        const h1 = document.querySelector('h1')?.textContent || '';
        const h1Lower = h1.toLowerCase();
        const url = window.location.href;
        const contentHtml = document.getElementById('content')?.innerHTML?.substring(0, 3000) || '';

        // Collect ALL interactive elements for diagnostics
        const allButtons = [...document.querySelectorAll('input,button,a')].map(el => ({
          tag: el.tagName, type: el.type || '', name: el.name || '',
          value: el.value || el.textContent?.trim()?.substring(0, 30), id: el.id
        })).filter(el => el.type === 'submit' || el.name || el.tag === 'A');

        // Detect confirmation pages: 'raid on', 'confirm', 'finish', etc.
        const isConfirmPage = h1Lower.includes('raid on') 
                           || h1Lower.includes('confirm') 
                           || h1Lower.includes('finish')
                           || h1Lower.includes('raid');

        if (isConfirmPage) {
          // Extract arrival time from the confirmation table before clicking OK
          // Format: "in 0:06:59  at 21:10:09"
          const arrivalText = document.querySelector('tbody.infos th, tr th')?.closest('tr')?.textContent
                           || document.getElementById('content')?.innerText || '';
          const travelMatch = arrivalText.match(/in\s+(\d+):(\d+):(\d+)/i);
          const arrivalTimeMatch = document.getElementById('timer2')?.textContent
                                || arrivalText.match(/at\s+(\d+:\d+:\d+)/i)?.[1] || '';

          let travelSec = 0;
          if (travelMatch) {
            travelSec = parseInt(travelMatch[1]) * 3600 + parseInt(travelMatch[2]) * 60 + parseInt(travelMatch[3]);
          }

          // Try every possible confirm button pattern
          const confirmBtn = document.getElementById('btn_ok')
                          || document.querySelector('input[type="image"]')
                          || document.querySelector('input[name="s1"]')
                          || document.querySelector('input[name="s2"]')
                          || document.querySelector('button[name="s2"]')
                          || document.querySelector('input[name="ok"]')
                          || document.querySelector('button[name="ok"]')
                          || document.querySelector('input[type="submit"]')
                          || document.querySelector('button[type="submit"]')
                          || document.querySelector('button[type="button"]')
                          || document.querySelector('#content input')
                          || document.querySelector('#content button');

          if (confirmBtn) {
            confirmBtn.click();
            return { step: 'confirming', h1, url, travelSec, arrivalTime: arrivalTimeMatch,
                     clickedBtn: { name: confirmBtn.name, value: confirmBtn.value, tag: confirmBtn.tagName } };
          }

          // Nuclear fallback: submit the game form directly
          const sndForm = document.querySelector('form[name="snd"]') || document.querySelector('#content form');
          if (sndForm) {
            sndForm.submit();
            return { step: 'confirming', h1, url, travelSec, arrivalTime: arrivalTimeMatch, clickedBtn: 'formSubmit' };
          }
        }

        return { step: 'done', h1, url, contentHtml: contentHtml.substring(0, 1500), allButtons: JSON.stringify(allButtons) };
      }
    });

    const checkRes = checkResult?.[0]?.result;
    console.log(`T10X AutoFarm: [DIAG] Page h1="${checkRes?.h1}" step=${checkRes?.step}`);
    if (checkRes?.step === 'done') {
      console.log(`T10X AutoFarm: [DIAG] Content HTML:`, checkRes?.contentHtml);
      console.log(`T10X AutoFarm: [DIAG] All buttons:`, checkRes?.allButtons);
    } else {
      console.log(`T10X AutoFarm: [DIAG] Clicked:`, checkRes?.clickedBtn);
    }

    let finalH1 = checkRes?.h1 || '';

    if (checkRes?.step === 'confirming') {
      // Wait for the final page after clicking confirm
      await waitForTabLoad(attackTab.id);

      const finalResult = await chrome.scripting.executeScript({
        target: { tabId: attackTab.id },
        func: () => ({
          h1: document.querySelector('h1')?.textContent || '',
          url: window.location.href,
          contentHtml: document.getElementById('content')?.innerHTML?.substring(0, 1000) || ''
        })
      });
      const final = finalResult?.[0]?.result;
      console.log(`T10X AutoFarm: [DIAG] Final page after confirm:`, final);
      finalH1 = final?.h1 || '';
    }

    // Success: we must be OFF the "Send troops" page (that means it progressed)
    if (finalH1.toLowerCase().includes('send troops')) {
      return { success: false, error: 'Still on Send troops page — attack rejected' };
    }

    const travelSec = checkRes?.travelSec || 360;
    const arrivalTime = checkRes?.arrivalTime || '';
    console.log(`T10X AutoFarm: [DIAG] Travel: ${travelSec}s, Arrival at: ${arrivalTime}`);

    return { success: true, dispatchTime: Date.now(), travelSec, arrivalTime };

  } catch (e) {
    console.error('T10X AutoFarm: [DIAG] Exception in executeAttack:', e);
    return { success: false, error: e.message };
  } finally {
    // Always close the attack tab when done
    if (attackTab?.id) {
      try { await chrome.tabs.remove(attackTab.id); } catch (_) {}
    }
  }
}

/**
 * Wait for a tab to finish loading (status = 'complete').
 */
function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Tab ${tabId} load timed out`));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        // Small buffer to let the page JS settle
        setTimeout(resolve, 300);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    // Also check if already complete
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 300);
      }
    }).catch(() => reject(new Error('Tab not found')));
  });
}


/**
 * Extract all hidden <input> fields from an HTML string.
 * Returns a plain object { fieldName: fieldValue }.
 */
function extractHiddenFields(html) {
  const fields = {};
  const regex = /<input[^>]+type=[\"']hidden[\"'][^>]*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const tag = match[0];
    const nameM = tag.match(/name=[\"']([^\"']+)[\"']/i);
    const valueM = tag.match(/value=[\"']([^\"']*)[\"']/i);
    if (nameM) {
      fields[nameM[1]] = valueM ? valueM[1] : '';
    }
  }
  return fields;
}

// ============================================================
// REPORT SCRAPER — Temporal & Troop Count Heuristic Matching
// ============================================================

/**
 * Deterministic Report Sync Engine
 * Fetches the reports hub, identifies unseen reports, parses them deeply,
 * and stores them in a centralized, deterministic storage keyed by Target Tile ID.
 */
async function syncReports(globalSettings) {
  try {
    const sessionKey = await getSessionKey();
    if (!sessionKey) return;

    // We can fetch report.php?t=3 (Attacks) to only see attack reports
    const reportsResult = await fetchInGameTab(`${sessionKey}/report.php?t=3`);
    if (!reportsResult.ok) return;

    const reportsHtml = reportsResult.text;

    // Extract all report IDs from the hub page
    const reportLinkRegex = /report\.php\?id=(\d+)/g;
    const recentReportIds = [];
    let match;
    while ((match = reportLinkRegex.exec(reportsHtml)) !== null) {
      if (!recentReportIds.includes(match[1])) {
        recentReportIds.push(match[1]);
      }
    }

    if (recentReportIds.length === 0) return;

    // Load persistent state
    const storageData = await chrome.storage.local.get(['processed_report_ids', 'report_cache']);
    const processedIds = storageData.processed_report_ids || [];
    const reportCache = storageData.report_cache || {};

    let cacheModified = false;
    let processedModified = false;

    // Parse unseen reports in order (oldest first to ensure correct overwrite sequence)
    // Actually, recentReportIds is newest-first. Let's process newest-first, and simply
    // overwrite older ones if needed, or if we reverse we build up the correctly.
    // Reversing ensures the latest report is processed last, leaving it in the cache!
    const unseenIds = recentReportIds.filter(id => !processedIds.includes(id)).reverse();

    // Parallel Sync Engine: Fetch unseen reports in batches
    const batchSize = 5;
    for (let i = 0; i < unseenIds.length; i += batchSize) {
      const batch = unseenIds.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (reportId) => {
        const reportResult = await fetchInGameTab(`${sessionKey}/report.php?id=${reportId}`);
        if (!reportResult.ok) return;

        const html = reportResult.text;
        const text = html.replace(/<[^>]+>/g, ' ');

        // 1. Extract Target Tile ID
        const defenderBlock = html.match(/(?:Defender|Verteidiger|Défenseur)[\s\S]{0,1000}?(?:tbody\s+class="units"|table\s+cellpadding)/i) 
                          || html.match(/(?:Defender|Verteidiger|Défenseur)[\s\S]{0,500}/i);
        
        let targetTileId = null;
        if (defenderBlock) {
          const idMatch = defenderBlock[0].match(/village3\.php\?id=(\d+)/i);
          if (idMatch) targetTileId = idMatch[1];
        }

        if (!targetTileId) {
          processedIds.push(reportId);
          processedModified = true;
          return;
        }

        // 2. Extract Exact Time
        let timeMatch = html.match(/class=["']sent["'][^>]*>[\s\S]*?<span>\s*([\d:]+)\s*<\/span>/i);
        let reportTimeStr = timeMatch ? timeMatch[1] : null;

        // 3. Extract attacker troops sent
        const reportedTroops = extractAttackerTroopCount(html);
        
        // 4. Extract Casualties and Bounty
        const hasCasualties = detectCasualties(html, text);
        const carryCapacity = globalSettings?.troop_carry_capacity || 50;
        const bountyInfo = detectBounty(html, text, reportedTroops || 1, carryCapacity);

        // Store in Cache
        reportCache[targetTileId] = {
          reportId: reportId,
          targetTileId: targetTileId,
          timeParsed: Date.now(),
          reportTimeStr: reportTimeStr,
          hasCasualties: hasCasualties,
          bountyTotal: bountyInfo.total,
          bountyPercent: bountyInfo.percent,
          isFull: bountyInfo.isFull,
          troopsSentRecorded: reportedTroops
        };

        cacheModified = true;
        processedIds.push(reportId);
        processedModified = true;

        console.log(`T10X AutoFarm: Synced Report ${reportId} for Tile ${targetTileId}`);
      }));

      // Small delay between batches to avoid server throttling
      if (i + batchSize < unseenIds.length) await delay(300);
    }

    // Keep processed list from leaking memory infinitely (keep last 500)
    if (processedIds.length > 500) {
      processedIds.splice(0, processedIds.length - 500);
      processedModified = true;
    }

    const updates = {};
    if (cacheModified) updates.report_cache = reportCache;
    if (processedModified) updates.processed_report_ids = processedIds;
    
    if (cacheModified || processedModified) {
      await chrome.storage.local.set(updates);
    }

  } catch (e) {
    console.error(`T10X AutoFarm: Report sync error`, e);
  }
}

/**
 * Checks active farms against the report cache to perform state transitions.
 * Called immediately after syncing reports.
 */
async function processFarmTransitions() {
  const settings = await chrome.storage.local.get(['active_farm_list', 'report_cache']);
  const farmList = settings.active_farm_list || [];
  const cache = settings.report_cache || {};

  if (farmList.length === 0 || Object.keys(cache).length === 0) return;

  let listModified = false;

  for (const farm of farmList) {
    // Only process farms that we hit and might need a state transition
    if (!farm.lastHit || farm.state === 'dead') continue;

    const report = cache[farm.id];
    if (!report) continue;

    // Check if we already applied this specific report
    if (farm.lastAppliedReportId === report.reportId) continue;

    // Check if report time exactly matches our recorded exact arrival time
    const exactArrivalStr = farm.exactArrivalTime ? farm.exactArrivalTime.trim() : null;
    const reportTimeStr = report.reportTimeStr ? report.reportTimeStr.trim() : null;
    
    // An exact match confirms unequivocally that this report belongs to this dispatch.
    const isExactMatch = exactArrivalStr && reportTimeStr && exactArrivalStr === reportTimeStr;
    
    // If we don't have an exact match (e.g., legacy data or slight parse variance),
    // fallback to ensuring the current physical time is realistically AFTER the expected arrival time 
    // AND the report was newly discovered after we dispatched our troops.
    const hasArrived = farm.estimatedArrivalTime && Date.now() > (farm.estimatedArrivalTime - 2000);
    const isNewReport = report.timeParsed > farm.lastHit;

    if (isExactMatch || (!exactArrivalStr && hasArrived && isNewReport)) {
      console.log(`T10X AutoFarm: Applying Report ${report.reportId} to Farm ${farm.coords}`);

      if (report.hasCasualties) {
        console.log(`T10X AutoFarm: CASUALTIES detected at ${farm.coords} — entering DEAD state`);
        farm.state = 'dead';
        farm.deadSince = Date.now();
      } else if (report.isFull) {
        console.log(`T10X AutoFarm: Bounty FULL at ${farm.coords} — entering OVERFLOW state`);
        farm.state = 'overflow';
        farm.lastBountyFull = true;
      } else {
        console.log(`T10X AutoFarm: Bounty partial at ${farm.coords} — entering STEADY_STATE`);
        farm.state = 'steady_state';
        farm.lastBountyFull = false;
        farm.timeEmptied = Date.now();
      }

      farm.lastAppliedReportId = report.reportId;
      farm.exactArrivalTime = report.reportTimeStr || farm.exactArrivalTime;
      farm.lastBountyPercent = report.bountyPercent || 0;
      listModified = true;
    }
  }

  if (listModified) {
    await chrome.storage.local.set({ active_farm_list: farmList });
  }
}

/**
 * Detect if the attacker suffered any troop losses (pure regex, no DOM)
 */
function detectCasualties(html, text) {
  // Look for loss indicators in the HTML structure
  // T3.6 reports show attacker losses in a table with class att_losses or losses
  // Pattern: <td class="val">N</td> inside a losses section
  const lossSection = html.match(/(?:att_losses|losses)[\s\S]{0,500}/i);
  if (lossSection) {
    const nums = lossSection[0].match(/class=["']val["'][^>]*>\s*(\d+)/gi) || [];
    for (const m of nums) {
      const val = parseInt(m.match(/(\d+)$/)?.[1] || '0');
      if (val > 0) return true;
    }
  }

  // Fallback text patterns
  if (/(?:losses|verluste|pertes)[\s\S]{0,200}[1-9]/i.test(text)) {
    const attackerSection = text.split(/defender|verteidiger/i)[0] || text;
    if (/(?:losses|verluste|pertes)[\s\S]{0,100}[1-9]/i.test(attackerSection)) {
      return true;
    }
  }

  return false;
}

/**
 * Detect bounty amount and whether it was at full capacity (pure regex, no DOM)
 */
function detectBounty(html, text, troopsSent, carryCapacity) {
  const maxCarry = (troopsSent || 1) * carryCapacity;

  // Look for bounty/resources in the report text
  // Pattern: "Bounty: 200 | 150 | 100 | 50" or "Bounty: 200 150 100 50"
  let totalBounty = 0;
  const bountyMatch = text.match(/(?:bounty|beute|butin)[:\s]*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)/i)
                   || text.match(/(?:bounty|beute|butin)[\s\S]{0,50}?(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/i);

  if (bountyMatch) {
    totalBounty = parseInt(bountyMatch[1]) + parseInt(bountyMatch[2]) 
                + parseInt(bountyMatch[3]) + parseInt(bountyMatch[4]);
  } else {
    // Fallback: look for bounty section in HTML and extract numbers
    const bountySection = html.match(/(?:bounty|beute|butin)[\s\S]{0,300}/i);
    if (bountySection) {
      const numbers = bountySection[0].match(/>\s*(\d+)\s*</g) || [];
      const resNumbers = numbers.map(m => parseInt(m.replace(/[^\d]/g, ''))).filter(n => !isNaN(n) && n > 0);
      if (resNumbers.length >= 4) {
        totalBounty = resNumbers.slice(0, 4).reduce((sum, v) => sum + v, 0);
      }
    }
  }

  const ratio = maxCarry > 0 ? totalBounty / maxCarry : 0;
  return {
    total: totalBounty,
    maxCarry,
    percent: Math.min(100, Math.round(ratio * 100)),
    isFull: ratio >= 0.95
  };
}

/**
 * Helper to extract the total number of attacking troops from a report DOM string
 * Used as a heuristic fingerprint to identify reports.
 */
function extractAttackerTroopCount(html) {
  const attackerBlock = html.match(/(?:attacker|angreifer|attaquant)[\s\S]{0,2500}/i);
  if (!attackerBlock) return -1;
  const blockHtml = attackerBlock[0];

  const tbodyMatch = blockHtml.match(/class=["']units["'][^>]*>([\s\S]*?)<\/tbody>/i);
  if (tbodyMatch) {
    const rows = tbodyMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
    if (rows && rows.length >= 2) {
      let targetRow = rows[1];
      for (const row of rows) {
        if (/(?:troops|truppen|troupes|cantidad|quantité)/i.test(row)) {
          targetRow = row;
          break;
        }
      }
      
      const tds = targetRow.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
      let sum = 0;
      for (const td of tds) {
        const cleanText = td.replace(/<[^>]+>/g, '');
        const val = parseInt(cleanText.replace(/\D/g, '')) || 0;
        sum += val;
      }
      if (sum > 0) return sum;
    }
  }

  // Fallback for older layouts
  const troopsRow = blockHtml.match(/(?:<th>|<td>)(?:troops|truppen|troupes|cantidad)[^<]*<\/(?:th|td)>([\s\S]*?)<\/tr>/i);
  if (troopsRow) {
    const tds = troopsRow[1].match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    let sum = 0;
    for (const td of tds) {
      const cleanText = td.replace(/<[^>]+>/g, '');
      const val = parseInt(cleanText.replace(/\D/g, '')) || 0;
      sum += val;
    }
    if (sum > 0) return sum;
  }

  return -1;
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/**
 * Find the game tab ID (any tab with travian/zravian open)
 */
async function getGameTabId() {
  console.log('T10X AutoFarm: [DEBUG] Searching for game tab...');
  try {
    const allTabs = await chrome.tabs.query({});
    
    // Sort tabs: prioritize 'zravian' over 'travian' and ignore manual/help pages
    const candidates = allTabs.filter(tab => {
      if (!tab.url) return false;
      const url = tab.url.toLowerCase();
      // Must contain game keyword
      const isWordMatch = url.includes('travian') || url.includes('zravian');
      if (!isWordMatch) return false;
      
      // Must NOT be a manual, forum, or marketing page
      const isManual = url.includes('manual') || url.includes('forum') || url.includes('help') || url.includes('support') || url.includes('blog');
      return !isManual;
    });

    if (candidates.length > 0) {
      // Prioritize the active tab if it's among candidates
      const activeCandidate = candidates.find(t => t.active);
      const target = activeCandidate || candidates[0];
      console.log(`T10X AutoFarm: [DEBUG] Found valid game tab ID: ${target.id} (URL: ${target.url})`);
      return target.id;
    }

    console.warn('T10X AutoFarm: [DEBUG] No actual game tab found (searched all windows)');
    return null;
  } catch (e) {
    console.error('T10X AutoFarm: [DEBUG] Failed to query tabs', e);
    return null;
  }
}

/**
 * Get session key by querying the active game tab
 */
/**
 * Get the game tab's base URL for constructing fetch requests.
 * Auth is handled automatically via browser cookies — no session key needed.
 */
async function getSessionKey() {
  try {
    const tabId = await getGameTabId();
    if (!tabId) return null;

    // Get the base URL from tab metadata (no scripting needed)
    const allTabs = await chrome.tabs.query({});
    const gameTab = allTabs.find(t => t.id === tabId);
    if (!gameTab?.url) return null;

    const url = new URL(gameTab.url);
    const baseUrl = url.origin; // e.g. https://nonstop.zravian.com
    console.log(`T10X AutoFarm: [DEBUG] Game base URL: ${baseUrl}`);
    return baseUrl; // Return base URL as the "session key"
  } catch (e) {
    console.error('T10X AutoFarm: [DEBUG] Failed to get game URL', e);
    return null;
  }
}

/**
 * Execute a fetch inside the game tab's context (required for cookies/session).
 * Accepts a full absolute URL. Auth is handled via the browser's cookie jar.
 */
async function fetchInGameTab(fullUrl, options = {}) {
  const tabId = await getGameTabId();
  if (!tabId) throw new Error('No game tab found');

  console.log(`T10X AutoFarm: [FETCH] ${options.method || 'GET'} ${fullUrl}`);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (url, opts) => {
      try {
        const fetchOpts = { credentials: 'include' }; // 'include' ensures cookies are sent
        if (opts.method) fetchOpts.method = opts.method;
        if (opts.headers) fetchOpts.headers = opts.headers;
        if (opts.body) fetchOpts.body = opts.body;
        const response = await fetch(url, fetchOpts);
        return { ok: response.ok, status: response.status, text: await response.text() };
      } catch (e) {
        return { ok: false, status: 0, text: '', error: e.message };
      }
    },
    args: [fullUrl, options]
  });

  const result = results?.[0]?.result;
  if (!result) throw new Error('Script execution returned no result');
  if (result.error) throw new Error(result.error);
  return result;
}

/**
 * Estimate travel time in milliseconds based on distance (rough T3.6 speeds)
 */
function estimateTravelTime(distance) {
  // T3.6 infantry speed ~ 7 fields per hour at speed 1x
  // On a 10x server, speed is 10x faster
  const fieldsPerHour = 70; // 7 base * 10x
  const travelHours = (distance || 1) / fieldsPerHour;
  return travelHours * 3600 * 1000;
}

/**
 * Promise-based delay
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('T10X AutoFarm: Background service worker loaded');

// ============================================================
// INFINITE TASK MANAGER — EXECUTION ENGINE
// ============================================================

let isTaskManagerRunning = false;

async function runTaskManagerCycle() {
  if (isTaskManagerRunning) return;
  isTaskManagerRunning = true;

  try {
    const settings = await chrome.storage.local.get([
      'is_task_manager_active',
      'task_queue',
      'village_buildings',
      'player_tribe',
      'auto_npc_enabled',
      'native_queue_blocks'
    ]);

    if (!settings.is_task_manager_active) {
      await chrome.storage.local.set({ task_manager_status: 'Disabled' });
      return;
    }

    const queue = settings.task_queue || [];
    if (queue.length === 0) {
      await chrome.storage.local.set({ task_manager_status: 'Idle (Queue Empty)' });
      return;
    }

    console.log('T10X TaskMgr: [CHECK] Cycle started. Tribe:', settings.player_tribe, 'Queue length:', queue.length);

    // 1. Queue Status & Roman-Awareness
    // native_queue_blocks structure: [{type: 'field'}, {type: 'building'}] from content.js
    const nativeBlocks = settings.native_queue_blocks || [];
    let canBuildField = false;
    let canBuildInfra = false;

    if (settings.player_tribe === 'roman') {
      const hasField = nativeBlocks.some(b => b.type === 'field');
      const hasInfra = nativeBlocks.some(b => b.type === 'building');
      canBuildField = !hasField;
      canBuildInfra = !hasInfra;
    } else {
      const hasAny = nativeBlocks.length > 0;
      canBuildField = !hasAny;
      canBuildInfra = !hasAny;
    }

    if (!canBuildField && !canBuildInfra) {
      const waitMsg = settings.player_tribe === 'roman' ? 'Waiting (Native Slots Full)' : 'Waiting (Construction in progress)';
      await chrome.storage.local.set({ task_manager_status: waitMsg });
      console.log('T10X TaskMgr: [SKIP] Native queue is full.');
      return;
    }

    // 2. Head of Queue
    const task = queue[0];
    if (task.status === 'active') {
      // It's actively building, wait for DOM sync to remove it
      return; 
    }

    // Is it a field or a building?
    // We rely on content.js populating task.isField when pushing to queue, or we determine it here.
    const isField = task.buildId >= 1 && task.buildId <= 18;
    
    if (isField && !canBuildField) {
      await chrome.storage.local.set({ task_manager_status: 'Waiting (Infrastructure Slot Busy)' });
      console.log('T10X TaskMgr: [SKIP] Cannot build field right now.');
      return;
    }
    if (!isField && !canBuildInfra) {
      await chrome.storage.local.set({ task_manager_status: 'Waiting (Field Slot Busy)' });
      console.log('T10X TaskMgr: [SKIP] Cannot build infra right now.');
      return;
    }

    // 3. Dispatch Logic
    // In Travian 3.6, building requires fetching the node page, then extracting the upgrade link with the `c=` token.
    console.log('T10X TaskMgr: [READY] Task is ready to build:', task);
    
    // Check session
    const tabs = await chrome.tabs.query({ url: "*://*.zravian.com/*" });
    if (tabs.length === 0) {
      console.log('T10X TaskMgr: [PAUSED] No active Zravian tabs to construct session relative URL');
      return; 
    }
    const sessionOrigin = new URL(tabs[0].url).origin;

    // Fetch the build page
    const buildUrl = `${sessionOrigin}/build.php?id=${task.buildId}`;
    const buildResp = await fetch(buildUrl);
    const buildHtml = await buildResp.text();

    if (buildHtml.includes('Not enough resources') || buildHtml.includes('Zu wenig Rohstoffe')) {
      await chrome.storage.local.set({ task_manager_status: 'Waiting (Insufficient Resources)' });
      console.log('T10X TaskMgr: [WAITING] Not enough resources for task:', task);
      return;
    }

    // Find the build/upgrade link (Check both a/c and id/k parameter styles)
    // Zravian uses id=X&k=Y for fields/buildings
    const upgradeRegex = new RegExp(`href=["']([^"']*\\.php\\?[^"']*((id=${task.buildId}&k=[a-z0-9]+)|(k=[a-z0-9]+&id=${task.buildId})|(a=${task.buildId}&c=[a-z0-9]+)|(c=[a-z0-9]+&a=${task.buildId}))[^"']*)["']`, 'i');
    const linkMatch = buildHtml.match(upgradeRegex);
                      
    if (linkMatch) {
      await chrome.storage.local.set({ task_manager_status: 'Executing...' });
      const execUrl = `${sessionOrigin}/${linkMatch[1].replace(/&amp;/g, '&')}`;
      console.log('T10X TaskMgr: Executing upgrade via:', execUrl);
      
      const execResp = await fetch(execUrl);
      if (execResp.ok) {
        // Success, remove from queue
        queue.shift();
        await chrome.storage.local.set({ task_queue: queue, task_manager_status: 'Success' });
        console.log('T10X TaskMgr: [SUCCESS] Task completed and removed from queue');
      }
    } else {
      await chrome.storage.local.set({ task_manager_status: 'Error (Link Not Found)' });
      console.log('T10X TaskMgr: [ERROR] Could not find upgrade link on build.php for task:', task);
    }

  } catch (e) {
    console.error('T10X TaskMgr: Cycle error', e);
  } finally {
    isTaskManagerRunning = false;
  }
}
