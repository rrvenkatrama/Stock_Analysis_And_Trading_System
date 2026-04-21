// Autotrader settings management
const db = require('../db/db');

// Get all settings by category
async function getSettings(category = null) {
  if (category) {
    const row = await db.queryOne(
      'SELECT * FROM autotrader_settings WHERE category = ?',
      [category]
    );
    if (!row) return null;
    // mysql2 auto-parses JSON columns, so check if it's already an object
    const data = typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) : row.settings_json;
    return data || {};
  }

  const rows = await db.query('SELECT category, settings_json FROM autotrader_settings');
  const result = {};
  rows.forEach(row => {
    // mysql2 auto-parses JSON columns, so check if it's already an object
    const data = typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) : row.settings_json;
    result[row.category] = data || {};
  });
  return result;
}

// Update settings for a category
async function updateSettings(category, newSettings, changedBy = 'api') {
  const oldRow = await db.queryOne(
    'SELECT settings_json FROM autotrader_settings WHERE category = ?',
    [category]
  );
  // mysql2 auto-parses JSON columns
  const oldSettings = oldRow
    ? (typeof oldRow.settings_json === 'string' ? JSON.parse(oldRow.settings_json) : oldRow.settings_json)
    : {};

  const newSettingsJson = JSON.stringify(newSettings);
  await db.query(
    'UPDATE autotrader_settings SET settings_json = ?, updated_at = NOW(), updated_by = ? WHERE category = ?',
    [newSettingsJson, changedBy, category]
  );

  // Log change
  const changes = {};
  for (const key in newSettings) {
    if (oldSettings[key] !== newSettings[key]) {
      changes[key] = { old: oldSettings[key], new: newSettings[key] };
    }
  }

  if (Object.keys(changes).length > 0) {
    const changeJson = JSON.stringify(changes);
    await db.query(
      'INSERT INTO settings_changelog (category, change_json, changed_by) VALUES (?, ?, ?)',
      [category, changeJson, changedBy]
    );
  }

  return newSettings;
}

// Get all signal weights
async function getSignalWeights() {
  const rows = await db.query(
    'SELECT signal_name, weight, signal_type, description FROM signal_weights ORDER BY signal_type, signal_name'
  );
  const result = {};
  rows.forEach(row => {
    if (!result[row.signal_type]) result[row.signal_type] = [];
    result[row.signal_type].push({
      name: row.signal_name,
      weight: parseFloat(row.weight),
      description: row.description
    });
  });
  return result;
}

// Get weight for a specific signal
async function getSignalWeight(signalName) {
  const row = await db.queryOne(
    'SELECT weight FROM signal_weights WHERE signal_name = ?',
    [signalName]
  );
  return row ? parseFloat(row.weight) : 1.0;
}

// Update signal weight
async function updateSignalWeight(signalName, weight, changedBy = 'api') {
  const oldRow = await db.queryOne(
    'SELECT weight FROM signal_weights WHERE signal_name = ?',
    [signalName]
  );
  const oldWeight = oldRow ? parseFloat(oldRow.weight) : 1.0;

  if (oldWeight !== weight) {
    await db.query(
      'UPDATE signal_weights SET weight = ? WHERE signal_name = ?',
      [weight, signalName]
    );

    await db.query(
      'INSERT INTO settings_changelog (category, change_json, changed_by) VALUES (?, ?, ?)',
      ['signal_weights', JSON.stringify({ signal: signalName, old: oldWeight, new: weight }), changedBy]
    );
  }

  return weight;
}

// Get changelog (recent changes)
async function getChangelog(limit = 50) {
  return db.query(
    'SELECT * FROM settings_changelog ORDER BY changed_at DESC LIMIT ?',
    [limit]
  );
}

// Get market regime (informational - read from stock_signals)
async function getMarketRegime() {
  const spy = await db.queryOne(
    'SELECT above_200ma, above_50ma FROM stock_signals WHERE symbol = ?',
    ['SPY']
  );
  if (!spy) return { regime: 'unknown', details: 'SPY not in stock_signals' };
  if (!spy.above_200ma) return { regime: 'bear', details: 'SPY below 200MA' };
  if (!spy.above_50ma) return { regime: 'caution', details: 'SPY above 200MA but below 50MA' };
  return { regime: 'bull', details: 'SPY above 200MA and above 50MA' };
}

module.exports = {
  getSettings,
  updateSettings,
  getSignalWeights,
  getSignalWeight,
  updateSignalWeight,
  getChangelog,
  getMarketRegime
};
