// MyStocks daily scheduler — pulls data, analyzes, generates portfolios

const { CronJob } = require('cron');
const db = require('../db/db');
const { pullAllStocks } = require('./datapuller');
const { analyzeStock, saveAnalysis } = require('./analyzer');
const { buildPortfolioRecommendations } = require('./portfolio-builder');

// ─── Daily Analysis Job: 9:00 AM ET ─────────────────────────────────────────
let analysisRunning = false;

async function runDailyAnalysis() {
  if (analysisRunning) {
    console.log('[MyStocks Cron] Analysis already running — skipping');
    return;
  }

  analysisRunning = true;
  const startTime = Date.now();

  try {
    console.log('[MyStocks Cron] ========================================');
    console.log('[MyStocks Cron] Starting daily analysis cycle...');
    console.log('[MyStocks Cron] ========================================');

    // Step 1: Pull latest price data
    console.log('[MyStocks Cron] Step 1: Pulling fresh price data...');
    await pullAllStocks();

    // Step 2: Analyze each stock
    console.log('[MyStocks Cron] Step 2: Running technical analysis...');
    const stocks = await db.query(
      'SELECT ticker FROM my_stocks WHERE status="active" ORDER BY ticker'
    );

    let analyzed = 0;
    for (const stock of stocks) {
      const analysis = await analyzeStock(stock.ticker);
      if (analysis) {
        await saveAnalysis(analysis);
        analyzed++;
      }
    }

    console.log(`[MyStocks Cron] ✓ Analyzed ${analyzed}/${stocks.length} stocks`);

    // Step 3: Build portfolio recommendations
    console.log('[MyStocks Cron] Step 3: Building portfolio recommendations...');
    const portfolios = await buildPortfolioRecommendations();
    console.log(`[MyStocks Cron] ✓ Generated ${portfolios.length} portfolios`);

    // Step 4: Log daily summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await db.log('info', 'mystocks', `Daily analysis complete: ${analyzed} stocks, ${portfolios.length} portfolios (${elapsed}s)`);

    console.log('[MyStocks Cron] ========================================');
    console.log(`[MyStocks Cron] Analysis complete in ${elapsed}s`);
    console.log('[MyStocks Cron] ========================================');

  } catch (err) {
    console.error('[MyStocks Cron] Error:', err.message);
    await db.log('error', 'mystocks', `Daily analysis failed: ${err.message}`);
  } finally {
    analysisRunning = false;
  }
}

// Cron job: 9:00 AM ET every weekday
const dailyAnalysis = new CronJob('0 9 * * 1-5', async () => {
  await runDailyAnalysis();
}, null, false, 'America/New_York');

// ─── Manual Trigger ─────────────────────────────────────────────────────────

async function triggerAnalysisNow() {
  console.log('[MyStocks] Manual analysis triggered');
  await runDailyAnalysis();
}

function startScheduler() {
  dailyAnalysis.start();
  console.log('[MyStocks Cron] Scheduler started');
  console.log('[MyStocks Cron]   Daily analysis: 9:00 AM ET weekdays');
}

function stopScheduler() {
  dailyAnalysis.stop();
  console.log('[MyStocks Cron] Scheduler stopped');
}

module.exports = {
  startScheduler,
  stopScheduler,
  triggerAnalysisNow,
  runDailyAnalysis,
};
