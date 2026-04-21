-- Migration: Add autotrader settings tables
-- 2026-04-20

USE stocktrader;

-- ─── AUTOTRADER SETTINGS ──────────────────────────────────────
-- Stores all user-configurable autotrader parameters
CREATE TABLE IF NOT EXISTS autotrader_settings (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  category        VARCHAR(60) NOT NULL UNIQUE,  -- 'gates', 'buy', 'sell', 'scoring', 'golden_cross', 'limits'
  settings_json   JSON NOT NULL,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by      VARCHAR(60) DEFAULT 'system',
  INDEX idx_category (category)
);

-- ─── SIGNAL WEIGHTS ────────────────────────────────────────────
-- Stores weight multipliers for each scoring signal (default 1)
CREATE TABLE IF NOT EXISTS signal_weights (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  signal_name     VARCHAR(120) NOT NULL UNIQUE,  -- 'golden_cross', 'rsi_oversold', etc.
  weight          DECIMAL(4,1) DEFAULT 1.0,      -- 1.0 = default, 2.0 = double weight
  signal_type     VARCHAR(40),                    -- 'ma_cross', 'rsi', 'macd', 'volume', etc.
  description     TEXT,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_signal_name (signal_name),
  INDEX idx_signal_type (signal_type)
);

-- ─── SETTINGS CHANGE LOG ──────────────────────────────────────
-- Audit trail of all setting changes
CREATE TABLE IF NOT EXISTS settings_changelog (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  changed_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  category        VARCHAR(60),
  change_json     JSON,                           -- {field, old_value, new_value}
  changed_by      VARCHAR(60),
  notes           TEXT,
  INDEX idx_changed_at (changed_at DESC),
  INDEX idx_category (category)
);

-- Insert default settings
INSERT IGNORE INTO autotrader_settings (category, settings_json, updated_by) VALUES
('gates', '{"score_threshold":50,"rsi_min":30,"rsi_max":65,"overextension_pct":8,"min_confirmations":2}', 'system'),
('buy', '{"min_price":5,"require_pick_flag":1,"min_confirmations":2,"exclude_earnings_days":5}', 'system'),
('sell', '{"hard_stop_pct":-8,"soft_exit_score":25,"soft_exit_rsi":75,"ema_cross_days":3,"time_stop_days":30}', 'system'),
('scoring', '{"score_threshold_buy":50,"score_threshold_hold_min":20,"score_threshold_hold_max":50,"score_threshold_sell":20}', 'system'),
('golden_cross', '{"detection_fast_ma":50,"detection_slow_ma":200,"pulsing_glow_days":5,"stable_period_sessions":20}', 'system'),
('limits', '{"max_positions":15,"max_per_position_pct":10,"max_deployment_pct":80,"min_cash_buffer_pct":20,"vix_20_30_mult":0.75,"vix_30_plus_mult":0.50}', 'system');

-- Insert default signal weights (all 1.0)
INSERT IGNORE INTO signal_weights (signal_name, weight, signal_type, description) VALUES
('golden_cross', 1.0, 'ma_cross', 'Golden cross (50MA > 200MA) signal strength'),
('death_cross', 1.0, 'ma_cross', 'Death cross (50MA < 200MA) bearish weight'),
('price_above_200ma', 1.0, 'price_ma', 'Price crossed above 200MA recently'),
('price_above_50ma', 1.0, 'price_ma', 'Price above 50MA'),
('overextension', 1.0, 'extension', 'Penalty for being >8% above 50MA'),
('ema_9_bull_cross', 1.0, 'ema', 'EMA 9 crossed above EMA 21'),
('ema_9_bear_cross', 1.0, 'ema', 'EMA 9 crossed below EMA 21'),
('volume_surge_up', 1.0, 'volume', 'Volume surge with price up'),
('volume_surge_down', 1.0, 'volume', 'Volume surge with price down'),
('rsi_oversold', 1.0, 'rsi', 'RSI < 30 oversold'),
('rsi_recovering', 1.0, 'rsi', 'RSI 30-45 recovering'),
('rsi_overbought', 1.0, 'rsi', 'RSI >= 65 overbought'),
('macd_bullish_cross', 1.0, 'macd', 'MACD bullish cross'),
('macd_bearish', 1.0, 'macd', 'MACD bearish trend'),
('pe_value', 1.0, 'valuation', 'PE ratio below sector average'),
('eps_growth', 1.0, 'fundamental', 'EPS growth > 20%'),
('revenue_growth', 1.0, 'fundamental', 'Revenue growth > 15%'),
('dividend_yield', 1.0, 'income', 'Dividend yield signal'),
('analyst_buy', 1.0, 'analyst', 'High analyst buy consensus'),
('price_target_upside', 1.0, 'analyst', 'Price target above current price'),
('short_interest', 1.0, 'sentiment', 'Short interest signals');

SELECT 'Migration complete: added autotrader_settings, signal_weights, settings_changelog tables' AS status;
