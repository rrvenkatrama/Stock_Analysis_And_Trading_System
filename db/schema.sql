-- ─────────────────────────────────────────────────────────────
-- StockTrader Database Schema
-- ─────────────────────────────────────────────────────────────

CREATE DATABASE IF NOT EXISTS stocktrader CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE stocktrader;

-- ─── SCAN SESSIONS ────────────────────────────────────────────
-- Tracks each scan run (pre-market, midday, etc.)
CREATE TABLE IF NOT EXISTS scan_sessions (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  scan_type   ENUM('premarket','midday','eod') NOT NULL,
  started_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  candidates  INT DEFAULT 0,
  status      ENUM('running','complete','error') DEFAULT 'running'
);

-- ─── CANDIDATES ───────────────────────────────────────────────
-- Ranked trade candidates from each scan
CREATE TABLE IF NOT EXISTS candidates (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  scan_session_id     INT NOT NULL,
  symbol              VARCHAR(10) NOT NULL,
  company_name        VARCHAR(120),
  sector              VARCHAR(60),
  scanned_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Price info at time of scan
  price               DECIMAL(10,2),
  price_change_pct    DECIMAL(6,2),
  volume              BIGINT,
  avg_volume          BIGINT,
  volume_ratio        DECIMAL(6,2),

  -- Technical signals
  rsi                 DECIMAL(6,2),
  macd_signal         ENUM('bullish','bearish','neutral'),
  above_50ma          TINYINT(1) DEFAULT 0,
  above_200ma         TINYINT(1) DEFAULT 0,
  bollinger_position  ENUM('oversold','normal','overbought'),
  short_interest_pct  DECIMAL(6,2),

  -- Fundamental signals
  pe_ratio            DECIMAL(8,2),
  sector_pe           DECIMAL(8,2),
  eps_growth_pct      DECIMAL(8,2),
  revenue_growth_pct  DECIMAL(8,2),
  debt_equity         DECIMAL(8,2),
  last_earnings_beat  TINYINT(1),
  earnings_date       DATE,
  days_to_earnings    INT,

  -- Sentiment signals
  analyst_buy         INT DEFAULT 0,
  analyst_hold        INT DEFAULT 0,
  analyst_sell        INT DEFAULT 0,
  analyst_pt          DECIMAL(10,2),
  stocktwits_bulls    DECIMAL(6,2),
  news_sentiment      DECIMAL(6,2),   -- -1.0 to +1.0
  reddit_mentions     INT DEFAULT 0,

  -- Scores
  technical_score     DECIMAL(6,2),
  fundamental_score   DECIMAL(6,2),
  sentiment_score     DECIMAL(6,2),
  composite_score     DECIMAL(6,2),
  probability_pct     DECIMAL(6,2),
  risk_level          ENUM('low','medium','high'),

  -- Suggested trade levels
  suggested_entry     DECIMAL(10,2),
  suggested_target    DECIMAL(10,2),
  suggested_stop      DECIMAL(10,2),
  suggested_shares    INT,
  suggested_hold_days INT,
  risk_reward         DECIMAL(6,2),

  -- Top reasons (JSON array of strings)
  reasons             JSON,

  -- Scanner category tag (breakout | dividend_value | strong_moat | core)
  category            VARCHAR(40) DEFAULT 'core',

  -- User action
  status              ENUM('pending','selected','skipped','expired') DEFAULT 'pending',
  selected_at         DATETIME,

  FOREIGN KEY (scan_session_id) REFERENCES scan_sessions(id),
  INDEX idx_symbol (symbol),
  INDEX idx_scanned_at (scanned_at),
  INDEX idx_composite_score (composite_score DESC),
  INDEX idx_status (status)
);

-- ─── TRADES ───────────────────────────────────────────────────
-- Every order placed through the system
CREATE TABLE IF NOT EXISTS trades (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  candidate_id        INT,
  symbol              VARCHAR(10) NOT NULL,
  alpaca_order_id     VARCHAR(60),
  alpaca_stop_id      VARCHAR(60),

  side                ENUM('buy','sell') NOT NULL,
  order_type          ENUM('market','limit','stop') DEFAULT 'market',
  shares              INT NOT NULL,
  entry_price         DECIMAL(10,2),
  stop_price          DECIMAL(10,2),
  target_price        DECIMAL(10,2),

  status              ENUM('pending_approval','approved','rejected','submitted',
                           'filled','partially_filled','cancelled','closed',
                           'stop_triggered') DEFAULT 'pending_approval',

  -- Approval flow
  approval_token      VARCHAR(60) UNIQUE,
  approval_expires_at DATETIME,
  approved_at         DATETIME,
  rejected_at         DATETIME,

  -- Execution details
  submitted_at        DATETIME,
  filled_at           DATETIME,
  fill_price          DECIMAL(10,2),

  -- Close details
  closed_at           DATETIME,
  close_price         DECIMAL(10,2),
  close_reason        ENUM('target_hit','stop_triggered','manual','eod_close'),

  -- P&L
  pnl                 DECIMAL(10,2),
  pnl_pct             DECIMAL(6,2),

  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (candidate_id) REFERENCES candidates(id),
  INDEX idx_symbol (symbol),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at),
  INDEX idx_approval_token (approval_token)
);

-- ─── DAILY STATS ──────────────────────────────────────────────
-- Aggregated daily performance tracking
CREATE TABLE IF NOT EXISTS daily_stats (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  trade_date      DATE NOT NULL UNIQUE,
  trades_opened   INT DEFAULT 0,
  trades_closed   INT DEFAULT 0,
  winners         INT DEFAULT 0,
  losers          INT DEFAULT 0,
  gross_pnl       DECIMAL(10,2) DEFAULT 0,
  account_value   DECIMAL(12,2),
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ─── POSITIONS ────────────────────────────────────────────────
-- Current open positions (updated in real-time from Alpaca)
CREATE TABLE IF NOT EXISTS positions (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  trade_id        INT NOT NULL UNIQUE,
  symbol          VARCHAR(10) NOT NULL,
  shares          INT NOT NULL,
  entry_price     DECIMAL(10,2),
  current_price   DECIMAL(10,2),
  stop_price      DECIMAL(10,2),
  target_price    DECIMAL(10,2),
  unrealized_pnl  DECIMAL(10,2),
  unrealized_pct  DECIMAL(6,2),
  opened_at       DATETIME,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (trade_id) REFERENCES trades(id),
  INDEX idx_symbol (symbol)
);

-- ─── NEWS CACHE ───────────────────────────────────────────────
-- Cached news articles to avoid re-fetching
CREATE TABLE IF NOT EXISTS news_cache (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  symbol          VARCHAR(10) NOT NULL,
  headline        VARCHAR(512),
  source          VARCHAR(80),
  url             VARCHAR(512),
  sentiment       DECIMAL(4,2),
  published_at    DATETIME,
  fetched_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_symbol_published (symbol, published_at DESC)
);

-- ─── PORTFOLIO PLANS ─────────────────────────────────────────
-- Daily portfolio recommendation (buy/sell/hold plan, one per scan)
CREATE TABLE IF NOT EXISTS portfolio_plans (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  scan_session_id     INT,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status              ENUM('pending','approved','rejected','executed','expired') DEFAULT 'pending',
  plan_json           JSON NOT NULL,
  summary             VARCHAR(255),
  approval_token      VARCHAR(64) UNIQUE,
  approval_expires_at DATETIME,
  approved_at         DATETIME,
  executed_at         DATETIME,

  FOREIGN KEY (scan_session_id) REFERENCES scan_sessions(id),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at),
  INDEX idx_token (approval_token)
);

-- ─── SYSTEM LOG ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_log (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  level       ENUM('info','warn','error') DEFAULT 'info',
  module      VARCHAR(40),
  message     TEXT,
  meta        JSON,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_level (level),
  INDEX idx_created_at (created_at)
);
