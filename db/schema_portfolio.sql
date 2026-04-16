-- ─────────────────────────────────────────────────────────────
-- My Stocks Dashboard — Portfolio Schema
-- Run against the same `stocktrader` database
-- ─────────────────────────────────────────────────────────────
USE stocktrader;

-- ─── WATCHLIST ────────────────────────────────────────────────
-- Stocks the user personally tracks (seeded from xlsx, user-editable)
CREATE TABLE IF NOT EXISTS watchlist (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  symbol      VARCHAR(10)  NOT NULL UNIQUE,
  name        VARCHAR(120),
  sector      VARCHAR(60),
  asset_type  ENUM('stock','etf','fund','other') DEFAULT 'stock',
  is_active   TINYINT(1)   DEFAULT 1,
  added_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_active (is_active)
);

-- ─── PRICE HISTORY ────────────────────────────────────────────
-- 1 year of daily OHLCV per symbol — fetched from Yahoo Finance
CREATE TABLE IF NOT EXISTS price_history (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  symbol      VARCHAR(10)  NOT NULL,
  trade_date  DATE         NOT NULL,
  open        DECIMAL(12,4),
  high        DECIMAL(12,4),
  low         DECIMAL(12,4),
  close       DECIMAL(12,4),
  adj_close   DECIMAL(12,4),
  volume      BIGINT,
  UNIQUE KEY  uniq_sym_date (symbol, trade_date),
  INDEX       idx_symbol_date (symbol, trade_date DESC)
);

-- ─── STOCK SIGNALS ────────────────────────────────────────────
-- Latest computed analysis per symbol — rebuilt on each daily refresh
CREATE TABLE IF NOT EXISTS stock_signals (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  symbol              VARCHAR(10)  NOT NULL UNIQUE,
  name                VARCHAR(120),
  sector              VARCHAR(60),
  asset_type          VARCHAR(20)  DEFAULT 'stock',
  generated_at        DATETIME     DEFAULT CURRENT_TIMESTAMP,

  -- Price snapshot
  price               DECIMAL(12,4),
  price_change_pct    DECIMAL(8,2),

  -- 52-week range
  high_52w            DECIMAL(12,4),
  low_52w             DECIMAL(12,4),
  pct_from_52high     DECIMAL(8,2),
  pct_from_52low      DECIMAL(8,2),

  -- Moving averages
  ma50                DECIMAL(12,4),
  ma200               DECIMAL(12,4),
  ema50               DECIMAL(12,4),
  ema200              DECIMAL(12,4),
  above_50ma          TINYINT(1),
  above_200ma         TINYINT(1),

  -- Price-vs-MA cross signals (recent)
  price_crossed_50ma_ago   INT,   -- sessions ago (NULL if not recent)
  price_crossed_200ma_ago  INT,

  -- Golden / Death cross (MA-vs-MA)
  cross_type          VARCHAR(20)  DEFAULT 'none',   -- golden_cross / death_cross / none
  golden_cross_ago    INT,    -- sessions ago (NULL if no golden cross in last 60 sessions)
  death_cross_ago     INT,

  -- MACD
  macd_value          DECIMAL(10,4),
  macd_signal_value   DECIMAL(10,4),
  macd_histogram      DECIMAL(10,4),
  macd_trend          VARCHAR(20),   -- bullish / bearish / above_signal / below_signal / neutral
  macd_cross_ago      INT,   -- sessions since last bullish cross (NULL if none in last 5)

  -- RSI
  rsi                 DECIMAL(6,2),
  oversold            TINYINT(1) DEFAULT 0,   -- RSI < 35

  -- Fundamentals (from Yahoo Finance quote)
  pe_trailing         DECIMAL(8,2),
  pe_forward          DECIMAL(8,2),
  fwd_pe_improving    TINYINT(1) DEFAULT 0,   -- forward < trailing
  dividend_yield      DECIMAL(6,2),

  -- Composite recommendation
  score               DECIMAL(6,2),
  recommendation      ENUM('BUY','HOLD','SELL') DEFAULT 'HOLD',
  why                 TEXT,   -- top signals in plain English

  INDEX idx_recommendation (recommendation),
  INDEX idx_score (score DESC)
);

-- ─── PORTFOLIO RECOMMENDATIONS ────────────────────────────────
-- 3 portfolios generated daily (Aggressive / Moderate / Balanced)
CREATE TABLE IF NOT EXISTS portfolio_recs (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(60)  NOT NULL,
  risk_level      ENUM('high','medium','low') NOT NULL,
  budget_usd      DECIMAL(12,2) DEFAULT 10000.00,
  generated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  status          ENUM('pending','approved','executed') DEFAULT 'pending',
  holdings        JSON,   -- [{symbol,name,score,allocation_pct,shares,price,amount,reason}]
  approved_at     DATETIME,
  executed_at     DATETIME,
  INDEX idx_risk (risk_level),
  INDEX idx_status (status)
);
