// Daily scheduler for My Stocks dashboard
// 8:30 AM ET: data refresh → Alpha analysis → Phoenix scoring → universe scan → recommendations → email
// 9:35 AM ET: Alpha autotrader execution + Phoenix autotrader execution (each when enabled)

const { CronJob } = require('cron');
const { refreshAll }                              = require('./yahoo_history');
const { analyzeAll }                              = require('./analyzer');
const { scanUniverse }                            = require('./universe');
const { evaluate: alphaEvaluate, run: alphaRun }    = require('./autotrader');
const { evaluate: phoenixEvaluate, run: phoenixRun } = require('./phoenix_autotrader');
const { scoreAll: runPhoenixScreener }               = require('./phoenix_screener');
const { sendDailyDigest, sendErrorAlert, sendAutotraderEmail } = require('../notifier/email');
const { getAlpacaPositions }                      = require('../trader/executor');
const db                                          = require('../db/db');

let refreshRunning = false;

async function runDailyRefresh(fullYear = false) {
  if (refreshRunning) {
    console.log('[Portfolio Scheduler] Refresh already running — skipping');
    return;
  }
  refreshRunning = true;
  const start = Date.now();
  const errors = [];  // collect non-fatal errors across all phases

  try {
    console.log('[Portfolio Scheduler] Starting daily refresh...');

    // Phase 1+2: Price bars + fundamentals
    let quotes = {};
    try {
      quotes = await refreshAll(fullYear);
    } catch (e) {
      console.error('[Scheduler] refreshAll failed:', e.message);
      errors.push({ phase: 'Data Refresh', message: e.message });
    }

    // Phase 3: Score all watchlist symbols
    try {
      await analyzeAll(quotes);
    } catch (e) {
      console.error('[Scheduler] analyzeAll failed:', e.message);
      errors.push({ phase: 'Analysis / Scoring', message: e.message });
    }

    // Phase 4: Universe scan — discover BUY candidates not in personal watchlist
    let picks = [];
    try {
      picks = await scanUniverse();
      console.log(`[Portfolio Scheduler] Universe scan: ${picks.length} new picks`);
    } catch (e) {
      console.error('[Scheduler] Universe scan failed:', e.message);
      errors.push({ phase: 'Universe Scan', message: e.message });
    }

    // Phase 4.5a: Phoenix screener — score all watchlist symbols for deep value
    let phoenixResults = null;
    try {
      await runPhoenixScreener();
      console.log(`[Scheduler] Phoenix screener complete`);
    } catch (e) {
      console.error('[Scheduler] Phoenix screener failed:', e.message);
      errors.push({ phase: 'Phoenix Screener', message: e.message });
    }

    // Phase 4.5b: Alpha autotrader — generate recommendations (execute=false)
    let autoResults = null;
    try {
      autoResults = await alphaEvaluate(false);
      const { exits, entries } = autoResults;
      console.log(`[Scheduler] Alpha recommendations: ${entries.length} entries, ${exits.length} exits`);
    } catch (e) {
      console.error('[Scheduler] Alpha evaluate failed:', e.message);
      errors.push({ phase: 'Alpha Recommendations', message: e.message });
    }

    // Phase 4.5c: Phoenix autotrader — generate recommendations (execute=false)
    try {
      phoenixResults = await phoenixEvaluate(false);
      const { exits, entries } = phoenixResults;
      console.log(`[Scheduler] Phoenix recommendations: ${entries.length} entries, ${exits.length} exits`);
    } catch (e) {
      console.error('[Scheduler] Phoenix evaluate failed:', e.message);
      errors.push({ phase: 'Phoenix Recommendations', message: e.message });
    }

    // Phase 5: Send daily digest email
    try {
      const signals   = await db.query(`SELECT * FROM stock_signals ORDER BY score DESC`);
      const positions = await getAlpacaPositions().catch(() => []);
      await sendDailyDigest(signals, positions, picks, autoResults, phoenixResults);
    } catch (e) {
      console.error('[Scheduler] Email failed:', e.message);
      errors.push({ phase: 'Daily Digest Email', message: e.message });
    }

    // Phase 6: Send error alert if any phase had problems
    if (errors.length > 0) {
      try {
        await sendErrorAlert(errors);
      } catch (e) {
        console.error('[Scheduler] Error alert email failed:', e.message);
      }
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[Portfolio Scheduler] Refresh complete in ${elapsed}s (${errors.length} error(s))`);
    await db.log('info', 'portfolio_scheduler',
      `Daily refresh complete in ${elapsed}s — ${errors.length} error(s)`);

  } catch (err) {
    // Unexpected top-level failure
    console.error('[Portfolio Scheduler] Refresh failed:', err.message);
    await db.log('error', 'portfolio_scheduler', `Refresh failed: ${err.message}`);
    errors.push({ phase: 'Scheduler (fatal)', message: err.message });
    try { await sendErrorAlert(errors); } catch (_) {}
  } finally {
    refreshRunning = false;
  }
}

function startScheduler() {
  // 8:30 AM ET Monday–Friday — full data refresh + analysis + recommendations
  const morningJob = new CronJob('0 30 8 * * 1-5', () => {
    console.log('[Portfolio Scheduler] Cron fired — 8:30 AM ET');
    runDailyRefresh(false);
  }, null, true, 'America/New_York');

  // 9:35 AM ET Monday–Friday — execute Alpha + Phoenix trades (each when enabled)
  const tradeJob = new CronJob('0 35 9 * * 1-5', async () => {
    console.log('[Portfolio Scheduler] Cron fired — 9:35 AM ET (Alpha + Phoenix execution window)');

    // Alpha runs first
    let alphaResults = null;
    try {
      alphaResults = await alphaRun();
      if (alphaResults) {
        console.log(`[Portfolio Scheduler] Alpha: ${alphaResults.entries.length} buys, ${alphaResults.exits.length} sells`);
        try { await sendAutotraderEmail(alphaResults, 'Alpha'); } catch (e) {
          console.error('[Portfolio Scheduler] Alpha email failed:', e.message);
        }
      } else {
        console.log('[Portfolio Scheduler] Alpha: autorun OFF or outside hours');
      }
    } catch (e) {
      console.error('[Portfolio Scheduler] Alpha run failed:', e.message);
    }

    // Phoenix runs second (exits don't conflict since they track own positions)
    let phoenixResults = null;
    try {
      phoenixResults = await phoenixRun();
      if (phoenixResults) {
        console.log(`[Portfolio Scheduler] Phoenix: ${phoenixResults.entries.length} buys, ${phoenixResults.exits.length} sells`);
        try { await sendAutotraderEmail(phoenixResults, 'Phoenix'); } catch (e) {
          console.error('[Portfolio Scheduler] Phoenix email failed:', e.message);
        }
      } else {
        console.log('[Portfolio Scheduler] Phoenix: disabled or outside hours');
      }
    } catch (e) {
      console.error('[Portfolio Scheduler] Phoenix run failed:', e.message);
    }
  }, null, true, 'America/New_York');

  console.log('[Portfolio Scheduler] Scheduled: 8:30 AM refresh + 9:35 AM Alpha+Phoenix (Mon-Fri ET)');
  return { morningJob, tradeJob };
}

module.exports = { startScheduler, runDailyRefresh };
