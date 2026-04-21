-- Migration: Add watchlist groups feature
-- 2026-04-21

USE stocktrader;

-- Watchlist groups (custom named lists)
CREATE TABLE IF NOT EXISTS watchlist_groups (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(80) NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_name (name)
);

-- Many-to-many: stocks in each group
CREATE TABLE IF NOT EXISTS watchlist_group_stocks (
  group_id   INT NOT NULL,
  symbol     VARCHAR(10) NOT NULL,
  added_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, symbol),
  FOREIGN KEY (group_id) REFERENCES watchlist_groups(id) ON DELETE CASCADE,
  INDEX idx_group (group_id),
  INDEX idx_symbol (symbol)
);

SELECT 'Migration complete: added watchlist_groups and watchlist_group_stocks tables' AS status;
