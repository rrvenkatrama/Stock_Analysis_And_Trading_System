// Settings cache — keeps settings in memory and reloads periodically
const db = require('../db/db');

let cache = {
  gates: null,
  buy: null,
  sell: null,
  scoring: null,
  golden_cross: null,
  limits: null,
  signal_weights: null,
  lastLoaded: null
};

// Load settings from database into memory cache
async function reloadSettings() {
  try {
    const settings = require('./settings');
    const [allSettings, weights] = await Promise.all([
      settings.getSettings(),
      settings.getSignalWeights()
    ]);

    cache.gates = allSettings.gates || {};
    cache.buy = allSettings.buy || {};
    cache.sell = allSettings.sell || {};
    cache.scoring = allSettings.scoring || {};
    cache.golden_cross = allSettings.golden_cross || {};
    cache.limits = allSettings.limits || {};

    // Flatten signal weights into a simple lookup map
    cache.signal_weights = {};
    for (const type in weights) {
      weights[type].forEach(sig => {
        cache.signal_weights[sig.name] = sig.weight;
      });
    }

    cache.lastLoaded = new Date();
    console.log('[Settings Cache] Loaded at', cache.lastLoaded.toLocaleString('en-US', {timeZone:'America/New_York'}));
  } catch (err) {
    console.error('[Settings Cache] Error loading:', err.message);
  }
}

// Get a setting value with fallback to default
function get(category, key, defaultValue = null) {
  if (!cache[category]) return defaultValue;
  return cache[category][key] !== undefined ? cache[category][key] : defaultValue;
}

// Get signal weight (default 0 for unmapped signals)
function getSignalWeight(signalName) {
  if (!cache.signal_weights) return 0;
  if (cache.signal_weights[signalName] === undefined) {
    console.warn(`[Settings Cache] Signal weight not found: ${signalName}`);
    return 0;
  }
  return cache.signal_weights[signalName];
}

// Get all gates settings as object
function getGates() {
  return cache.gates || {};
}

// Get all buy settings as object
function getBuy() {
  return cache.buy || {};
}

// Get all sell settings as object
function getSell() {
  return cache.sell || {};
}

// Get all scoring settings as object
function getScoring() {
  return cache.scoring || {};
}

// Get all golden cross settings as object
function getGoldenCross() {
  return cache.golden_cross || {};
}

// Get all position limits as object
function getLimits() {
  return cache.limits || {};
}

// Initialize on startup and reload every 5 minutes
async function initializeCache() {
  await reloadSettings();
  // Reload every 5 minutes
  setInterval(reloadSettings, 5 * 60 * 1000);
}

module.exports = {
  initializeCache,
  reloadSettings,
  get,
  getSignalWeight,
  getGates,
  getBuy,
  getSell,
  getScoring,
  getGoldenCross,
  getLimits,
  cache: () => cache // expose full cache for debugging
};
