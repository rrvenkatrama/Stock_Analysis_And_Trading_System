-- Migration: Add pick_flag to watchlist and signal_count to stock_signals
-- Date: 2026-04-19

USE stocktrader;

-- Add pick_flag column to watchlist
ALTER TABLE watchlist ADD COLUMN pick_flag TINYINT(1) DEFAULT 0;

-- Add index for pick_flag
ALTER TABLE watchlist ADD INDEX idx_pick_flag (pick_flag);

-- Add signal_count column to stock_signals
ALTER TABLE stock_signals ADD COLUMN signal_count INT DEFAULT 5;

-- Set all existing watchlist stocks to pick_flag=0 (No Pick default)
UPDATE watchlist SET pick_flag = 0 WHERE pick_flag IS NULL;

-- Migration complete
SELECT 'Migration complete: added pick_flag to watchlist and signal_count to stock_signals' AS status;
