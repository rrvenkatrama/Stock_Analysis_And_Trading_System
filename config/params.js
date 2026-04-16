// Trading parameter configuration — all tunable values stored in DB
// Editable at runtime via /admin page — no restart needed
// Falls back to DEFAULTS when DB is unavailable or key is missing

const db = require('../db/db');

// ─── Default values ───────────────────────────────────────────────────────────
const DEFAULTS = {

  // ── Risk & position sizing ─────────────────────────────────────────────────
  account_size:           100000,  // Total trading account size ($)
  max_position_pct:       0.10,    // Max % of account per position (0.10 = 10%)
  stop_loss_pct:          0.05,    // Stop loss % below entry (0.05 = 5%)
  max_open_positions:     4,       // Max concurrent open positions
  max_daily_trades:       4,       // Max new trades per day
  cash_buffer_pct:        0.20,    // % of account always kept in cash

  // ── Portfolio allocation ───────────────────────────────────────────────────
  portfolio_deploy_pct:   0.50,    // Deploy up to this % of buying power (0.50 = 50%)
  min_hold_gain_pct:      3,       // Position up this % AND heading to target → never swap
  min_target_remain_pct:  2,       // % still to go to target → let it run
  stop_warn_pct:          1.5,     // % from stop → exit early to protect capital

  // ── Score & probability thresholds ────────────────────────────────────────
  // Scores are 0-100 with 50 = neutral. Threshold 55 = mildly above average.
  // In normal market conditions: weak stocks ~35-45, average ~50, strong 60-75.
  min_score_threshold:    55,      // Min composite score to be a candidate
  min_probability:        55,      // Min probability % to be a candidate
  hold_swap_score_diff:   20,      // Min score improvement needed to suggest swap

  // ── Scoring weights (must sum to 1.0) ─────────────────────────────────────
  w_technical:            0.35,
  w_fundamental:          0.25,
  w_institutional:        0.20,
  w_sentiment:            0.20,

  // ── Technical signal thresholds ────────────────────────────────────────────
  rsi_deeply_oversold:    25,      // RSI below = deeply oversold → +15
  rsi_oversold:           35,      // RSI below = oversold → +10
  rsi_overbought:         70,      // RSI above = overbought → -8
  volume_spike_ratio:     1.5,     // Avg volume multiplier for spike → +4
  volume_strong_ratio:    2.0,     // Avg volume multiplier for strong spike → +7

  // ── VIX thresholds ─────────────────────────────────────────────────────────
  vix_elevated:           25,      // VIX at or above = elevated → -4
  vix_high:               30,      // VIX at or above = high fear → -8
  vix_extreme:            40,      // VIX at or above = extreme fear → -6 (opportunity framing)
  vix_low:                15,      // VIX below = calm market → +3

  // ── VIX adaptive threshold reductions ─────────────────────────────────────
  // When VIX is high, lower the min_score_threshold automatically
  vix_elevated_reduction: 6,       // Points to lower threshold when VIX >= vix_elevated
  vix_high_reduction:     12,      // Points to lower when VIX >= vix_high
  vix_extreme_reduction:  20,      // Points to lower when VIX >= vix_extreme

  // ── Market context score adjustments ──────────────────────────────────────
  spy_death_cross_adj:    -12,     // SPY death cross penalty
  qqq_death_cross_adj:    -8,      // QQQ death cross penalty
  spy_below_200ma_adj:    -8,      // SPY below 200MA penalty
  spy_golden_cross_adj:    5,      // SPY golden cross bonus
  vix_extreme_adj:        -6,      // Score adj when VIX >= vix_extreme
  vix_high_adj:           -8,      // Score adj when VIX >= vix_high
  vix_elevated_adj:       -4,      // Score adj when VIX >= vix_elevated
  vix_low_adj:             3,      // Score bonus when VIX < vix_low
  sector_weak_threshold:  -5,      // Sector 20d return below this = weak
  sector_strong_threshold: 2,      // Sector 20d return above this = strong
  sector_weak_adj:        -6,      // Score penalty for weak sector
  sector_strong_adj:       5,      // Score bonus for strong sector

  // ── Fundamental thresholds ─────────────────────────────────────────────────
  pe_discount_strong:     0.7,     // PE < sector * this = strongly undervalued → +12
  pe_discount_mild:       1.0,     // PE < sector * this = undervalued → +6
  pe_premium:             1.5,     // PE > sector * this = overvalued → -5
  eps_growth_strong:      20,      // EPS growth above = strong → +10
  eps_growth_mild:        10,      // EPS growth above = positive → +6
  revenue_growth_strong:  15,      // Revenue growth above = strong → +7
  revenue_growth_mild:     5,      // Revenue growth above = mild → +4
  debt_equity_low:        0.3,     // D/E below = low debt → +5
  debt_equity_high:       2.0,     // D/E above = high debt → -6
  earnings_imminent_days:  5,      // Earnings within N days = high risk → -10
  earnings_near_days:     14,      // Earnings within N days = watch → -4

  // ── Sentiment thresholds ───────────────────────────────────────────────────
  analyst_buy_pct_strong: 75,      // Buy% above = strong consensus → +10
  analyst_buy_pct_mild:   55,      // Buy% above = mild consensus → +5
  price_target_upside_strong: 20,  // PT upside% above = strong → +8
  price_target_upside_mild:   10,  // PT upside% above = mild → +5
  stocktwits_bull_strong: 75,      // Bulls% above = strong → +6
  stocktwits_bull_mild:   60,      // Bulls% above = mild → +3
  stocktwits_bear:        35,      // Bulls% below = bearish → -4
  news_sentiment_positive: 0.3,    // News avg sentiment above = strong → +6
  news_sentiment_mild:    0.1,     // News avg sentiment above = mild → +3
  news_sentiment_negative:-0.2,    // News avg sentiment below = negative → -5

  // ── Institutional thresholds ───────────────────────────────────────────────
  superinvestor_strong:   2,       // Recently added by N+ superinvestors → +12
  superinvestor_mild:     1,       // Recently added by N superinvestor → +7
  superinvestor_holders:  3,       // Held by N+ superinvestors → +5
  insider_buy_bonus:      8,       // Insider buying detected → +8
  insider_sell_penalty:  -8,       // Insider selling detected → -8
  inst_trans_strong:      2,       // Inst ownership up N+% → +6
  inst_trans_weak:       -5,       // Inst ownership down N% → -6
  inst_own_high:         70,       // Inst ownership above = high → +4
  edgar_filings_strong:   5,       // 13F filers above = strong → +5
  edgar_filings_mild:     2,       // 13F filers above = mild → +3
  short_interest_squeeze: 20,      // Short float% above = squeeze potential → +8
  short_interest_elevated:10,      // Short float% above = elevated → +4
};

// ─── Parameter metadata (for admin UI display) ────────────────────────────────
const PARAM_META = {
  // group → array of { key, label, description, type, min, max, step }
  risk: [
    { key: 'account_size',        label: 'Account Size ($)',      description: 'Total trading account size', type: 'number', min: 0, step: 1000 },
    { key: 'max_position_pct',    label: 'Max Position %',        description: 'Max % of account per position (e.g. 0.10 = 10%)', type: 'number', min: 0.01, max: 0.5, step: 0.01 },
    { key: 'stop_loss_pct',       label: 'Stop Loss %',           description: 'Stop loss below entry price (e.g. 0.05 = 5%)', type: 'number', min: 0.01, max: 0.20, step: 0.01 },
    { key: 'max_open_positions',  label: 'Max Open Positions',    description: 'Max concurrent positions', type: 'number', min: 1, max: 20, step: 1 },
    { key: 'max_daily_trades',    label: 'Max Daily Trades',      description: 'Max new trades per day', type: 'number', min: 1, max: 20, step: 1 },
    { key: 'cash_buffer_pct',     label: 'Cash Buffer %',         description: 'Always keep this % in cash (e.g. 0.20 = 20%)', type: 'number', min: 0, max: 0.5, step: 0.05 },
  ],
  portfolio: [
    { key: 'portfolio_deploy_pct',  label: 'Deploy % of Buying Power', description: 'Max % of buying power to deploy per plan (0.50 = 50%)', type: 'number', min: 0.10, max: 1.0, step: 0.05 },
    { key: 'min_hold_gain_pct',     label: 'Protect Winner Gain %',    description: 'Position up this % AND heading to target → never swap', type: 'number', min: 0, max: 20, step: 0.5 },
    { key: 'min_target_remain_pct', label: 'Min Target Remaining %',   description: '% still to go to target → let position run', type: 'number', min: 0, max: 20, step: 0.5 },
    { key: 'stop_warn_pct',         label: 'Stop Warning %',           description: '% from stop loss → exit early to protect capital', type: 'number', min: 0.5, max: 5, step: 0.5 },
  ],
  thresholds: [
    { key: 'min_score_threshold', label: 'Min Score Threshold',   description: 'Min composite score (0-100) to be a candidate. 50=neutral, 55=mildly bullish, 65=strong', type: 'number', min: 0, max: 100, step: 1 },
    { key: 'min_probability',     label: 'Min Probability %',     description: 'Min probability % to be a candidate (35-85 range)', type: 'number', min: 35, max: 85, step: 1 },
    { key: 'hold_swap_score_diff',label: 'Hold/Swap Score Gap',   description: 'New candidate must score this much higher to recommend swap', type: 'number', min: 5, max: 50, step: 1 },
  ],
  weights: [
    { key: 'w_technical',     label: 'Technical Weight',     description: 'Weight for technical signals (must sum to 1.0 with others)', type: 'number', min: 0, max: 1, step: 0.05 },
    { key: 'w_fundamental',   label: 'Fundamental Weight',   description: 'Weight for fundamental signals', type: 'number', min: 0, max: 1, step: 0.05 },
    { key: 'w_institutional', label: 'Institutional Weight', description: 'Weight for institutional signals', type: 'number', min: 0, max: 1, step: 0.05 },
    { key: 'w_sentiment',     label: 'Sentiment Weight',     description: 'Weight for sentiment signals', type: 'number', min: 0, max: 1, step: 0.05 },
  ],
  technical: [
    { key: 'rsi_deeply_oversold',  label: 'RSI Deeply Oversold',   description: 'RSI below this = deeply oversold (+15 pts)', type: 'number', min: 5, max: 40, step: 1 },
    { key: 'rsi_oversold',         label: 'RSI Oversold',           description: 'RSI below this = oversold (+10 pts)', type: 'number', min: 20, max: 50, step: 1 },
    { key: 'rsi_overbought',       label: 'RSI Overbought',         description: 'RSI above this = overbought (-8 pts)', type: 'number', min: 50, max: 90, step: 1 },
    { key: 'volume_spike_ratio',   label: 'Volume Spike Ratio',     description: 'Volume multiplier for spike signal (+4 pts)', type: 'number', min: 1.0, max: 5.0, step: 0.1 },
    { key: 'volume_strong_ratio',  label: 'Volume Strong Ratio',    description: 'Volume multiplier for strong spike (+7 pts)', type: 'number', min: 1.5, max: 10, step: 0.5 },
  ],
  vix: [
    { key: 'vix_elevated',           label: 'VIX Elevated Level',       description: 'VIX at or above = elevated fear', type: 'number', min: 15, max: 40, step: 1 },
    { key: 'vix_high',               label: 'VIX High Level',           description: 'VIX at or above = high fear', type: 'number', min: 20, max: 50, step: 1 },
    { key: 'vix_extreme',            label: 'VIX Extreme Level',        description: 'VIX at or above = extreme fear', type: 'number', min: 30, max: 80, step: 1 },
    { key: 'vix_low',                label: 'VIX Low Level',            description: 'VIX below = calm market (bonus)', type: 'number', min: 10, max: 20, step: 1 },
    { key: 'vix_elevated_reduction', label: 'VIX Elevated Threshold ↓', description: 'Points to lower min score when VIX >= elevated', type: 'number', min: 0, max: 30, step: 1 },
    { key: 'vix_high_reduction',     label: 'VIX High Threshold ↓',    description: 'Points to lower min score when VIX >= high', type: 'number', min: 0, max: 30, step: 1 },
    { key: 'vix_extreme_reduction',  label: 'VIX Extreme Threshold ↓', description: 'Points to lower min score when VIX >= extreme', type: 'number', min: 0, max: 40, step: 1 },
    { key: 'vix_extreme_adj',        label: 'VIX Extreme Score Adj',   description: 'Score adjustment when VIX is extreme (negative = penalty)', type: 'number', min: -20, max: 0, step: 1 },
    { key: 'vix_high_adj',           label: 'VIX High Score Adj',      description: 'Score adjustment when VIX is high', type: 'number', min: -20, max: 0, step: 1 },
    { key: 'vix_elevated_adj',       label: 'VIX Elevated Score Adj',  description: 'Score adjustment when VIX is elevated', type: 'number', min: -15, max: 0, step: 1 },
    { key: 'vix_low_adj',            label: 'VIX Low Score Bonus',     description: 'Score bonus when VIX is low', type: 'number', min: 0, max: 10, step: 1 },
  ],
  market: [
    { key: 'spy_death_cross_adj',    label: 'SPY Death Cross Adj',     description: 'Score penalty when SPY is in death cross', type: 'number', min: -30, max: 0, step: 1 },
    { key: 'qqq_death_cross_adj',    label: 'QQQ Death Cross Adj',     description: 'Score penalty when QQQ is in death cross', type: 'number', min: -30, max: 0, step: 1 },
    { key: 'spy_below_200ma_adj',    label: 'SPY Below 200MA Adj',     description: 'Score penalty when SPY is below 200-day MA', type: 'number', min: -20, max: 0, step: 1 },
    { key: 'spy_golden_cross_adj',   label: 'SPY Golden Cross Bonus',  description: 'Score bonus when SPY has golden cross', type: 'number', min: 0, max: 15, step: 1 },
    { key: 'sector_weak_threshold',  label: 'Sector Weak Threshold %', description: 'Sector 20d return below this = weak', type: 'number', min: -20, max: 0, step: 1 },
    { key: 'sector_strong_threshold',label: 'Sector Strong Threshold %',description: 'Sector 20d return above this = strong', type: 'number', min: 0, max: 10, step: 1 },
    { key: 'sector_weak_adj',        label: 'Sector Weak Adj',         description: 'Score penalty for weak sector', type: 'number', min: -15, max: 0, step: 1 },
    { key: 'sector_strong_adj',      label: 'Sector Strong Bonus',     description: 'Score bonus for strong sector', type: 'number', min: 0, max: 15, step: 1 },
  ],
};

// ─── In-memory cache ──────────────────────────────────────────────────────────
let _cache = null;

async function getParams() {
  if (_cache) return _cache;
  try {
    const rows = await db.query("SELECT * FROM system_config WHERE config_group = 'params'");
    const fromDb = {};
    for (const row of rows) {
      const num = parseFloat(row.config_value);
      fromDb[row.config_key] = isNaN(num) ? row.config_value : num;
    }
    _cache = { ...DEFAULTS, ...fromDb };
    return _cache;
  } catch (_) {
    return { ...DEFAULTS };
  }
}

async function setParam(key, value) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
    throw new Error(`Unknown param key: ${key}`);
  }
  const num = parseFloat(value);
  if (isNaN(num)) throw new Error(`Value must be a number`);
  await db.query(
    `INSERT INTO system_config (config_group, config_key, config_value)
     VALUES ('params', ?, ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = NOW()`,
    [key, String(num)]
  );
  _cache = null;
  return getParams();
}

async function resetParam(key) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
    throw new Error(`Unknown param key: ${key}`);
  }
  await db.query(
    "DELETE FROM system_config WHERE config_group='params' AND config_key=?",
    [key]
  );
  _cache = null;
  return getParams();
}

function invalidateCache() { _cache = null; }

module.exports = { getParams, setParam, resetParam, DEFAULTS, PARAM_META, invalidateCache };
