-- Phoenix Strategy DB Migration
-- Run once on server: mysql -u stocktrader -pstocktrader123 stocktrader < db/migrate_phoenix.sql

-- 1. Phoenix signals table (output of phoenix_screener.js)
CREATE TABLE IF NOT EXISTS phoenix_signals (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  symbol              VARCHAR(10)  NOT NULL UNIQUE,
  name                VARCHAR(120),
  sector              VARCHAR(60),
  generated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  price               DECIMAL(12,4),
  price_change_pct    DECIMAL(8,2),
  high_52w            DECIMAL(12,4),
  low_52w             DECIMAL(12,4),
  pct_from_52high     DECIMAL(8,2),   -- e.g. -45.3 means 45.3% below 52wk high
  price_1y_ago        DECIMAL(12,4),  -- closing price ~252 trading days ago
  price_change_1y     DECIMAL(8,2),   -- YoY % price change (negative = declined)
  eps_growth          DECIMAL(8,2),   -- 3Y EPS growth % from Finnhub
  revenue_growth      DECIMAL(8,2),   -- 3Y revenue growth % from Finnhub
  roe                 DECIMAL(8,2),   -- return on equity %
  debt_equity         DECIMAL(8,2),   -- debt-to-equity ratio
  pe_forward          DECIMAL(8,2),   -- forward P/E
  ps_ratio            DECIMAL(8,2),   -- price-to-sales ratio
  dividend_yield      DECIMAL(6,2),
  analyst_buy         INT,
  analyst_sell        INT,
  analyst_hold        INT,
  shares_buyback_pct  DECIMAL(6,2),   -- YoY % change in shares outstanding (negative = buybacks)
  score               DECIMAL(6,2),
  recommendation      ENUM('BUY','WATCH','PASS') DEFAULT 'PASS',
  why                 TEXT,
  INDEX idx_score (score),
  INDEX idx_rec   (recommendation)
);

-- 2. Add strategy column to autotrader_trades (tracks which engine placed each trade)
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='autotrader_trades' AND COLUMN_NAME='strategy');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE autotrader_trades ADD COLUMN strategy VARCHAR(20) DEFAULT ''alpha'' AFTER symbol',
  'SELECT ''strategy column already exists'' AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Add shares_outstanding to watchlist (populated by yahoo_history.js)
SET @col_exists2 = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='watchlist' AND COLUMN_NAME='shares_outstanding');
SET @sql2 = IF(@col_exists2 = 0,
  'ALTER TABLE watchlist ADD COLUMN shares_outstanding BIGINT DEFAULT NULL AFTER rec_count',
  'SELECT ''shares_outstanding column already exists'' AS info');
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

-- 4. Phoenix config keys
INSERT IGNORE INTO system_config (config_group, config_key, config_value)
VALUES
  ('phoenix', 'phoenix_enabled',       '0'),
  ('phoenix', 'phoenix_max_positions', '4');

-- 5. Reduce Alpha max positions from 8 to 4 (each strategy gets 4 slots)
UPDATE system_config
  SET config_value = '4'
  WHERE config_group = 'autotrader' AND config_key = 'autorun_max_positions';

SELECT 'Migration complete.' AS status;
SELECT config_group, config_key, config_value FROM system_config WHERE config_group IN ('autotrader','phoenix') ORDER BY config_group, config_key;
