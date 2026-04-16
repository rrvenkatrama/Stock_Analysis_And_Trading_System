// Cron scheduler — pre-market scan, midday scan, position sync, EOD summary
const { CronJob } = require('cron');
const { runScan }       = require('../screener/scan');
const { syncPositions, getAccount } = require('../trader/executor');
const { sendPortfolioPlan }  = require('../notifier/email');
const portfolio = require('../trader/portfolio');
const paramsModule = require('../config/params');
const db  = require('../db/db');

// All times are in ET (America/New_York)

// ─── Shared: run scan → build portfolio plan → email ─────────────────────────
let scanRunning = false;
async function runScanAndBuildPlan(scanType) {
  if (scanRunning) {
    console.log('[Cron] Scan already running — skipping');
    return;
  }
  scanRunning = true;
  try {
    return await _runScanAndBuildPlan(scanType);
  } finally {
    scanRunning = false;
  }
}

async function _runScanAndBuildPlan(scanType) {
  const results = await runScan(scanType);
  if (!results.length) {
    console.log(`[Cron] No candidates from ${scanType} scan — skipping plan`);
    return;
  }

  const sessionId = results[0]?.sessionId;
  const [params, account, openPositions] = await Promise.all([
    paramsModule.getParams(),
    getAccount().catch(() => ({ buying_power: 0 })),
    db.query(
      `SELECT p.*, t.entry_price, t.stop_price, t.target_price
       FROM positions p JOIN trades t ON p.trade_id = t.id`
    ),
  ]);

  const plan = await portfolio.buildPlan(results, openPositions, account, params);
  const { id: planId, token } = await portfolio.savePlan(plan, sessionId);

  console.log(`[Cron] Portfolio plan built: ${plan.summary}`);
  await sendPortfolioPlan(plan, token);
  await db.log('info', 'cron', `Portfolio plan created: ${plan.summary}`, { planId });
}

// ─── Pre-market scan: 8:50 AM ET ─────────────────────────────────────────────
const premktScan = new CronJob('50 8 * * 1-5', async () => {
  console.log('[Cron] Pre-market scan starting...');
  try {
    await runScanAndBuildPlan('premarket');
  } catch (err) {
    await db.log('error', 'cron', `Pre-market scan failed: ${err.message}`);
  }
}, null, false, 'America/New_York');

// ─── Midday scan: 12:00 PM ET ────────────────────────────────────────────────
const middayScan = new CronJob('0 12 * * 1-5', async () => {
  console.log('[Cron] Midday scan starting...');
  try {
    await runScanAndBuildPlan('midday');
  } catch (err) {
    await db.log('error', 'cron', `Midday scan failed: ${err.message}`);
  }
}, null, false, 'America/New_York');

// ─── Position sync: every 5 minutes during market hours ───────────────────────
const positionSync = new CronJob('*/5 9-16 * * 1-5', async () => {
  try {
    await syncPositions();
  } catch (err) {
    await db.log('error', 'cron', `Position sync failed: ${err.message}`);
  }
}, null, false, 'America/New_York');

// ─── EOD summary: 4:15 PM ET ─────────────────────────────────────────────────
const eodSummary = new CronJob('15 16 * * 1-5', async () => {
  console.log('[Cron] EOD summary...');
  try {
    const today = new Date().toISOString().split('T')[0];
    const trades = await db.query(
      `SELECT * FROM trades
       WHERE DATE(closed_at) = ? OR DATE(filled_at) = ?`,
      [today, today]
    );

    let totalPnl  = 0;
    let winners   = 0;
    let losers    = 0;
    for (const t of trades) {
      if (t.pnl) {
        totalPnl += parseFloat(t.pnl);
        if (t.pnl > 0) winners++;
        else losers++;
      }
    }

    await db.query(
      `INSERT INTO daily_stats (trade_date, trades_opened, trades_closed, winners, losers, gross_pnl)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         trades_closed=VALUES(trades_closed), winners=VALUES(winners),
         losers=VALUES(losers), gross_pnl=VALUES(gross_pnl)`,
      [today, 0, trades.filter(t => t.closed_at).length, winners, losers, totalPnl.toFixed(2)]
    );

    // Expire old pending candidates and plans
    await db.query(
      `UPDATE candidates SET status='expired'
       WHERE status='pending' AND scanned_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`
    );
    await db.query(
      `UPDATE portfolio_plans SET status='expired'
       WHERE status='pending' AND approval_expires_at < NOW()`
    );

    await db.log('info', 'cron', `EOD: ${winners}W/${losers}L P&L: $${totalPnl.toFixed(2)}`);
  } catch (err) {
    await db.log('error', 'cron', `EOD summary failed: ${err.message}`);
  }
}, null, false, 'America/New_York');

function startAll() {
  premktScan.start();
  middayScan.start();
  positionSync.start();
  eodSummary.start();
  console.log('[Cron] All jobs scheduled (ET timezone)');
  console.log('  Pre-market scan: 8:50 AM ET weekdays');
  console.log('  Midday scan:    12:00 PM ET weekdays');
  console.log('  Position sync:  Every 5 min market hours');
  console.log('  EOD summary:     4:15 PM ET weekdays');
}

module.exports = { startAll, runScanAndBuildPlan };
