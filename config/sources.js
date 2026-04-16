// Runtime data source configuration
// Controls which API is used for each data type
// Can be changed via dashboard /settings or by editing this file
// Changes take effect on the next scan — no restart needed

const db = require('../db/db');

// Default source config
const DEFAULTS = {
  priceData:     'alpaca',    // 'alpaca' | 'yahoo' | 'polygon'
  fundamentals:  'yahoo',     // 'yahoo' | 'finnhub'
  marketContext: 'alpaca',    // 'alpaca' | 'yahoo' | 'polygon'
  vix:           'yahoo',     // 'yahoo' | 'alphavantage'
  news:          'yahoo',     // 'yahoo' | 'finnhub'
  sentiment:     'stocktwits',// 'stocktwits' | 'alphavantage' | 'none'
};

// In-memory cache (avoids DB hit on every symbol fetch)
let _cache = null;

async function getSources() {
  if (_cache) return _cache;
  try {
    const rows = await db.query("SELECT * FROM system_config WHERE config_group = 'sources'");
    if (!rows.length) {
      _cache = { ...DEFAULTS };
      return _cache;
    }
    const fromDb = {};
    for (const row of rows) fromDb[row.config_key] = row.config_value;
    _cache = { ...DEFAULTS, ...fromDb };
    return _cache;
  } catch (_) {
    return { ...DEFAULTS };
  }
}

async function setSource(key, value) {
  if (!DEFAULTS.hasOwnProperty(key)) throw new Error(`Unknown source key: ${key}`);
  const validValues = getValidValues(key);
  if (!validValues.includes(value)) {
    throw new Error(`Invalid value '${value}' for '${key}'. Valid: ${validValues.join(', ')}`);
  }
  await db.query(
    `INSERT INTO system_config (config_group, config_key, config_value)
     VALUES ('sources', ?, ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = NOW()`,
    [key, value]
  );
  _cache = null; // invalidate cache
  return getSources();
}

function getValidValues(key) {
  const valid = {
    priceData:     ['alpaca', 'yahoo', 'polygon'],
    fundamentals:  ['yahoo', 'finnhub'],
    marketContext: ['alpaca', 'yahoo', 'polygon'],
    vix:           ['yahoo', 'alphavantage'],
    news:          ['yahoo', 'finnhub'],
    sentiment:     ['stocktwits', 'alphavantage', 'none'],
  };
  return valid[key] || [];
}

function invalidateCache() { _cache = null; }

module.exports = { getSources, setSource, getValidValues, DEFAULTS, invalidateCache };
