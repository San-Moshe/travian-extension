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
  dead_blacklist_hours: 48
};

const ALARM_NAME = 'autofarm-loop';

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
  const existing = await chrome.storage.local.get(Object.keys(AUTOFARM_DEFAULTS));
  const toSet = {};
  for (const [key, defaultVal] of Object.entries(AUTOFARM_DEFAULTS)) {
    if (existing[key] === undefined) {
      toSet[key] = defaultVal;
    }
  }
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
    console.log('T10X AutoFarm: Initialized defaults', toSet);
  }
}

async function setupAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 10 / 60 }); // ~10 seconds (dev mode)
  console.log('T10X AutoFarm: Alarm created (10 second interval)');
}

// ============================================================
// ALARM HANDLER — Main Entry Point
// ============================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await runFarmCycle();
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
      'dead_blacklist_hours'
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

    let listModified = false;

    // 2. Get session key from the active tab
    const sessionKey = await getSessionKey();
    if (!sessionKey) {
      console.warn('T10X AutoFarm: [ABORT] No session key found! (Must have a game tab open)');
      return;
    }
    console.log('T10X AutoFarm: [READY] Session found, processing targets...');

    // 3. Prioritize targets: Full bounty > Never hit > Normal
    // This ensures limited troops are sent to the most profitable oases first.
    farmList.sort((a, b) => {
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
    listModified = true; // Mark as modified because we changed order

    // 4. Process each farm target
    for (let i = 0; i < farmList.length; i++) {
      const farm = farmList[i];

      // Skip dead farms (blacklisted)
      if (farm.state === 'dead') {
        if (farm.deadSince && (Date.now() - farm.deadSince) > deadBlacklistMs) {
          console.log(`T10X AutoFarm: Reviving dead farm ${farm.coords} after blacklist period`);
          farm.state = 'unknown';
          farm.deadSince = null;
          listModified = true;
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
            listModified = true;
          }
          continue;
        }
      }

      // 4. Safety Check — scrape oasis for animals
      const animalCheck = await checkOasisAnimals(farm.id, sessionKey);
      if (animalCheck.hasAnimals) {
        console.log(`T10X AutoFarm: Animals detected at ${farm.coords} — pausing`);
        farm.state = 'paused_animals';
        listModified = true;
        
        // Update Radar knowledge with new animal discovery
        await updateRadarKnowledge(farm.id, animalCheck.animals);
        continue;
      }

      // Clear paused state if animals are gone
      if (farm.state === 'paused_animals') {
        farm.state = 'unknown';
        listModified = true;
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
        listModified = true;
        console.log(`T10X AutoFarm: Attack sent to ${farm.coords}! Travel: ${Math.round(travelTimeMs/1000)}s, Arrival: ${attackResult.arrivalTime || 'unknown'}, Next in: ${Math.round((farm.nextAttackTime - Date.now())/1000)}s`);

        // 7. Schedule report check right after expected arrival
        setTimeout(() => {
          scrapeLatestReport(farm, globalSettings).catch(e => {
            console.warn(`T10X AutoFarm: Report scrape failed for ${farm.coords}`, e);
          });
        }, travelTimeMs + 2000); // add 2s buffer over arrival time
      } else if (attackResult.error === 'no_troops') {
        // Don't hammer — set a 60s retry window. Troops from earlier raids will return
        // by then, releasing capacity for this farm in round-robin order.
        farm.nextAttackTime = Date.now() + 60000;
        listModified = true;
        console.log(`T10X AutoFarm: [SKIP] ${farm.coords} — no troops available, retry in 60s`);
      } else {
        console.warn(`T10X AutoFarm: Attack FAILED for ${farm.coords}:`, attackResult.error);
      }

      // Add jitter between attacks to not hammer the server
      await delay(2000 + Math.random() * 3000);
    }

    // 8. Persist updated farm list
    if (listModified) {
      await chrome.storage.local.set({ active_farm_list: farmList });
    }

  } catch (e) {
    console.error('T10X AutoFarm: Cycle error', e);
  } finally {
    isFarmCycleRunning = false;
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
      return gs.base_probe_size;
    }

    // ---- State B: The Multiplier ----
    case 'overflow': {
      const lastSent = farm.lastTroopsSent || gs.base_probe_size;
      return Math.floor(lastSent * gs.overflow_multiplier);
    }

    // ---- State C: The Optimization ----
    case 'steady_state': {
      const pop = farm.pop || 15; // default oasis "population" estimate
      const pEst = pop * 10; // 10x server hourly production estimate
      const timeEmptied = farm.timeEmptied || farm.lastHit || Date.now();
      const deltaHours = (Date.now() - timeEmptied) / 3600000;
      const totalRes = pEst * deltaHours;
      const troopsNeeded = Math.ceil(totalRes / gs.troop_carry_capacity) + 1;
      // Don't send fewer than probe size
      return Math.max(troopsNeeded, gs.base_probe_size);
    }

    // ---- Fallback ----
    default: {
      return gs.base_probe_size;
    }
  }
}

// ============================================================
// SAFETY CHECK — Scrape oasis for animals
// ============================================================

async function checkOasisAnimals(tileId, sessionKey) {
  try {
    const result = await fetchInGameTab(`${sessionKey}/village3.php?id=${tileId}`);
    if (!result.ok) {
      console.warn('T10X AutoFarm: Animal check HTTP error', result.status);
      return { hasAnimals: true, count: -1, animals: {} };
    }

    const html = result.text;
    let totalAnimals = 0;
    const animals = {};

    // Scrape via BG_ANIMALS names (Regex)
    for (const [key, def] of Object.entries(BG_ANIMALS)) {
      const regex = new RegExp(def.name + '[^<]*?(\\d+)', 'gi');
      const match = html.match(regex);
      if (match) {
        let count = 0;
        for (const m of match) {
          const num = m.match(/(\d+)/);
          if (num) count += parseInt(num[1]) || 0;
        }
        if (count > 0) {
          animals[key] = count;
          totalAnimals += count;
        }
      }
    }

    return { hasAnimals: totalAnimals > 0, count: totalAnimals, animals };
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
          if (sendCount <= 0) return { ok: false, error: 'no_troops', available };

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
 * Scrape the latest battle report for a farm target.
 * Due to the missing coordinates bug on zravian reports, we use a heuristic 
 * matching the exact troop count sent to identify the correct report.
 */
async function scrapeLatestReport(farm, globalSettings) {
  try {
    const sessionKey = await getSessionKey();
    if (!sessionKey) return;

    // Fetch reports page via game tab
    const reportsResult = await fetchInGameTab(`${sessionKey}/report.php`);
    if (!reportsResult.ok) {
      console.warn('T10X AutoFarm: Reports page fetch failed', reportsResult.status);
      return;
    }
    const reportsHtml = reportsResult.text;

    // Extract all report IDs from the first page
    const reportLinkRegex = /report\.php\?id=(\d+)/g;
    const recentReportIds = [];
    let match;
    while ((match = reportLinkRegex.exec(reportsHtml)) !== null) {
      if (!recentReportIds.includes(match[1])) {
        recentReportIds.push(match[1]);
      }
      if (recentReportIds.length >= 5) break; // Check up to top 5 recent reports
    }

    if (recentReportIds.length === 0) {
      console.log(`T10X AutoFarm: No recent reports found to match for ${farm.coords}`);
      return;
    }

    // Heuristic: Fetch reports and find the one that matches our sent troop count
    let targetReportHtml = null;
    let targetReportId = null;

    for (const reportId of recentReportIds) {
      const reportResult = await fetchInGameTab(`${sessionKey}/report.php?id=${reportId}`);
      if (!reportResult.ok) continue;
      
      const currentHtml = reportResult.text;
      const reportedTroops = extractAttackerTroopCount(currentHtml);
      
      // If the report shows exactly the same number of troops we dispatched, we assume it's our match
      if (reportedTroops === farm.lastTroopsSent) {
        targetReportHtml = currentHtml;
        targetReportId = reportId;
        console.log(`T10X AutoFarm: Found matching report ${reportId} for ${farm.coords} using troop heuristic (${farm.lastTroopsSent} units)`);
        break;
      }
    }

    // Fallback: If we couldn't match by troop count, assume the very latest report 
    // is ours since we are scraping ~2 seconds after estimated arrival time.
    if (!targetReportHtml) {
      console.warn(`T10X AutoFarm: Could not match report by troop count for ${farm.coords}. Falling back to newest report.`);
      targetReportId = recentReportIds[0];
      const fbResult = await fetchInGameTab(`${sessionKey}/report.php?id=${targetReportId}`);
      if (fbResult.ok) targetReportHtml = fbResult.text;
    }

    if (!targetReportHtml) return;

    const reportText = targetReportHtml.replace(/<[^>]+>/g, ' ');

    // Update farm list in storage
    const { active_farm_list } = await chrome.storage.local.get('active_farm_list');
    const farmList = active_farm_list || [];
    const farmIndex = farmList.findIndex(f => f.coords === farm.coords);
    if (farmIndex === -1) return;

    const farmRef = farmList[farmIndex];

    // ---- Detect Casualties ----
    const hasCasualties = detectCasualties(targetReportHtml, reportText);
    if (hasCasualties) {
      console.log(`T10X AutoFarm: CASUALTIES detected at ${farm.coords} — entering DEAD state`);
      farmRef.state = 'dead';
      farmRef.deadSince = Date.now();
      await chrome.storage.local.set({ active_farm_list: farmList });
      return;
    }

    // ---- Detect Bounty ----
    const bountyInfo = detectBounty(targetReportHtml, reportText, farmRef.lastTroopsSent, globalSettings.troop_carry_capacity);

    if (bountyInfo.isFull) {
      // Bounty was at max capacity — transition to 'overflow'
      console.log(`T10X AutoFarm: Bounty FULL at ${farm.coords} — entering OVERFLOW state`);
      farmRef.state = 'overflow';
      farmRef.lastBountyFull = true;
    } else {
      // Bounty was partial — farm is empty, transition to 'steady_state'
      console.log(`T10X AutoFarm: Bounty partial at ${farm.coords} — entering STEADY_STATE`);
      farmRef.state = 'steady_state';
      farmRef.lastBountyFull = false;
      farmRef.timeEmptied = Date.now();
    }

    await chrome.storage.local.set({ active_farm_list: farmList });

  } catch (e) {
    console.error(`T10X AutoFarm: Report scrape error for ${farm.coords}`, e);
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
  const bountyMatch = text.match(/(?:bounty|beute|butin)[:\s]*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)/i)
                   || text.match(/(?:bounty|beute|butin)[\s\S]{0,50}?(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/i);

  if (bountyMatch) {
    const totalBounty = parseInt(bountyMatch[1]) + parseInt(bountyMatch[2]) 
                      + parseInt(bountyMatch[3]) + parseInt(bountyMatch[4]);
    const ratio = totalBounty / maxCarry;
    return {
      total: totalBounty,
      maxCarry,
      isFull: ratio >= 0.95
    };
  }

  // Fallback: look for bounty section in HTML and extract numbers
  const bountySection = html.match(/(?:bounty|beute|butin)[\s\S]{0,300}/i);
  if (bountySection) {
    const numbers = bountySection[0].match(/>\s*(\d+)\s*</g) || [];
    const resNumbers = numbers.map(m => parseInt(m.replace(/[^\d]/g, ''))).filter(n => !isNaN(n) && n > 0);
    if (resNumbers.length >= 4) {
      const totalBounty = resNumbers.slice(0, 4).reduce((sum, v) => sum + v, 0);
      return {
        total: totalBounty,
        maxCarry,
        isFull: (totalBounty / maxCarry) >= 0.95
      };
    }
  }

  // If we can't determine, assume partial (conservative)
  return { total: 0, maxCarry, isFull: false };
}

/**
 * Helper to extract the total number of attacking troops from a report DOM string
 * Used as a heuristic fingerprint to identify reports.
 */
function extractAttackerTroopCount(html) {
  const attackerBlock = html.match(/(?:attacker|angreifer|attaquant)[\s\S]{0,1500}/i);
  if (!attackerBlock) return -1;
  const blockHtml = attackerBlock[0];

  // Try to find the row containing troop counts, typically in an element with class "units" or under "Troops"
  const tbodyMatch = blockHtml.match(/class=["']units["'][^>]*>[\s\S]*?(?:<tr>){1,2}([\s\S]*?)<\/tr>/i)
                  || blockHtml.match(/(?:troops|truppen|troupes)[\s\S]*?<\/td>([\s\S]*?)<\/tr>/i);

  if (tbodyMatch) {
    const rowHtml = tbodyMatch[1] || tbodyMatch[0];
    const tds = rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    let sum = 0;
    // Standard T3.6 row has counts for 10 unit types and 1 hero
    for (const td of tds) {
      const val = parseInt(td.replace(/\D/g, '')) || 0;
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
