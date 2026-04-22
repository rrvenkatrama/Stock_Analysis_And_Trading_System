-- Migration: Add entry_reason to autotrader_trades for recording buy reasons
-- 2026-04-21

USE stocktrader;

ALTER TABLE autotrader_trades
  ADD COLUMN entry_reason VARCHAR(300) NULL AFTER exit_reason;

SELECT 'Migration complete: added entry_reason to autotrader_trades' AS status;
