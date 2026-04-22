// Stock analysis engine for My Stocks dashboard
// Computes composite score + BUY/HOLD/SELL + plain-English "Why" for each symbol

const ti      = require('technicalindicators');
const db      = require('../db/db');
const { getBarsFromDB, getActiveSymbols, getFundamentalsFromDB } = require('./yahoo_history');
const { getSectorPE, getSectorPS } = require('../data/finnhub');
const settingsCache = require('./settingsCache');

// ─── Simple helpers (mirrors analysis/technicals.js but standalone) ───────────
function smaOf(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function emaOf(values, period) {
  if (values.length < period) return null;
  const result = ti.EMA.calculate({ period, values: values.slice(-Math.max(period * 3, 100)) });
  return result.length ? result[result.length - 1] : null;
}

// Returns full EMA array (aligned from end — last element = most recent bar)
function emaArrayOf(values, period) {
  if (values.length < period) return [];
  return ti.EMA.calculate({ period, values: values.slice(-Math.max(period * 3, 100)) });
}

// How many sessions ago did fast EMA cross above slow EMA (bull) or below (bear)?
// Returns { bullCrossAgo, bearCrossAgo } — null if no cross within maxLookback
function emaShortCrossAgo(closes, fastPeriod = 9, slowPeriod = 21, maxLookback = 5) {
  const fast = emaArrayOf(closes, fastPeriod);
  const slow = emaArrayOf(closes, slowPeriod);
  const n = Math.min(fast.length, slow.length, maxLookback + 2);
  if (n < 2) return { bullCrossAgo: null, bearCrossAgo: null };
  let bullCrossAgo = null, bearCrossAgo = null;
  for (let ago = 0; ago < n - 1; ago++) {
    const cf = fast[fast.length - 1 - ago], pf = fast[fast.length - 2 - ago];
    const cs = slow[slow.length - 1 - ago], ps = slow[slow.length - 2 - ago];
    if (bullCrossAgo === null && pf <= ps && cf > cs) bullCrossAgo = ago;
    if (bearCrossAgo === null && pf >= ps && cf < cs) bearCrossAgo = ago;
    if (bullCrossAgo !== null && bearCrossAgo !== null) break;
  }
  return { bullCrossAgo, bearCrossAgo };
}

// Today's volume divided by the 20-day average (excluding today to avoid self-reference)
function volumeRatioOf(bars, avgPeriod = 20) {
  if (bars.length < avgPeriod + 1) return null;
  const vols = bars.map(b => b.volume).filter(v => v > 0);
  if (vols.length < avgPeriod + 1) return null;
  const todayVol = vols[vols.length - 1];
  const avg = vols.slice(-(avgPeriod + 1), -1).reduce((a, b) => a + b, 0) / avgPeriod;
  return avg > 0 ? todayVol / avg : null;
}

function rsiOf(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const result = ti.RSI.calculate({ period, values: closes.slice(-(period * 3)) });
  return result.length ? result[result.length - 1] : null;
}

// ─── MACD — returns full result array (all history) ──────────────────────────
function macdHistory(closes) {
  if (closes.length < 35) return [];
  return ti.MACD.calculate({
    values:             closes,
    fastPeriod:         12,
    slowPeriod:         26,
    signalPeriod:       9,
    SimpleMAOscillator: false,
    SimpleMASignal:     false,
  });
}

// ─── How many sessions ago did MACD last turn bullish ────────────────────────
function macdBullishCrossAgo(macdArr, maxLookback = 6) {
  for (let i = macdArr.length - 1; i >= Math.max(1, macdArr.length - maxLookback); i--) {
    const prev = macdArr[i - 1];
    const curr = macdArr[i];
    if (prev && curr && prev.MACD <= prev.signal && curr.MACD > curr.signal) {
      return macdArr.length - 1 - i;
    }
  }
  return null;
}

// ─── How many sessions ago did price cross above MA ──────────────────────────
// Scans backwards up to maxLookback; returns session count or null
function priceCrossedAboveMAago(closes, maPeriod, maxLookback = 5) {
  if (closes.length < maPeriod + maxLookback) return null;
  const priceNow = closes[closes.length - 1];
  const maNow    = smaOf(closes, maPeriod);
  if (!maNow || priceNow <= maNow) return null;  // not above MA today

  for (let ago = 1; ago <= maxLookback; ago++) {
    const pastCloses = closes.slice(0, closes.length - ago);
    const pastPrice  = pastCloses[pastCloses.length - 1];
    const pastMA     = smaOf(pastCloses, maPeriod);
    if (!pastMA) continue;
    if (pastPrice < pastMA) return ago; // was below MA `ago` sessions back
  }
  return null; // has been above MA for more than maxLookback sessions
}

// ─── Golden/death cross sessions ago with stable period check ─────────────────
// goldenAgo: sessions since cross AND was below GC for stableSessions before cross
function crossSessionsAgo(closes, maxLookback = 60, stableSessions = 20) {
  if (closes.length < 202) return { goldenAgo: null, deathAgo: null, goldenStable: false };
  let goldenAgo = null, deathAgo = null, goldenStable = false;

  for (let ago = 0; ago < maxLookback; ago++) {
    const end  = closes.length - ago;
    const ma50  = smaOf(closes.slice(0, end), 50);
    const ma200 = smaOf(closes.slice(0, end), 200);
    const ma50p = smaOf(closes.slice(0, end - 1), 50);
    const ma200p= smaOf(closes.slice(0, end - 1), 200);
    if (!ma50 || !ma200 || !ma50p || !ma200p) continue;

    // Detect crosses
    if (goldenAgo === null && ma50p <= ma200p && ma50 > ma200) {
      goldenAgo = ago;
      // Check if stable below GC for stableSessions before this cross
      goldenStable = true;
      for (let i = 1; i <= Math.min(stableSessions, ago + 1); i++) {
        const end2 = closes.length - ago - i;
        const ma50_2 = smaOf(closes.slice(0, end2), 50);
        const ma200_2 = smaOf(closes.slice(0, end2), 200);
        if (ma50_2 && ma200_2 && ma50_2 > ma200_2) {
          goldenStable = false; // Was above GC recently, not stable
          break;
        }
      }
    }

    if (deathAgo === null && ma50p >= ma200p && ma50 < ma200) {
      deathAgo = ago;
    }

    if (goldenAgo !== null && deathAgo !== null) break;
  }
  return { goldenAgo, deathAgo, goldenStable };
}

// ─── Signal names (weights loaded dynamically from database via settingsCache) ─
// Each signal maps to a name; the actual weight is loaded from signal_weights table
// Default weight = 1.0 for all signals; customizable via /settings page
const W = {
  // All signal keys remain the same for backward compatibility
  // The add() function will look up actual weights from settingsCache

  goldenCrossToday:        'golden_cross_today',
  goldenCrossRecent:       'golden_cross_recent',
  goldenCrossActive:       'golden_cross_active',
  deathCrossRecent:        'death_cross_recent',
  deathCrossActive:        'death_cross_active',
  priceCrossed200MAago:    'price_crossed_200ma',
  priceCrossed50MAago:     'price_crossed_50ma',
  above50MA:               'above_50ma',
  above200MA:              'above_200ma',
  below50MA:               'below_50ma',
  below200MA:              'below_200ma',
  overextended10pct:       'overextended_10pct',
  overextended15pct:       'overextended_15pct',
  overextended25pct:       'overextended_25pct',
  ema9CrossBullNow:        'ema9_cross_bull_now',
  ema9CrossBullRecent:     'ema9_cross_bull_recent',
  ema9AboveEma21:          'ema9_above_ema21',
  ema9BelowEma21:          'ema9_below_ema21',
  ema9CrossBearRecent:     'ema9_cross_bear_recent',
  emaStackBullish:         'ema_stack_bullish',
  emaStackBearish:         'ema_stack_bearish',
  volumeSurgeUp:           'volume_surge_up',
  volumeSurgeDown:         'volume_surge_down',
  volumeConfirmUp:         'volume_confirm_up',
  rsiOversoldRecovery:     'rsi_oversold_recovery',
  rsiDeeplyOversold:       'rsi_deeply_oversold',
  rsiNeutralBullish:       'rsi_neutral_bullish',
  rsiOverbought:           'rsi_overbought',
  macdBullishCrossNow:     'macd_bullish_cross_now',
  macdBullishCrossRecent:  'macd_bullish_cross_recent',
  macdTrendUp:             'macd_trend_up',
  macdTrendDown:           'macd_trend_down',
  fwdPEImproving:          'fwd_pe_improving',
  peBelowSector40pct:      'pe_below_sector_40pct',
  peBelowSector20pct:      'pe_below_sector_20pct',
  peBelowSector10pct:      'pe_below_sector_10pct',
  peAboveSector30pct:      'pe_above_sector_30pct',
  psBelowSector40pct:      'ps_below_sector_40pct',
  psBelowSector20pct:      'ps_below_sector_20pct',
  psAboveSector50pct:      'ps_above_sector_50pct',
  pegBelow1:               'peg_below_1',
  pegBelow2:               'peg_below_2',
  pegAbove3:               'peg_above_3',
  epsGrowthHigh:           'eps_growth_high',
  epsGrowthMod:            'eps_growth_mod',
  epsGrowthNeg:            'eps_growth_neg',
  revenueGrowthHigh:       'revenue_growth_high',
  revenueGrowthMod:        'revenue_growth_mod',
  roeStrong:               'roe_strong',
  roeGood:                 'roe_good',
  roePoor:                 'roe_poor',
  debtLow:                 'debt_low',
  debtHigh:                'debt_high',
  shortSqueeze:            'short_squeeze',
  shortBear:               'short_bear',
  recMeanStrongBuy:        'rec_mean_strong_buy',
  recMeanBuy:              'rec_mean_buy',
  recMeanSell:             'rec_mean_sell',
  divHigh:                 'div_high',
  divGood:                 'div_good',
  divMid:                  'div_mid',
  divSmall:                'div_small',
  analystStrongBuy:        'analyst_strong_buy',
  analystPositive:         'analyst_positive',
  analystNegative:         'analyst_negative',
  targetUpside30:          'target_upside_30',
  targetUpside15:          'target_upside_15',
  targetDownside10:        'target_downside_10',
  marketBullish:           'market_bullish',
  marketBearish:           'market_bearish',
};

// ─── Compute score and generate reasons ──────────────────────────────────────
// Scoring: weighted signal counting from database (settingsCache)
// Score = (sum of positive_weights - sum of negative_weights) / max(5, total_signals)
function computeScore(signals) {
  const reasons = [];
  let positiveCount = 0;
  let negativeCount = 0;

  // add() now looks up signal weight from settingsCache
  const add = (signalName, label) => {
    const weight = settingsCache.getSignalWeight(signalName);
    const sign = weight > 0 ? 1 : weight < 0 ? -1 : 0;
    if (weight > 0) positiveCount += weight;
    else if (weight < 0) negativeCount -= weight; // negativeCount is additive
    reasons.push({ pts: weight, label });
  };

  const {
    rsi, aboveMa50, aboveMa200,
    goldenAgo, deathAgo, isGoldenActive, isDeathActive,
    priceCross50Ago, priceCross200Ago,
    ma50, ma200, price,
    ema9, ema21, ema50ema,
    ema9BullCrossAgo, ema9BearCrossAgo,
    volRatio, priceChangePct,
    macdTrend, macdCrossAgo,
    peTrailing, peForward, divYield,
    psRatio, sectorPE, sectorPS,
    epsGrowth, revenueGrowth, debtEquity, roe, shortFloat,
    recMean, recCount,
    targetMean,
    analystBuy, analystSell, analystHold,
    marketBullish,
    priceLatest, isStock,
  } = signals;

  // ── MA cross signals ──────────────────────────────────────────────────────
  if (goldenAgo !== null && goldenAgo <= 5)   add(W.goldenCrossRecent, `Golden cross ${goldenAgo}d ago`);
  if (isGoldenActive)                         add(W.goldenCrossActive,  '50MA above 200MA (golden zone)');
  if (deathAgo !== null && deathAgo <= 5)     add(W.deathCrossRecent,  `Death cross ${deathAgo}d ago`);
  if (isDeathActive)                          add(W.deathCrossActive,   '50MA below 200MA (death zone)');

  // ── Price vs MA ──────────────────────────────────────────────────────────
  if (priceCross200Ago !== null) add(W.priceCrossed200MAago, `Price crossed above 200MA ${priceCross200Ago}d ago`);
  if (priceCross50Ago  !== null) add(W.priceCrossed50MAago,  `Price crossed above 50MA ${priceCross50Ago}d ago`);
  if (aboveMa200)  add(W.above200MA, 'Above 200-day MA');
  else if (aboveMa50) add(W.above50MA, 'Above 50-day MA');
  if (!aboveMa50)  add(W.below50MA,  'Below 50-day MA');
  if (!aboveMa200) add(W.below200MA, 'Below 200-day MA');

  // ── Overextension above 50DMA ─────────────────────────────────────────────
  if (ma50 && price > 0) {
    const pctAbove50 = (price - ma50) / ma50 * 100;
    if (pctAbove50 >= 25)      add(W.overextended25pct, `Overextended ${pctAbove50.toFixed(1)}% above 50DMA — mean-reversion risk`);
    else if (pctAbove50 >= 15) add(W.overextended15pct, `Overextended ${pctAbove50.toFixed(1)}% above 50DMA`);
    else if (pctAbove50 >= 10) add(W.overextended10pct, `${pctAbove50.toFixed(1)}% above 50DMA — stretched entry`);
  }

  // ── EMA 9/21 short-term cross ─────────────────────────────────────────────
  if (ema9BullCrossAgo !== null) {
    if (ema9BullCrossAgo <= 1) add(W.ema9CrossBullNow,    'EMA 9 just crossed above EMA 21 — swing entry signal');
    else                       add(W.ema9CrossBullRecent, `EMA 9/21 bull cross ${ema9BullCrossAgo}d ago`);
  } else if (ema9BearCrossAgo !== null && ema9BearCrossAgo <= 3) {
    add(W.ema9CrossBearRecent, `EMA 9 crossed below EMA 21 ${ema9BearCrossAgo}d ago`);
  } else if (ema9 !== null && ema21 !== null) {
    if (ema9 > ema21) add(W.ema9AboveEma21, 'EMA 9 above EMA 21 (short-term bullish)');
    else              add(W.ema9BelowEma21, 'EMA 9 below EMA 21 (short-term bearish)');
  }

  // ── EMA stack alignment ───────────────────────────────────────────────────
  if (priceLatest != null && ema9 != null && ema21 != null && ema50ema != null) {
    if (priceLatest > ema9 && ema9 > ema21 && ema21 > ema50ema)
      add(W.emaStackBullish, 'EMA stack fully aligned: price > EMA9 > EMA21 > EMA50');
    else if (priceLatest < ema9 && ema9 < ema21 && ema21 < ema50ema)
      add(W.emaStackBearish, 'EMA stack fully bearish: price < EMA9 < EMA21 < EMA50');
  }

  // ── Volume confirmation ───────────────────────────────────────────────────
  if (volRatio !== null) {
    if (volRatio >= 1.5 && priceChangePct > 0)
      add(W.volumeSurgeUp,    `Volume surge ${volRatio.toFixed(1)}x avg — institutional buying`);
    else if (volRatio >= 1.5 && priceChangePct <= 0)
      add(W.volumeSurgeDown,  `Volume surge ${volRatio.toFixed(1)}x avg — heavy selling pressure`);
    else if (volRatio >= 1.2 && priceChangePct > 0)
      add(W.volumeConfirmUp,  `Above-avg volume (${volRatio.toFixed(1)}x) confirms up move`);
  }

  // ── RSI ──────────────────────────────────────────────────────────────────
  if (rsi !== null) {
    if (rsi < 30)      add(W.rsiDeeplyOversold, `RSI < 30 oversold (${rsi.toFixed(1)})`);
    else if (rsi < 45) add(W.rsiOversoldRecovery, `RSI 30–45 recovering (${rsi.toFixed(1)})`);
    else if (rsi < 65) { /* neutral zone 45–65, no signal */ }
    else if (rsi >= 65) add(W.rsiOverbought, `RSI ≥ 65 overbought (${rsi.toFixed(1)})`);
  }

  // ── MACD ─────────────────────────────────────────────────────────────────
  // Cross bonus and trend bonus are mutually exclusive to avoid double-counting.
  // A bullish cross fires macdBullishCrossNow/Recent (+12/+7) AND sets trend='bullish'.
  // Applying macdTrendUp (+4) on top would double-count the same signal.
  if (macdCrossAgo !== null) {
    if (macdCrossAgo <= 1) add(W.macdBullishCrossNow,   'MACD just turned bullish');
    else                   add(W.macdBullishCrossRecent, `MACD bullish cross ${macdCrossAgo}d ago`);
  } else {
    // Only apply trend signal when there is no recent cross (cross already rewarded above)
    if (['bullish','above_signal'].includes(macdTrend)) add(W.macdTrendUp,   'MACD trending up');
    if (['bearish','below_signal'].includes(macdTrend)) add(W.macdTrendDown, 'MACD trending down');
  }

  // ── P/E vs sector average ─────────────────────────────────────────────────
  // Use trailing PE; fall back to forward PE if trailing unavailable
  const effectivePE  = peTrailing || peForward;
  const peLabel      = peTrailing ? 'trailing' : 'fwd';
  if (peTrailing && peForward && peForward < peTrailing)
    add(W.fwdPEImproving, `Earnings accelerating (fwd PE ${peForward.toFixed(1)} < trailing ${peTrailing.toFixed(1)})`);

  if (effectivePE && sectorPE) {
    const discount = (sectorPE - effectivePE) / sectorPE;
    if (discount >= 0.40)      add(W.peBelowSector40pct, `${peLabel} PE ${effectivePE.toFixed(1)} is 40%+ below sector avg (${sectorPE}x)`);
    else if (discount >= 0.20) add(W.peBelowSector20pct, `${peLabel} PE ${effectivePE.toFixed(1)} below sector avg (${sectorPE}x)`);
    else if (discount >= 0.10) add(W.peBelowSector10pct, `${peLabel} PE slightly below sector avg (${sectorPE}x)`);
    else if (discount < -0.30) add(W.peAboveSector30pct, `${peLabel} PE ${effectivePE.toFixed(1)} well above sector (${sectorPE}x)`);
  }

  // ── P/S ratio vs sector (fallback when no PE data) ────────────────────────
  if (!effectivePE && psRatio && sectorPS) {
    const psDisc = (sectorPS - psRatio) / sectorPS;
    if (psDisc >= 0.40)      add(W.psBelowSector40pct, `P/S ${psRatio.toFixed(1)} well below sector avg (${sectorPS}x)`);
    else if (psDisc >= 0.20) add(W.psBelowSector20pct, `P/S ${psRatio.toFixed(1)} below sector avg (${sectorPS}x)`);
    else if (psDisc < -0.50) add(W.psAboveSector50pct, `P/S ${psRatio.toFixed(1)} above sector avg (${sectorPS}x)`);
  }

  // ── PEG ratio — PE relative to growth (Peter Lynch) ──────────────────────
  // Finnhub epsGrowthPct is in % form (18.5 = 18.5%). PEG < 1 = undervalued vs growth.
  if (effectivePE && epsGrowth && epsGrowth > 0) {
    const peg = effectivePE / epsGrowth;
    if (peg < 1)      add(W.pegBelow1,  `PEG ${peg.toFixed(2)} — undervalued vs ${epsGrowth.toFixed(0)}% growth`);
    else if (peg < 2) add(W.pegBelow2,  `PEG ${peg.toFixed(2)} — fair value vs growth`);
    else if (peg > 3) add(W.pegAbove3,  `PEG ${peg.toFixed(2)} — expensive vs growth`);
  }

  // ── EPS & revenue growth ──────────────────────────────────────────────────
  if (isStock && epsGrowth !== null) {
    if (epsGrowth > 20)       add(W.epsGrowthHigh, `Strong 3Y EPS growth ${epsGrowth.toFixed(0)}%`);
    else if (epsGrowth > 10)  add(W.epsGrowthMod,  `Moderate 3Y EPS growth ${epsGrowth.toFixed(0)}%`);
    else if (epsGrowth < 0)   add(W.epsGrowthNeg,  `Declining 3Y EPS ${epsGrowth.toFixed(0)}%`);
  }
  if (isStock && revenueGrowth !== null) {
    if (revenueGrowth > 15)      add(W.revenueGrowthHigh, `Strong 3Y revenue growth ${revenueGrowth.toFixed(0)}%`);
    else if (revenueGrowth > 5)  add(W.revenueGrowthMod,  `Moderate 3Y revenue growth ${revenueGrowth.toFixed(0)}%`);
  }

  // ── Return on equity — business quality ───────────────────────────────────
  if (isStock && roe !== null) {
    if (roe > 20)      add(W.roeStrong, `Strong ROE ${roe.toFixed(1)}% — high-quality business`);
    else if (roe > 10) add(W.roeGood,   `Good ROE ${roe.toFixed(1)}%`);
    else if (roe < 0)  add(W.roePoor,   `Negative ROE ${roe.toFixed(1)}%`);
  }

  // ── Debt/equity — balance sheet risk ──────────────────────────────────────
  if (isStock && debtEquity !== null) {
    if (debtEquity < 0.3)      add(W.debtLow,  `Low debt/equity ${debtEquity.toFixed(2)} — strong balance sheet`);
    else if (debtEquity > 2.0) add(W.debtHigh, `High debt/equity ${debtEquity.toFixed(2)} — overleveraged`);
  }

  // ── Short interest ─────────────────────────────────────────────────────────
  if (isStock && shortFloat !== null && shortFloat > 20) {
    if (priceChangePct > 0)        add(W.shortSqueeze, `Short squeeze potential (${shortFloat.toFixed(1)}% of float short)`);
    else if (shortFloat > 30)      add(W.shortBear,    `High short interest ${shortFloat.toFixed(1)}% with price falling`);
  }

  // ── Dividend yield (tiered) ───────────────────────────────────────────────
  if (divYield && divYield > 0) {
    if (divYield >= 5)        add(W.divHigh,  `High dividend yield ${divYield.toFixed(1)}%`);
    else if (divYield >= 3)   add(W.divGood,  `Good dividend yield ${divYield.toFixed(1)}%`);
    else if (divYield >= 1.5) add(W.divMid,   `Dividend yield ${divYield.toFixed(1)}%`);
    else                      add(W.divSmall, `Small dividend yield ${divYield.toFixed(1)}%`);
  }

  // ── Yahoo consensus rating (1=Strong Buy → 5=Strong Sell) ────────────────
  // Distinct from Finnhub buy/sell/hold counts — different source, complementary
  if (isStock && recMean !== null && recCount >= 5) {
    if (recMean <= 1.5)      add(W.recMeanStrongBuy, `Wall St. strong buy (mean ${recMean.toFixed(1)}, ${recCount} analysts)`);
    else if (recMean <= 2.0) add(W.recMeanBuy,       `Wall St. buy consensus (mean ${recMean.toFixed(1)}, ${recCount} analysts)`);
    else if (recMean >= 4.0) add(W.recMeanSell,      `Wall St. sell consensus (mean ${recMean.toFixed(1)}, ${recCount} analysts)`);
  }

  // ── Analyst sentiment ─────────────────────────────────────────────────────
  const analystTotal = (analystBuy || 0) + (analystSell || 0) + (analystHold || 0);
  if (analystTotal >= 3) {
    const buyPct  = (analystBuy  || 0) / analystTotal;
    const sellPct = (analystSell || 0) / analystTotal;
    if (buyPct >= 0.70)
      add(W.analystStrongBuy, `Strong analyst consensus: ${analystBuy} buy / ${analystSell} sell / ${analystHold} hold`);
    else if (buyPct >= 0.50)
      add(W.analystPositive,  `Positive analyst consensus: ${analystBuy} buy / ${analystSell} sell`);
    else if (sellPct >= 0.40)
      add(W.analystNegative,  `Negative analyst consensus: ${analystSell} sell / ${analystBuy} buy`);
  }

  // ── Analyst price target upside ───────────────────────────────────────────
  if (isStock && targetMean && priceLatest > 0) {
    const upside = ((targetMean - priceLatest) / priceLatest) * 100;
    if (upside >= 30)
      add(W.targetUpside30, `Analyst avg target $${targetMean.toFixed(0)} (+${upside.toFixed(0)}% upside)`);
    else if (upside >= 15)
      add(W.targetUpside15, `Analyst avg target $${targetMean.toFixed(0)} (+${upside.toFixed(0)}% upside)`);
    else if (upside <= -10)
      add(W.targetDownside10, `Analyst avg target $${targetMean.toFixed(0)} (${upside.toFixed(0)}% downside)`);
  }

  // ── Market context ────────────────────────────────────────────────────────
  if (marketBullish === true)  add(W.marketBullish, 'Bullish market (SPY above 200MA)');
  if (marketBullish === false) add(W.marketBearish, 'Bearish market (SPY below 200MA)');

  // Calculate score: (positive_count - negative_count) / denominator
  // denominator = max(5, total_signals)
  // Score ranges from -100 to +100 (can be negative)
  // BUY: > 50%, HOLD: 20-50%, SELL: <= 20%
  const totalSignals = positiveCount + negativeCount;
  const denominator = Math.max(5, totalSignals);
  const rawScore = totalSignals > 0 ? (positiveCount - negativeCount) / denominator : 0;
  const finalScore = rawScore * 100;  // Can be negative, no clamping

  const allSignals = reasons
    .sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))
    .map(r => `${r.pts > 0 ? '+' : ''}${r.pts}: ${r.label}`)
    .join(' | ');
  const topReasons = `Score: ${finalScore.toFixed(0)}/100 (${positiveCount}/${denominator} signals bullish) | ${allSignals}`;

  return { finalScore, reasons, topReasons, positiveCount, negativeCount, denominator };
}

// ─── Analyze a single symbol ──────────────────────────────────────────────────
async function analyzeSymbol(symbol, quoteData = null) {
  const bars = await getBarsFromDB(symbol, 365);
  if (!bars || bars.length < 60) {
    await db.log('warn', 'analyzer', `Not enough bars for ${symbol}: ${bars?.length || 0}`);
    return null;
  }

  const closes  = bars.map(b => b.close);
  const price   = closes[closes.length - 1];
  const prevPrice = closes.length > 1 ? closes[closes.length - 2] : price;
  const changePct = prevPrice > 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;

  // Multi-period returns
  let chg1m = null;
  if (closes.length > 30) {
    const p30 = closes[closes.length - 30];
    if (p30 > 0) {
      chg1m = ((price - p30) / p30) * 100;
    }
  }

  let chg1y = null;
  if (closes.length > 252) {
    const p252 = closes[closes.length - 252];
    if (p252 > 0) {
      chg1y = ((price - p252) / p252) * 100;
    }
  }

  // YTD: find oldest bar in current year
  const now = new Date();
  const currentYear = now.getFullYear();
  let chgYtd = null;
  // bars array is ordered newest to oldest, find oldest bar in current year
  for (let i = bars.length - 1; i >= 0; i--) {
    const barDate = new Date(bars[i].trade_date);
    if (barDate.getFullYear() === currentYear && bars[i].close > 0) {
      chgYtd = ((price - bars[i].close) / bars[i].close) * 100;
      break;
    }
  }

  // 52-week range
  const year    = closes.slice(-252);
  const high52  = Math.max(...year);
  const low52   = Math.min(...year);
  const pctFrom52High = ((price - high52) / high52) * 100;
  const pctFrom52Low  = ((price - low52)  / low52)  * 100;

  // MAs
  const ma50   = smaOf(closes, 50);
  const ma200  = smaOf(closes, 200);
  const ema50  = emaOf(closes, 50);
  const ema200 = emaOf(closes, 200);
  const aboveMa50  = ma50  ? price > ma50  : null;
  const aboveMa200 = ma200 ? price > ma200 : null;

  // Cross signals
  const priceCross50Ago  = priceCrossedAboveMAago(closes, 50);
  const priceCross200Ago = priceCrossedAboveMAago(closes, 200);
  // Use golden cross stable period from settings (default 20 sessions)
  const gcSettings = settingsCache.getGoldenCross();
  const stablePeriod = gcSettings.stable_period_sessions !== undefined ? gcSettings.stable_period_sessions : 20;
  const { goldenAgo, deathAgo, goldenStable } = crossSessionsAgo(closes, 60, stablePeriod);
  const isGoldenActive = ma50 && ma200 ? ma50 > ma200 : false;
  const isDeathActive  = ma50 && ma200 ? ma50 < ma200 : false;

  // MACD
  const macdArr = macdHistory(closes);
  const lastMacd = macdArr.length ? macdArr[macdArr.length - 1] : null;
  let macdTrend = 'neutral';
  if (lastMacd) {
    const prev = macdArr[macdArr.length - 2];
    if (prev && prev.MACD <= prev.signal && lastMacd.MACD > lastMacd.signal) macdTrend = 'bullish';
    else if (prev && prev.MACD >= prev.signal && lastMacd.MACD < lastMacd.signal) macdTrend = 'bearish';
    else if (lastMacd.MACD > lastMacd.signal) macdTrend = 'above_signal';
    else if (lastMacd.MACD < lastMacd.signal) macdTrend = 'below_signal';
  }
  const macdCrossAgo = macdBullishCrossAgo(macdArr);

  // RSI
  const rsi = rsiOf(closes);
  const oversold = rsi !== null && rsi < 35;

  // EMA 9/21 short-term cross + stack alignment
  const ema9  = emaOf(closes, 9);
  const ema21 = emaOf(closes, 21);
  const { bullCrossAgo: ema9BullCrossAgo, bearCrossAgo: ema9BearCrossAgo } =
    emaShortCrossAgo(closes, 9, 21);

  // Volume surge vs 20-day average
  const volRatio = volumeRatioOf(bars);

  // Fundamentals: use quoteData if passed, otherwise read from watchlist cache
  const resolved   = quoteData || await getFundamentalsFromDB(symbol) || {};
  const assetType  = resolved.assetType  || 'stock';
  const isStock    = assetType === 'stock';
  const peTrailing    = isStock ? (resolved.peTrailing    || null) : null;
  const peForward     = isStock ? (resolved.peForward     || null) : null;
  const divYield      = isStock ? (resolved.divYield      || null) : null;
  const psRatio       = isStock ? (resolved.psRatio       || null) : null;
  const analystBuy    = isStock ? (resolved.analystBuy    ?? null) : null;
  const analystSell   = isStock ? (resolved.analystSell   ?? null) : null;
  const analystHold   = isStock ? (resolved.analystHold   ?? null) : null;
  const epsGrowth     = isStock ? (resolved.epsGrowth     ?? null) : null;
  const revenueGrowth = isStock ? (resolved.revenueGrowth ?? null) : null;
  const debtEquity    = isStock ? (resolved.debtEquity    ?? null) : null;
  const roe           = isStock ? (resolved.roe           ?? null) : null;
  const shortFloat    = isStock ? (resolved.shortFloat    ?? null) : null;
  const recMean       = isStock ? (resolved.recMean       ?? null) : null;
  const recCount      = isStock ? (resolved.recCount      ?? null) : null;
  const targetMean    = isStock ? (resolved.targetMean    ?? null) : null;
  const targetHigh    = isStock ? (resolved.targetHigh    ?? null) : null;
  const targetLow     = isStock ? (resolved.targetLow     ?? null) : null;

  // Sector benchmarks
  const sector   = resolved.sector || null;
  const sectorPE = isStock ? getSectorPE(sector) : null;
  const sectorPS = isStock ? getSectorPS(sector) : null;

  const signals = {
    rsi, aboveMa50, aboveMa200,
    goldenAgo, deathAgo, isGoldenActive, isDeathActive,
    priceCross50Ago, priceCross200Ago,
    ma50, ma200, price,
    ema9, ema21, ema50ema: ema50,
    ema9BullCrossAgo, ema9BearCrossAgo,
    volRatio, priceChangePct: changePct,
    macdTrend, macdCrossAgo,
    peTrailing, peForward, divYield, psRatio,
    sectorPE, sectorPS,
    epsGrowth, revenueGrowth, debtEquity, roe, shortFloat,
    recMean, recCount, targetMean,
    analystBuy, analystSell, analystHold,
    marketBullish: analyzeSymbol._marketBullish ?? null,
    priceLatest: price,
    isStock,
  };

  const { finalScore, topReasons, positiveCount, negativeCount, denominator } = computeScore(signals);

  // Use thresholds from settings (or defaults if not loaded)
  const scoringSettings = settingsCache.getScoring();
  const buyThreshold = scoringSettings.score_threshold_buy !== undefined ? scoringSettings.score_threshold_buy : 50;
  const holdMin = scoringSettings.score_threshold_hold_min !== undefined ? scoringSettings.score_threshold_hold_min : 20;
  const holdMax = scoringSettings.score_threshold_hold_max !== undefined ? scoringSettings.score_threshold_hold_max : 50;
  const sellThreshold = scoringSettings.score_threshold_sell !== undefined ? scoringSettings.score_threshold_sell : 20;

  // Layer 4 Pre-Buy Check (Momentum Deterioration)
  // Don't buy if ≥3 of 5 bearish conditions met
  let layer4BearishCount = 0;
  const layer4Conditions = [];
  if (!aboveMa50) { layer4BearishCount++; layer4Conditions.push('Price below 50DMA'); }
  if (ma50 && ma200 && ma50 < ma200) { layer4BearishCount++; layer4Conditions.push('50DMA below 200DMA'); }
  if (['bearish','below_signal'].includes(macdTrend)) { layer4BearishCount++; layer4Conditions.push('MACD bearish'); }
  if (ema9 !== null && ema21 !== null && ema9 < ema21) { layer4BearishCount++; layer4Conditions.push('EMA9 below EMA21'); }
  const spyMarketBullish = analyzeSymbol._marketBullish ?? null;
  if (spyMarketBullish === false) { layer4BearishCount++; layer4Conditions.push('SPY below 50DMA'); }

  // Integrated Layer 4 logic: Layer 4 ≥3 always triggers SELL, otherwise use signal score
  let recommendation;

  if (layer4BearishCount >= 3) {
    // Layer 4 ≥3 → SELL (overrides signal score)
    recommendation = 'SELL';
  } else {
    // Layer 4 ≤2 → Use signal-based scoring
    recommendation =
      finalScore > buyThreshold ? 'BUY' :
      finalScore > sellThreshold ? 'HOLD' : 'SELL';
  }

  // Format why field with clear sections: Signals, Layer 4, Decision
  const layer4ConditionsList = layer4Conditions.length > 0
    ? layer4Conditions.map(c => `  • ${c}`).join('\n')
    : '  (all momentum indicators bullish)';

  const scoreThresholdInfo = finalScore > buyThreshold ? `>50 (BUY)`
                            : finalScore > sellThreshold ? `20-50 (HOLD)`
                            : `≤20 (SELL)`;

  const whyText = `Signal Score: ${finalScore.toFixed(0)}/100 (${positiveCount} bullish, ${negativeCount} bearish)\n${topReasons.replace(/Score: \d+\/100.*?\| /, '').split(' | ').map(s => `  ${s}`).join('\n')}\n\nLayer 4 Score: ${layer4BearishCount}/5 bearish conditions:\n${layer4ConditionsList}\n\nDecision: ${recommendation}\n  Signal Score: ${finalScore.toFixed(0)} (${scoreThresholdInfo})\n  Layer 4: ${layer4BearishCount}/5 (${layer4BearishCount >= 3 ? '≥3 = FORCE SELL' : '≤2 = safe'})`;

  const crossType =
    isGoldenActive ? 'golden_cross' :
    isDeathActive  ? 'death_cross'  : 'none';

  // Upsert into stock_signals
  await db.query(
    `INSERT INTO stock_signals (
      symbol, name, sector, asset_type, generated_at,
      price, price_change_pct, chg_1m, chg_ytd, chg_1y,
      high_52w, low_52w, pct_from_52high, pct_from_52low,
      ma50, ma200, ema50, ema200, above_50ma, above_200ma,
      price_crossed_50ma_ago, price_crossed_200ma_ago,
      cross_type, golden_cross_ago, death_cross_ago,
      macd_value, macd_signal_value, macd_histogram, macd_trend, macd_cross_ago,
      rsi, oversold,
      pe_trailing, pe_forward, fwd_pe_improving, dividend_yield,
      target_mean, target_high, target_low,
      ema9_bull_cross_ago, ema9_bear_cross_ago,
      analyst_buy, analyst_sell, analyst_hold,
      score, signal_count, recommendation, why
    ) VALUES (?,?,?,?,NOW(),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      name=COALESCE(VALUES(name),name), sector=COALESCE(VALUES(sector),sector),
      asset_type=COALESCE(VALUES(asset_type),asset_type),
      generated_at=NOW(),
      price=VALUES(price), price_change_pct=VALUES(price_change_pct), chg_1m=VALUES(chg_1m), chg_ytd=VALUES(chg_ytd), chg_1y=VALUES(chg_1y),
      high_52w=VALUES(high_52w), low_52w=VALUES(low_52w),
      pct_from_52high=VALUES(pct_from_52high), pct_from_52low=VALUES(pct_from_52low),
      ma50=VALUES(ma50), ma200=VALUES(ma200), ema50=VALUES(ema50), ema200=VALUES(ema200),
      above_50ma=VALUES(above_50ma), above_200ma=VALUES(above_200ma),
      price_crossed_50ma_ago=VALUES(price_crossed_50ma_ago),
      price_crossed_200ma_ago=VALUES(price_crossed_200ma_ago),
      cross_type=VALUES(cross_type), golden_cross_ago=VALUES(golden_cross_ago),
      death_cross_ago=VALUES(death_cross_ago),
      macd_value=VALUES(macd_value), macd_signal_value=VALUES(macd_signal_value),
      macd_histogram=VALUES(macd_histogram), macd_trend=VALUES(macd_trend),
      macd_cross_ago=VALUES(macd_cross_ago),
      rsi=VALUES(rsi), oversold=VALUES(oversold),
      pe_trailing=COALESCE(VALUES(pe_trailing),pe_trailing),
      pe_forward=COALESCE(VALUES(pe_forward),pe_forward),
      fwd_pe_improving=VALUES(fwd_pe_improving),
      dividend_yield=COALESCE(VALUES(dividend_yield),dividend_yield),
      target_mean=COALESCE(VALUES(target_mean),target_mean),
      target_high=COALESCE(VALUES(target_high),target_high),
      target_low=COALESCE(VALUES(target_low),target_low),
      ema9_bull_cross_ago=VALUES(ema9_bull_cross_ago), ema9_bear_cross_ago=VALUES(ema9_bear_cross_ago),
      analyst_buy=COALESCE(VALUES(analyst_buy),analyst_buy),
      analyst_sell=COALESCE(VALUES(analyst_sell),analyst_sell),
      analyst_hold=COALESCE(VALUES(analyst_hold),analyst_hold),
      score=VALUES(score), signal_count=VALUES(signal_count), recommendation=VALUES(recommendation), why=VALUES(why)`,
    [
      symbol,
      resolved?.name   || null,
      resolved?.sector || null,
      assetType,
      price,
      Math.round(changePct * 100) / 100,
      chg1m !== null ? Math.round(chg1m * 100) / 100 : null,
      chgYtd !== null ? Math.round(chgYtd * 100) / 100 : null,
      chg1y !== null ? Math.round(chg1y * 100) / 100 : null,
      Math.round(high52  * 10000) / 10000,
      Math.round(low52   * 10000) / 10000,
      Math.round(pctFrom52High * 100) / 100,
      Math.round(pctFrom52Low  * 100) / 100,
      ma50   ? Math.round(ma50   * 100) / 100 : null,
      ma200  ? Math.round(ma200  * 100) / 100 : null,
      ema50  ? Math.round(ema50  * 100) / 100 : null,
      ema200 ? Math.round(ema200 * 100) / 100 : null,
      aboveMa50  ? 1 : 0,
      aboveMa200 ? 1 : 0,
      priceCross50Ago  ?? null,
      priceCross200Ago ?? null,
      crossType,
      goldenAgo ?? null,
      deathAgo  ?? null,
      lastMacd ? Math.round(lastMacd.MACD      * 10000) / 10000 : null,
      lastMacd ? Math.round(lastMacd.signal    * 10000) / 10000 : null,
      lastMacd ? Math.round(lastMacd.histogram * 10000) / 10000 : null,
      macdTrend,
      macdCrossAgo ?? null,
      rsi ? Math.round(rsi * 100) / 100 : null,
      oversold ? 1 : 0,
      peTrailing ? Math.round(peTrailing * 100) / 100 : null,
      peForward  ? Math.round(peForward  * 100) / 100 : null,
      (peTrailing && peForward && peForward < peTrailing) ? 1 : 0,
      divYield ? Math.round(divYield * 100) / 100 : null,
      targetMean ? Math.round(targetMean * 100) / 100 : null,
      targetHigh ? Math.round(targetHigh * 100) / 100 : null,
      targetLow  ? Math.round(targetLow  * 100) / 100 : null,
      ema9BullCrossAgo ?? null,
      ema9BearCrossAgo ?? null,
      analystBuy  ?? null,
      analystSell ?? null,
      analystHold ?? null,
      Math.round(finalScore * 100) / 100,
      denominator,
      recommendation,
      whyText,
    ]
  );

  return { symbol, score: finalScore, recommendation };
}

// ─── Analyze all active symbols ───────────────────────────────────────────────
async function analyzeAll(quotes = {}) {
  // Pre-compute market context from SPY bars (if available)
  // This is attached as a static property so computeScore can read it without
  // changing the signature of analyzeSymbol.
  try {
    const spyBars = await getBarsFromDB('SPY', 280);
    if (spyBars && spyBars.length >= 60) {
      const spyCloses = spyBars.map(b => b.close);
      const spyMa200  = smaOf(spyCloses, 200);
      const spyPrice  = spyCloses[spyCloses.length - 1];
      const spyMacd   = macdHistory(spyCloses);
      const spyLastMacd = spyMacd.length ? spyMacd[spyMacd.length - 1] : null;
      const spyMacdBull = spyLastMacd ? spyLastMacd.MACD > spyLastMacd.signal : false;
      analyzeSymbol._marketBullish = spyMa200
        ? (spyPrice > spyMa200 && spyMacdBull ? true : spyPrice < spyMa200 ? false : null)
        : null;
      console.log(`[Analyzer] Market context: SPY ${spyMa200 ? (spyPrice > spyMa200 ? 'above' : 'below') : '?'} 200MA → ${analyzeSymbol._marketBullish === true ? 'bullish' : analyzeSymbol._marketBullish === false ? 'bearish' : 'neutral'}`);
    }
  } catch (_) {
    analyzeSymbol._marketBullish = null;
  }

  const symbols = await getActiveSymbols();
  console.log(`[Analyzer] Analyzing ${symbols.length} symbols`);
  let done = 0;
  for (const sym of symbols) {
    try {
      await analyzeSymbol(sym, quotes[sym] || null);
    } catch (err) {
      console.error(`[Analyzer] Failed ${sym}: ${err.message}`);
    }
    done++;
    process.stdout.write(`\r[Analyzer] Progress: ${done}/${symbols.length}`);
  }
  console.log(`\n[Analyzer] Done`);
}

module.exports = { analyzeAll, analyzeSymbol };
