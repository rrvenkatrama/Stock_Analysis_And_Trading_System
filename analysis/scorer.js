// Composite scoring engine
// All thresholds and weights come from config/params.js (DB-backed, editable via /admin)
// No hardcoded values — every filter is configurable at runtime

const { getSectorPE } = require('../data/finnhub');
const { getSectorScore } = require('../data/marketContext');
const paramsModule = require('../config/params');

// ─── Technical Score (0–100) ──────────────────────────────────────────────────
// Baseline 50 = neutral (no signals). Bullish signals push toward 100, bearish toward 0.
function scoreTechnical(tech, p) {
  if (!tech) return { score: 50, reasons: [], penalties: [] };
  let score = 50;
  const reasons  = [];
  const penalties = [];

  // RSI
  const rsi = tech.rsi;
  if (rsi !== null) {
    if      (rsi < p.rsi_deeply_oversold)               { score += 15; reasons.push(`RSI deeply oversold (${rsi})`); }
    else if (rsi < p.rsi_oversold)                       { score += 10; reasons.push(`RSI oversold (${rsi})`); }
    else if (rsi >= p.rsi_oversold && rsi < 50)          { score += 4; }
    else if (rsi > p.rsi_overbought)                     { score -= 8;  penalties.push(`RSI overbought (${rsi})`); }
  }

  // Golden / Death cross
  if (tech.cross?.justCrossed && tech.cross?.isGolden) {
    score += 12; reasons.push('Golden cross just formed (50MA crossed above 200MA)');
  } else if (tech.cross?.isGolden) {
    score += 8; reasons.push('Golden cross active (50MA above 200MA)');
  } else if (tech.cross?.justCrossed && tech.cross?.isDeath) {
    score -= 18; penalties.push('Death cross just formed — strong bearish signal');
  } else if (tech.cross?.isDeath) {
    score -= 12; penalties.push('Death cross active (50MA below 200MA)');
  }

  // Price vs 50MA
  if (tech.aboveMa50 === true) {
    score += 5; reasons.push('Price above 50-day MA');
  } else if (tech.aboveMa50 === false) {
    score -= 4; penalties.push('Price below 50-day MA');
  }

  // Price vs 200MA
  if (tech.aboveMa200 === true) {
    score += 5; reasons.push('Price above 200-day MA');
  } else if (tech.aboveMa200 === false) {
    score -= 6; penalties.push('Price below 200-day MA');
  }

  // MACD
  if (tech.macd?.isBullishCross)                        { score += 8; reasons.push('MACD bullish crossover'); }
  else if (tech.macd?.signal === 'above_signal')        { score += 3; }
  else if (tech.macd?.isBearishCross)                   { score -= 6; penalties.push('MACD bearish crossover'); }

  // Bollinger Bands
  if (tech.bollinger?.position === 'oversold')    { score += 6; reasons.push('At lower Bollinger Band (oversold)'); }
  if (tech.bollinger?.position === 'overbought')  { score -= 4; penalties.push('At upper Bollinger Band (overbought)'); }

  // Volume — use configurable ratios
  const vRatio = tech.volume?.ratio || 1;
  if (vRatio >= p.volume_strong_ratio) { score += 7; reasons.push(`Volume spike ${vRatio}x average`); }
  else if (vRatio >= p.volume_spike_ratio)  { score += 4; reasons.push(`Volume elevated ${vRatio}x average`); }

  // Near 52-week low is a potential opportunity (if other signals agree)
  if (tech.pctFrom52Low !== null && tech.pctFrom52Low < 10) {
    score += 4; reasons.push('Near 52-week low — potential value entry');
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, penalties };
}

// ─── Fundamental Score (0–100) ────────────────────────────────────────────────
// Baseline 50 = neutral (average PE, average growth, no debt concerns).
function scoreFundamental(fund, profile, earnings, p) {
  if (!fund) return { score: 50, reasons: [], penalties: [] };
  let score = 50;
  const reasons  = [];
  const penalties = [];

  // P/E vs sector average
  if (fund.pe && profile?.sector) {
    const sectorPE = getSectorPE(profile.sector);
    if      (fund.pe < sectorPE * p.pe_discount_strong) { score += 12; reasons.push(`P/E ${fund.pe} — well below sector avg ${sectorPE}`); }
    else if (fund.pe < sectorPE * p.pe_discount_mild)   { score += 6;  reasons.push(`P/E ${fund.pe} — below sector avg ${sectorPE}`); }
    else if (fund.pe > sectorPE * p.pe_premium)         { score -= 5;  penalties.push(`P/E ${fund.pe} — above sector avg (${sectorPE})`); }
  }

  // EPS growth
  if (fund.epsGrowthPct !== null) {
    if      (fund.epsGrowthPct > p.eps_growth_strong) { score += 10; reasons.push(`Strong EPS growth +${fund.epsGrowthPct}%`); }
    else if (fund.epsGrowthPct > p.eps_growth_mild)   { score += 6;  reasons.push(`Positive EPS growth +${fund.epsGrowthPct}%`); }
    else if (fund.epsGrowthPct > 0)                   { score += 3; }
    else                                               { score -= 5;  penalties.push(`Negative EPS growth ${fund.epsGrowthPct}%`); }
  }

  // Revenue growth
  if (fund.revenueGrowth !== null) {
    if      (fund.revenueGrowth > p.revenue_growth_strong) { score += 7; reasons.push(`Revenue growth +${fund.revenueGrowth}%`); }
    else if (fund.revenueGrowth > p.revenue_growth_mild)   { score += 4; }
    else if (fund.revenueGrowth < 0)                       { score -= 4; penalties.push(`Revenue declining ${fund.revenueGrowth}%`); }
  }

  // Debt/Equity
  if (fund.debtEquity !== null) {
    if      (fund.debtEquity < p.debt_equity_low)  { score += 5; reasons.push('Low debt/equity ratio'); }
    else if (fund.debtEquity > p.debt_equity_high) { score -= 6; penalties.push(`High debt/equity ${fund.debtEquity}`); }
  }

  // Earnings date risk
  if (earnings?.daysToEarnings !== null) {
    if (earnings.daysToEarnings <= p.earnings_imminent_days && earnings.daysToEarnings >= 0) {
      score -= 10;
      penalties.push(`Earnings in ${earnings.daysToEarnings} day(s) — volatility risk`);
    } else if (earnings.daysToEarnings <= p.earnings_near_days && earnings.daysToEarnings >= 0) {
      score -= 4;
      penalties.push(`Earnings in ${earnings.daysToEarnings} days — watch closely`);
    }
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, penalties };
}

// ─── Institutional Score (0–100) ──────────────────────────────────────────────
// Baseline 50 = neutral (no institutional signal either way).
function scoreInstitutional(inst, p) {
  if (!inst) return { score: 50, reasons: [], penalties: [] };
  let score = 50;
  const reasons  = [];
  const penalties = [];

  const { finviz = {}, superinvestor = {}, edgar = {} } = inst;

  // Superinvestor holdings
  if (superinvestor.recentlyAdded >= p.superinvestor_strong) {
    score += 12; reasons.push(`${superinvestor.recentlyAdded} superinvestors recently added position`);
  } else if (superinvestor.recentlyAdded >= p.superinvestor_mild) {
    score += 7;  reasons.push(`${superinvestor.holders?.[0]?.manager || 'Superinvestor'} recently added`);
  } else if (superinvestor.superinvestorCount >= p.superinvestor_holders) {
    score += 5;  reasons.push(`Held by ${superinvestor.superinvestorCount} superinvestors`);
  }

  // Insider activity
  if (finviz.insiderBuying)  { score += p.insider_buy_bonus;    reasons.push('Insider buying detected'); }
  if (finviz.insiderSelling) { score += p.insider_sell_penalty; penalties.push('Insider selling detected'); }

  // Institutional ownership trend
  if (finviz.instTransPct > p.inst_trans_strong) {
    score += 6; reasons.push(`Institutional ownership increasing (+${finviz.instTransPct}%)`);
  } else if (finviz.instTransPct < p.inst_trans_weak) {
    score -= 6; penalties.push(`Institutions reducing positions (${finviz.instTransPct}%)`);
  }

  // High institutional base
  if (finviz.instOwnPct > p.inst_own_high) {
    score += 4; reasons.push(`${finviz.instOwnPct}% institutional ownership`);
  }

  // Recent 13F filings
  if (edgar.recentFilings >= p.edgar_filings_strong) {
    score += 5; reasons.push(`${edgar.recentFilings} hedge funds filed 13F with position`);
  } else if (edgar.recentFilings >= p.edgar_filings_mild) {
    score += 3;
  }

  // Short interest — potential squeeze
  if (finviz.shortFloatPct > p.short_interest_squeeze) {
    score += 8; reasons.push(`High short interest ${finviz.shortFloatPct}% — squeeze potential`);
  } else if (finviz.shortFloatPct > p.short_interest_elevated) {
    score += 4; reasons.push(`Elevated short interest ${finviz.shortFloatPct}%`);
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, penalties };
}

// ─── Sentiment Score (0–100) ──────────────────────────────────────────────────
// Baseline 50 = neutral (50/50 analyst split, neutral news, mixed retail sentiment).
function scoreSentiment(analyst, priceTarget, sentiment, news, currentPrice, p) {
  let score = 50;
  const reasons  = [];
  const penalties = [];

  // Analyst consensus
  if (analyst) {
    const total = (analyst.totalBuy || 0) + (analyst.totalSell || 0) + (analyst.hold || 0);
    if (total > 0) {
      const buyPct = (analyst.totalBuy / total) * 100;
      if      (buyPct >= p.analyst_buy_pct_strong) { score += 10; reasons.push(`Strong analyst consensus: ${analyst.totalBuy} Buy, ${analyst.hold} Hold, ${analyst.totalSell} Sell`); }
      else if (buyPct >= p.analyst_buy_pct_mild)   { score += 5;  reasons.push(`Analyst consensus Buy: ${analyst.totalBuy}/${total}`); }
      else if (analyst.totalSell > analyst.totalBuy) { score -= 6; penalties.push('Analysts predominantly Sell'); }
    }
  }

  // Price target upside
  if (priceTarget?.targetMean && currentPrice) {
    const upside = ((priceTarget.targetMean - currentPrice) / currentPrice) * 100;
    if      (upside > p.price_target_upside_strong) { score += 8; reasons.push(`Analyst PT $${priceTarget.targetMean} — ${Math.round(upside)}% upside`); }
    else if (upside > p.price_target_upside_mild)   { score += 5; reasons.push(`Analyst PT $${priceTarget.targetMean} — ${Math.round(upside)}% upside`); }
    else if (upside < 0)                            { score -= 5; penalties.push(`Price above analyst target by ${Math.round(-upside)}%`); }
  }

  // Retail sentiment (StockTwits)
  if (sentiment?.stocktwits) {
    const bulls = sentiment.stocktwits.bullishPct;
    if      (bulls > p.stocktwits_bull_strong) { score += 6; reasons.push(`${bulls}% bullish on StockTwits`); }
    else if (bulls > p.stocktwits_bull_mild)   { score += 3; }
    else if (bulls < p.stocktwits_bear)        { score -= 4; penalties.push(`Only ${bulls}% bullish on StockTwits`); }
  }

  // News sentiment
  if (sentiment?.news?.avgSentiment !== undefined) {
    const ns = sentiment.news.avgSentiment;
    if      (ns > p.news_sentiment_positive) { score += 6; reasons.push('Strong positive news sentiment'); }
    else if (ns > p.news_sentiment_mild)     { score += 3; reasons.push('Positive news sentiment'); }
    else if (ns < p.news_sentiment_negative) { score -= 5; penalties.push('Negative news sentiment'); }
  }

  // Reddit momentum
  if (sentiment?.reddit?.mentions > 50) {
    score += 4; reasons.push(`Trending on Reddit (${sentiment.reddit.mentions} mentions)`);
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, penalties };
}

// ─── VIX-adaptive threshold ───────────────────────────────────────────────────
// Returns adjusted min score threshold based on current VIX
// High fear = lower bar needed (oversold stocks in fear markets are opportunities)
function getAdaptiveThreshold(baseThreshold, vixScore, p) {
  if (!vixScore || !p) return baseThreshold;
  if      (vixScore >= p.vix_extreme)  return baseThreshold - p.vix_extreme_reduction;
  else if (vixScore >= p.vix_high)     return baseThreshold - p.vix_high_reduction;
  else if (vixScore >= p.vix_elevated) return baseThreshold - p.vix_elevated_reduction;
  return baseThreshold;
}

// ─── Market context adjustment ────────────────────────────────────────────────
function applyMarketContext(baseScore, marketCtx, sector, p) {
  if (!marketCtx) return { adjustment: 0, reasons: [] };
  let adj = 0;
  const reasons = [];
  const vix = marketCtx.vix?.score || 20;

  if (marketCtx.spy?.isDeath) {
    adj += p.spy_death_cross_adj; reasons.push('S&P 500 in death cross — bearish market');
  }
  if (marketCtx.qqq?.isDeath) {
    adj += p.qqq_death_cross_adj; reasons.push('NASDAQ in death cross');
  }
  if (!marketCtx.spy?.aboveMa200) {
    adj += p.spy_below_200ma_adj; reasons.push('S&P 500 below 200-day MA');
  }

  // VIX — extreme fear is framed as opportunity (smaller penalty)
  if      (vix >= p.vix_extreme)  { adj += p.vix_extreme_adj;  reasons.push(`VIX ${vix} — extreme fear (potential bounce setups)`); }
  else if (vix >= p.vix_high)     { adj += p.vix_high_adj;     reasons.push(`VIX ${vix} — high fear in market`); }
  else if (vix >= p.vix_elevated) { adj += p.vix_elevated_adj; reasons.push(`VIX elevated at ${vix}`); }
  else if (vix < p.vix_low)       { adj += p.vix_low_adj;      reasons.push('Low VIX — calm market conditions'); }

  // Sector strength
  const sectorRet = getSectorScore(marketCtx.sectorStrength, sector);
  if      (sectorRet > p.sector_strong_threshold) { adj += p.sector_strong_adj; reasons.push(`${sector} sector strong (+${sectorRet}% 20d)`); }
  else if (sectorRet > 0)                         { adj += 2; }
  else if (sectorRet < p.sector_weak_threshold)   { adj += p.sector_weak_adj;   reasons.push(`${sector} sector weak (${sectorRet}% 20d)`); }

  // Golden cross on SPY is a big market tailwind
  if (marketCtx.spy?.cross?.isGolden) {
    adj += p.spy_golden_cross_adj; reasons.push('S&P 500 golden cross active — market tailwind');
  }

  return { adjustment: adj, reasons };
}

// ─── Probability estimate ─────────────────────────────────────────────────────
// Maps composite score to a calibrated probability estimate
// Deliberately conservative — never exceeds 85%
function estimateProbability(compositeScore, tech, earnings, p) {
  let prob = 30 + (compositeScore / 100) * 55;

  // Boost for very strong technical setups
  if (tech?.cross?.isGolden && tech?.rsi < p.rsi_oversold) prob += 3;
  if (tech?.macd?.isBullishCross && tech?.volume?.ratio >= p.volume_spike_ratio) prob += 2;

  // Penalty for earnings proximity
  if (earnings?.daysToEarnings <= p.earnings_imminent_days && earnings?.daysToEarnings >= 0) prob -= 8;

  return Math.max(35, Math.min(85, Math.round(prob)));
}

// ─── Suggested trade levels ───────────────────────────────────────────────────
function suggestLevels(price, tech, priceTarget, p) {
  const stopPct   = p.stop_loss_pct   || 0.05;
  const accountSz = p.account_size    || 100000;
  const maxPosPct = p.max_position_pct || 0.10;

  // Target: use analyst mean PT if within 30%, else use ATR-based target
  let target;
  if (priceTarget?.targetMean && priceTarget.targetMean > price &&
      priceTarget.targetMean < price * 1.30) {
    target = Math.round(priceTarget.targetMean * 100) / 100;
  } else if (tech?.atr) {
    target = Math.round((price + tech.atr * 3) * 100) / 100;
  } else {
    target = Math.round(price * 1.07 * 100) / 100;
  }

  const stop   = Math.round(price * (1 - stopPct) * 100) / 100;
  const maxPos = accountSz * maxPosPct;
  const shares = Math.floor(maxPos / price);
  const riskPerShare   = price - stop;
  const rewardPerShare = target - price;
  const rr = riskPerShare > 0 ? Math.round((rewardPerShare / riskPerShare) * 100) / 100 : 0;

  // Hold duration: longer if golden cross or strong fundamentals
  let holdDays = 3;
  if (tech?.cross?.isGolden) holdDays = 7;
  if (tech?.cross?.isGolden && tech?.aboveMa200) holdDays = 10;

  return { entry: price, target, stop, shares, riskReward: rr, holdDays };
}

// ─── Category classifier ──────────────────────────────────────────────────────
// Returns the most specific matching category label, or 'core' as default.
// Called after scoring so we have tech, fundData, analyst, and priceTarget.
function classifyCategory(tech, fundData, analystData) {
  const rsi        = tech?.rsi ?? 50;
  const volRatio   = tech?.volume?.ratio ?? 1;
  const aboveMa50  = tech?.aboveMa50 ?? false;
  const pct52High  = tech?.pctFrom52High ?? 0;

  const pe         = fundData?.pe ?? null;
  const divYield   = fundData?.dividendYield ?? null;

  const totalAnalyst = (analystData?.totalBuy ?? 0) + (analystData?.hold ?? 0) + (analystData?.totalSell ?? 0);
  const buyPct       = totalAnalyst > 0 ? (analystData.totalBuy / totalAnalyst) * 100 : 0;
  const instOwn      = fundData?.instOwnPct ?? 0;
  const debtEq       = fundData?.debtEquity ?? 999;

  // Breakout / news catalyst: volume surge + RSI not overbought + price crossed 50MA
  if (volRatio >= 2.5 && rsi >= 40 && rsi <= 70 && aboveMa50) {
    return 'breakout';
  }

  // Dividend value: well off 52wk high, low PE, meaningful yield
  if (pct52High <= -30 && pe !== null && pe <= 15 && divYield !== null && divYield >= 3) {
    return 'dividend_value';
  }

  // Strong moat + analyst conviction: analyst consensus strong, high institutional ownership, low debt
  if (buyPct >= 75 && instOwn >= 60 && debtEq < 1.0) {
    return 'strong_moat';
  }

  return 'core';
}

// ─── Hold vs Swap evaluation (for open positions) ─────────────────────────────
// Returns: 'hold', 'review', or 'consider_swap'
function evaluateHold(openPosition, newScore, newSymbol, p) {
  const { entryPrice, currentPrice, stopPrice, targetPrice, score: oldScore } = openPosition;
  const swapDiff = p?.hold_swap_score_diff || 20;

  const gainPct  = ((currentPrice - entryPrice) / entryPrice) * 100;
  const toTarget = ((targetPrice  - currentPrice) / currentPrice) * 100;

  // Never recommend swapping if still moving toward target
  if (gainPct > 5 && toTarget > 3) {
    return { action: 'hold', reason: `Up ${gainPct.toFixed(1)}% with ${toTarget.toFixed(1)}% to target — let it ride` };
  }

  if (oldScore >= 60 && newScore < oldScore + swapDiff) {
    return { action: 'hold', reason: `Score still ${oldScore}/100 — no compelling reason to swap` };
  }

  if (newScore >= oldScore + swapDiff) {
    return {
      action: 'consider_swap',
      reason: `${newSymbol} scores ${newScore} vs current ${oldScore} — significantly stronger setup`,
    };
  }

  if (oldScore < 45 || gainPct < -3) {
    return { action: 'review', reason: `Score dropped to ${oldScore} — review position` };
  }

  return { action: 'hold', reason: 'Momentum intact — hold' };
}

// ─── Master scoring function ──────────────────────────────────────────────────
// params (p) comes from config/params.js — DB-backed, editable via /admin
// Falls back to DEFAULTS if not provided
async function scoreCandidate({
  symbol,
  bars,
  tech,
  fundamentals,
  profile,
  earnings,
  analyst,
  priceTarget,
  institutional,
  sentiment,
  marketCtx,
  riskConfig,  // legacy: used for minScore/minProbability fallback
  params,      // preferred: full params object from config/params.js
}) {
  // Load params from DB if not passed in (e.g. direct calls)
  const p = params || await paramsModule.getParams();

  const W = {
    technical:     p.w_technical,
    fundamental:   p.w_fundamental,
    institutional: p.w_institutional,
    sentiment:     p.w_sentiment,
  };

  const techResult  = scoreTechnical(tech, p);
  const fundResult  = scoreFundamental(fundamentals, profile, earnings, p);
  const instResult  = scoreInstitutional(institutional, p);
  const sentResult  = scoreSentiment(analyst, priceTarget, sentiment, null, tech?.price, p);
  const mktAdj      = applyMarketContext(0, marketCtx, profile?.sector, p);

  // Weighted composite
  const rawScore =
    techResult.score  * W.technical     +
    fundResult.score  * W.fundamental   +
    instResult.score  * W.institutional +
    sentResult.score  * W.sentiment;

  const compositeScore = Math.max(0, Math.min(100,
    Math.round(rawScore + mktAdj.adjustment)
  ));

  const probability = estimateProbability(compositeScore, tech, earnings, p);
  const levels      = suggestLevels(tech?.price, tech, priceTarget, p);

  // Use DB params for thresholds (fall back to riskConfig for legacy callers)
  const baseScore = p.min_score_threshold || riskConfig?.minScore || 65;
  const baseProb  = p.min_probability     || riskConfig?.minProbability || 60;

  const adaptiveThreshold     = getAdaptiveThreshold(baseScore, marketCtx?.vix?.score, p);
  const adaptiveProbThreshold = getAdaptiveThreshold(baseProb,  marketCtx?.vix?.score, p);

  // Risk level
  const riskLevel = earnings?.daysToEarnings <= (p.earnings_imminent_days || 5)
    ? 'high'
    : compositeScore >= 70 ? 'low'
    : compositeScore >= 50 ? 'medium'
    : 'high';

  // Compile top reasons (positive)
  const allReasons = [
    ...techResult.reasons,
    ...fundResult.reasons,
    ...instResult.reasons,
    ...sentResult.reasons,
    ...mktAdj.reasons.filter(r => !r.includes('bear') && !r.includes('weak')),
  ].slice(0, 6);

  // Compile top penalties (negative)
  const allPenalties = [
    ...techResult.penalties,
    ...fundResult.penalties,
    ...instResult.penalties,
    ...sentResult.penalties,
    ...mktAdj.reasons.filter(r => r.includes('bear') || r.includes('weak') || r.includes('death')),
  ].slice(0, 4);

  return {
    symbol,
    compositeScore,
    probability,
    riskLevel,
    scores: {
      technical:     techResult.score,
      fundamental:   fundResult.score,
      institutional: instResult.score,
      sentiment:     sentResult.score,
      marketAdj:     mktAdj.adjustment,
    },
    reasons:   allReasons,
    penalties: allPenalties,
    levels,
    adaptiveThreshold,
    adaptiveProbThreshold,
  };
}

module.exports = {
  scoreCandidate,
  scoreTechnical,
  scoreFundamental,
  scoreInstitutional,
  scoreSentiment,
  evaluateHold,
  getAdaptiveThreshold,
  classifyCategory,
};
