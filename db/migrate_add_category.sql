-- Migration: add category column to candidates table
-- Run once on the remote DB: mysql -u stocktrader -p stocktrader < db/migrate_add_category.sql

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS category VARCHAR(40) DEFAULT 'core'
  AFTER reasons;
