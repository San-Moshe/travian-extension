document.addEventListener('DOMContentLoaded', function() {
  // Toggle (checkbox) settings
  const toggleSettings = [
    'overflowMonitor',
    'queueAlarm',
    'cropRadar',
    'oasisScanner',
    'roiCalculator',
    'protectionTracker'
  ];

  // Numeric input settings with their defaults
  const numericSettings = {
    'scanRadius': 70,
    'troop_carry_capacity': 60,
    'base_probe_size': 3,
    'overflow_multiplier': 2.0,
    'autofarm_interval_sec': 60,
    'autofarm_hit_cooldown_sec': 120,
    'dead_blacklist_hours': 48
  };

  // Select (dropdown) settings with their defaults
  const selectSettings = {
    'selected_troop_id': 't1'
  };

  const allKeys = [
    ...toggleSettings,
    ...Object.keys(numericSettings),
    ...Object.keys(selectSettings)
  ];

  // Load all settings from storage
  chrome.storage.local.get(allKeys, function(result) {
    // Toggles
    toggleSettings.forEach(function(setting) {
      const checkbox = document.getElementById(setting);
      if (checkbox) {
        checkbox.checked = result[setting] !== false;
      }
    });

    // Numeric inputs
    for (const [setting, defaultVal] of Object.entries(numericSettings)) {
      const input = document.getElementById(setting);
      if (input) {
        input.value = result[setting] !== undefined ? result[setting] : defaultVal;
      }
    }

    // Select dropdowns
    for (const [setting, defaultVal] of Object.entries(selectSettings)) {
      const select = document.getElementById(setting);
      if (select) {
        select.value = result[setting] || defaultVal;
      }
    }
  });

  // Save toggle settings on change
  toggleSettings.forEach(function(setting) {
    const checkbox = document.getElementById(setting);
    if (checkbox) {
      checkbox.addEventListener('change', function() {
        const update = {};
        update[setting] = checkbox.checked;
        chrome.storage.local.set(update);
      });
    }
  });

  // Save numeric settings on change
  for (const [setting, _defaultVal] of Object.entries(numericSettings)) {
    const input = document.getElementById(setting);
    if (input) {
      input.addEventListener('change', function() {
        const update = {};
        // Use parseFloat for overflow_multiplier, parseInt for everything else
        update[setting] = setting === 'overflow_multiplier'
          ? parseFloat(input.value)
          : parseInt(input.value);
        chrome.storage.local.set(update);
      });
    }
  }

  // Save select settings on change
  for (const [setting, _defaultVal] of Object.entries(selectSettings)) {
    const select = document.getElementById(setting);
    if (select) {
      select.addEventListener('change', function() {
        const update = {};
        update[setting] = select.value;
        chrome.storage.local.set(update);
      });
    }
  }
});
