// Main scanner — runs pre-market and midday
// Uses yahoo-finance2 for all price + fundamental data (no API key needed)

const db             = require('../db/db');
const cfg            = require('../config/env');
const paramsModule   = require('../config/params');
const { UNIVERSE }   = require('./universe');
const provider       = require('../data/provider');
const institutional  = require('../data/institutional');
const { getMarketContext } = require('../data/marketContext');
const technicals     = require('../analysis/technicals');
const { scoreCandidate, classifyCategory } = require('../analysis/scorer');

const BATCH_SIZE = 2;    // 2 concurrent — keep Yahoo Finance happy
const DELAY_MS   = 2000; // 2 seconds between batches

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchSymbolData(symbol, marketCtx, params) {
  try {
    // Fetch all data via provider (routes to configured source)
    const [bars, fundProfile, sentimentData, news] = await Promise.allSettled([
      provider.getDailyBars(symbol, 210),
      provider.getFundamentalsAndProfile(symbol),
      provider.getSentiment(symbol),
      provider.getNews(symbol),
    ]);

    const barsData  = bars.status          === 'fulfilled' ? bars.value          : [];
    const fundData  = fundProfile.status   === 'fulfilled' ? fundProfile.value   : {};
    const sentData  = sentimentData.status === 'fulfilled' ? sentimentData.value : {};
    const stData    = sentData.stocktwits  || {};
    const newsData  = news.status          === 'fulfilled' ? news.value          : [];

    if (barsData.length < 50) return null;

    const tech = technicals.analyze(barsData);
    if (!tech) return null;

    // Build analyst data shape from combined fundProfile
    const analystData = {
      totalBuy:  fundData.analystBuy  || 0,
      hold:      fundData.analystHold || 0,
      totalSell: fundData.analystSell || 0,
    };

    const priceTarget = {
      targetMean: fundData.analystTarget     || null,
      targetHigh: fundData.analystTargetHigh || null,
      targetLow:  fundData.analystTargetLow  || null,
    };

    const earningsData = {
      earningsDate:   fundData.earningsDate   || null,
      daysToEarnings: fundData.daysToEarnings ?? null,
    };

    // Institutional signal from yahoo data (no scraping needed for basics)
    const instData = {
      finviz: {
        instOwnPct:      fundData.instOwnPct      || 0,
        insiderBuying:   fundData.insiderBuying   || false,
        insiderSelling:  fundData.insiderSelling  || false,
        shortFloatPct:   fundData.shortFloatPct   || 0,
        shortRatio:      fundData.shortRatio      || 0,
        instTransPct:    0,
        insiderTransPct: 0,
      },
      superinvestor: { superinvestorCount: 0, recentlyAdded: 0, holders: [] },
      edgar:         { recentFilings: 0, filers: [] },
    };

    const sentimentPayload = {
      stocktwits: stData,
      news:       { avgSentiment: 0, articleCount: newsData.length },
    };

    const profile = {
      name:   fundData.name,
      sector: fundData.sector,
    };

    const scored = await scoreCandidate({
      symbol,
      bars:          barsData,
      tech,
      fundamentals:  fundData,
      profile,
      earnings:      earningsData,
      analyst:       analystData,
      priceTarget,
      institutional: instData,
      sentiment:     sentimentPayload,
      marketCtx,
      riskConfig:    cfg.risk,
      params,
    });

    const category = classifyCategory(tech, fundData, analystData);

    return {
      symbol, profile, tech, fundData, earningsData,
      analystData, priceTarget, instData, stData, newsData, scored, category,
    };

  } catch (err) {
    await db.log('warn', 'scanner', `Failed ${symbol}: ${err.message}`);
    return null;
  }
}

async function runScan(scanType = 'premarket') {
  console.log(`[Scanner] Starting ${scanType} scan — ${UNIVERSE.length} symbols`);

  const sessionId = await db.insert(
    'INSERT INTO scan_sessions (scan_type, status) VALUES (?, ?)',
    [scanType, 'running']
  );

  try {
    const [marketCtx, params] = await Promise.all([
      getMarketContext(),
      paramsModule.getParams(),
    ]);
    const { getAdaptiveThreshold } = require('../analysis/scorer');
    const effectiveThreshold = getAdaptiveThreshold(params.min_score_threshold, marketCtx.vix?.score, params);
    const effectiveProb      = getAdaptiveThreshold(params.min_probability,     marketCtx.vix?.score, params);
    console.log(`[Scanner] Market: ${marketCtx.marketTrend} (health: ${marketCtx.marketHealth}) | VIX: ${marketCtx.vix.score}`);
    console.log(`[Scanner] Thresholds: score>=${effectiveThreshold} (base ${params.min_score_threshold}), prob>=${effectiveProb}% (base ${params.min_probability}%)`);

    if (marketCtx.marketHealth < 25) {
      console.log('[Scanner] Market health too low — skipping scan');
      await db.query(
        'UPDATE scan_sessions SET status=?, finished_at=NOW(), candidates=0 WHERE id=?',
        ['complete', sessionId]
      );
      return [];
    }

    const results = [];

    for (let i = 0; i < UNIVERSE.length; i += BATCH_SIZE) {
      const batch   = UNIVERSE.slice(i, i + BATCH_SIZE);
      const fetched = await Promise.all(batch.map(sym => fetchSymbolData(sym, marketCtx, params)));

      for (const data of fetched) {
        if (!data) continue;
        const { symbol, profile, tech, fundData, earningsData,
                analystData, priceTarget, instData, stData, scored, category } = data;

        if (scored.compositeScore < scored.adaptiveThreshold)     continue;
        if (scored.probability    < scored.adaptiveProbThreshold) continue;

        let candidateDbId = null;
        try {
          candidateDbId = await db.insert(
            `INSERT INTO candidates (
              scan_session_id, symbol, company_name, sector, price, price_change_pct,
              volume, avg_volume, volume_ratio,
              rsi, macd_signal, above_50ma, above_200ma, bollinger_position, short_interest_pct,
              pe_ratio, eps_growth_pct, revenue_growth_pct, debt_equity,
              earnings_date, days_to_earnings,
              analyst_buy, analyst_hold, analyst_sell, analyst_pt,
              stocktwits_bulls,
              technical_score, fundamental_score, sentiment_score, composite_score,
              probability_pct, risk_level,
              suggested_entry, suggested_target, suggested_stop, suggested_shares,
              suggested_hold_days, risk_reward, reasons, category
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              sessionId, symbol,
              profile.name   || null,
              profile.sector || null,
              tech.price,
              tech.changePct1d || 0,
              Math.round((tech.volume.avgVolume || 0) * (tech.volume.ratio || 1)),
              tech.volume.avgVolume || 0,
              tech.volume.ratio     || 1,
              tech.rsi,
              tech.macd?.isBullishCross ? 'bullish' : tech.macd?.isBearishCross ? 'bearish' : 'neutral',
              tech.aboveMa50  ? 1 : 0,
              tech.aboveMa200 ? 1 : 0,
              tech.bollinger?.position || 'normal',
              fundData.shortFloatPct   || null,
              fundData.pe              || null,
              fundData.epsGrowthPct    || null,
              fundData.revenueGrowth   || null,
              fundData.debtEquity      || null,
              earningsData.earningsDate   || null,
              earningsData.daysToEarnings ?? null,
              analystData.totalBuy  || 0,
              analystData.hold      || 0,
              analystData.totalSell || 0,
              priceTarget.targetMean || null,
              stData.bullishPct      || null,
              scored.scores.technical,
              scored.scores.fundamental,
              scored.scores.sentiment,
              scored.compositeScore,
              scored.probability,
              scored.riskLevel,
              scored.levels.entry,
              scored.levels.target,
              scored.levels.stop,
              scored.levels.shares,
              scored.levels.holdDays,
              scored.levels.riskReward,
              JSON.stringify(scored.reasons),
              category,
            ]
          );
        } catch (dbErr) {
          await db.log('error', 'scanner', `DB insert failed for ${symbol}: ${dbErr.message}`);
        }

        results.push({ ...data, sessionId, candidateDbId });
      }

      if (i + BATCH_SIZE < UNIVERSE.length) await sleep(DELAY_MS);

      const pct = Math.min(100, Math.round(((i + BATCH_SIZE) / UNIVERSE.length) * 100));
      process.stdout.write(`\r[Scanner] Progress: ${pct}% | Candidates so far: ${results.length}`);
    }

    console.log(`\n[Scanner] Done — ${results.length} candidates found`);
    results.sort((a, b) => b.scored.compositeScore - a.scored.compositeScore);

    await db.query(
      'UPDATE candidates SET status=? WHERE status=? AND scan_session_id != ?',
      ['expired', 'pending', sessionId]
    );

    await db.query(
      'UPDATE scan_sessions SET status=?, finished_at=NOW(), candidates=? WHERE id=?',
      ['complete', results.length, sessionId]
    );

    return results;

  } catch (err) {
    await db.log('error', 'scanner', `Scan failed: ${err.message}`);
    await db.query(
      "UPDATE scan_sessions SET status='error', finished_at=NOW() WHERE id=?",
      [sessionId]
    );
    throw err;
  }
}

async function getLatestCandidates(limit = 20) {
  return db.query(
    `SELECT c.*, s.scan_type, s.started_at as scan_time
     FROM candidates c
     JOIN scan_sessions s ON c.scan_session_id = s.id
     JOIN (
       SELECT symbol, MAX(id) AS latest_id
       FROM candidates
       WHERE status = 'pending'
       GROUP BY symbol
     ) latest ON c.id = latest.latest_id
     WHERE c.status = 'pending'
     ORDER BY c.composite_score DESC
     LIMIT ?`,
    [limit]
  );
}

module.exports = { runScan, getLatestCandidates };
