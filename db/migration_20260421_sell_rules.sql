-- Migration: Enhanced sell rules with trailing stop and peak price tracking
-- 2026-04-21
-- Note: peak_price columns already exist in position_flags from prior migration
-- This migration updates the sell settings JSON to include new parameters

USE stocktrader;

-- Update sell settings with new trailing stop and extended price parameters
UPDATE autotrader_settings
SET settings_json = JSON_OBJECT(
  'hard_stop_pct', COALESCE(JSON_EXTRACT(settings_json, '$.hard_stop_pct'), -8),
  'trailing_stop_activation_pct', 5,
  'trailing_stop_pct', 5,
  'extended_price_pct', 10
)
WHERE category = 'sell';

SELECT 'Migration complete: updated sell settings with trailing stop and extended price parameters' AS status;
