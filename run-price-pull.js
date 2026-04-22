// Manual price pull script — fetches closing prices for all tracked stocks

const db = require('./db/db');
const { pullAllStocks } = require('./mystocks/datapuller');

async function initDb() {
  const schema = `
    CREATE TABLE IF NOT EXISTS my_stocks (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      ticker                VARCHAR(10) NOT NULL UNIQUE,
      company_name          VARCHAR(120),
      sector                VARCHAR(60),
      date_added            DATETIME DEFAULT CURRENT_TIMESTAMP,
      status                ENUM('active','inactive') DEFAULT 'active',
      INDEX idx_ticker (ticker),
      INDEX idx_status (status)
    );

    CREATE TABLE IF NOT EXISTS stock_prices (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      ticker                VARCHAR(10) NOT NULL,
      date                  DATE NOT NULL,
      open_price            DECIMAL(10,2),
      high_price            DECIMAL(10,2),
      low_price             DECIMAL(10,2),
      close_price           DECIMAL(10,2),
      volume                BIGINT,
      adjusted_close        DECIMAL(10,2),
      UNIQUE KEY uk_ticker_date (ticker, date),
      FOREIGN KEY (ticker) REFERENCES my_stocks(ticker),
      INDEX idx_ticker (ticker),
      INDEX idx_date (date)
    );

    CREATE TABLE IF NOT EXISTS stock_analysis (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      ticker                VARCHAR(10) NOT NULL,
      analysis_date         DATE NOT NULL,
      rsi_14                DECIMAL(6,2),
      ma_50                 DECIMAL(10,2),
      ma_200                DECIMAL(10,2),
      above_50ma            TINYINT(1) DEFAULT 0,
      above_200ma           TINYINT(1) DEFAULT 0,
      golden_cross          TINYINT(1) DEFAULT 0,
      death_cross           TINYINT(1) DEFAULT 0,
      current_price         DECIMAL(10,2),
      price_change_pct      DECIMAL(6,2),
      pe_ratio              DECIMAL(8,2),
      earnings_growth_pct   DECIMAL(8,2),
      analyst_rating        DECIMAL(3,2),
      analyst_buy_cnt       INT,
      analyst_hold_cnt      INT,
      analyst_sell_cnt      INT,
      news_sentiment        DECIMAL(4,2),
      momentum_score        DECIMAL(6,2),
      technical_score       DECIMAL(6,2),
      fundamental_score     DECIMAL(6,2),
      composite_score       DECIMAL(6,2),
      recommendation        ENUM('buy','hold','sell'),
      confidence_pct        DECIMAL(5,2),
      why                   JSON,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_ticker_date (ticker, analysis_date),
      FOREIGN KEY (ticker) REFERENCES my_stocks(ticker),
      INDEX idx_ticker (ticker),
      INDEX idx_date (analysis_date)
    );
  `;

  for (const stmt of schema.split('CREATE TABLE')) {
    if (stmt.trim()) {
      await db.query('CREATE TABLE' + stmt).catch(() => {});
    }
  }
  console.log('[Init] Database initialized');
}

async function main() {
  try {
    console.log('[Price Pull] Initializing database...');
    await initDb();
    console.log('[Price Pull] Starting price fetch...');
    await pullAllStocks();
    console.log('[Price Pull] ✓ Price fetch complete');
    process.exit(0);
  } catch (err) {
    console.error('[Price Pull] Error:', err.message);
    process.exit(1);
  }
}

main();
