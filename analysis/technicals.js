// Technical indicator calculations
// Uses the 'technicalindicators' npm package + manual implementations

const ti = require('technicalindicators');

// ─── Moving Averages ──────────────────────────────────────────────────────────
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;
  const result = ti.EMA.calculate({ period, values: values.slice(-Math.max(period * 3, 100)) });
  return result[result.length - 1] || null;
}

// ─── RSI ──────────────────────────────────────────────────────────────────────
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const result = ti.RSI.calculate({ period, values: closes.slice(-(period * 3)) });
  return result[result.length - 1] || null;
}

// ─── MACD ─────────────────────────────────────────────────────────────────────
function macd(closes) {
  if (closes.length < 35) return { signal: 'neutral', histogram: 0 };
  const result = ti.MACD.calculate({
    values:            closes,
    fastPeriod:        12,
    slowPeriod:        26,
    signalPeriod:      9,
    SimpleMAOscillator: false,
    SimpleMASignal:     false,
  });
  if (result.length < 2) return { signal: 'neutral', histogram: 0 };

  const prev = result[result.length - 2];
  const curr = result[result.length - 1];

  // Bullish crossover: MACD line crossed above signal line
  let signal = 'neutral';
  if (prev.MACD <= prev.signal && curr.MACD > curr.signal) signal = 'bullish';
  if (prev.MACD >= prev.signal && curr.MACD < curr.signal) signal = 'bearish';
  if (curr.MACD > curr.signal) signal = signal === 'bullish' ? 'bullish' : 'above_signal';
  if (curr.MACD < curr.signal) signal = signal === 'bearish' ? 'bearish' : 'below_signal';

  return {
    signal,
    isBullishCross: signal === 'bullish',
    isBearishCross: signal === 'bearish',
    macdValue:      curr.MACD,
    signalValue:    curr.signal,
    histogram:      curr.histogram,
  };
}

// ─── Bollinger Bands ──────────────────────────────────────────────────────────
function bollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return { position: 'normal', pctB: 0.5 };
  const result = ti.BollingerBands.calculate({
    period,
    values:  closes.slice(-(period * 2)),
    stdDev,
  });
  const band = result[result.length - 1];
  if (!band) return { position: 'normal', pctB: 0.5 };

  const price = closes[closes.length - 1];
  const pctB  = (price - band.lower) / (band.upper - band.lower);

  return {
    position: pctB < 0.1 ? 'oversold'
            : pctB > 0.9 ? 'overbought'
            : 'normal',
    pctB:    Math.round(pctB * 100) / 100,
    upper:   band.upper,
    middle:  band.middle,
    lower:   band.lower,
  };
}

// ─── Volume analysis ──────────────────────────────────────────────────────────
function volumeAnalysis(volumes) {
  if (volumes.length < 20) return { ratio: 1, spike: false };
  const avgVol = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
  const todayVol = volumes[volumes.length - 1];
  const ratio = avgVol > 0 ? todayVol / avgVol : 1;
  return {
    ratio:     Math.round(ratio * 100) / 100,
    avgVolume: Math.round(avgVol),
    spike:     ratio >= 1.5,
    strongSpike: ratio >= 2.5,
  };
}

// ─── Golden / Death Cross ─────────────────────────────────────────────────────
function crossSignal(closes) {
  if (closes.length < 201) return { cross: 'none', isGolden: false, isDeath: false };

  const ma50Today  = sma(closes, 50);
  const ma200Today = sma(closes, 200);
  const ma50Prev   = sma(closes.slice(0, -1), 50);
  const ma200Prev  = sma(closes.slice(0, -1), 200);

  if (!ma50Today || !ma200Today || !ma50Prev || !ma200Prev) {
    return { cross: 'none', isGolden: false, isDeath: false };
  }

  let cross = 'none';
  // Recent cross = within last 20 trading days
  // We also note the long-term state
  const goldenActive = ma50Today > ma200Today;  // 50MA currently above 200MA
  const deathActive  = ma50Today < ma200Today;

  if (ma50Prev <= ma200Prev && ma50Today > ma200Today) cross = 'golden_cross';
  if (ma50Prev >= ma200Prev && ma50Today < ma200Today) cross = 'death_cross';

  return {
    cross,
    isGolden:      goldenActive,
    isDeath:       deathActive,
    justCrossed:   cross !== 'none',
    ma50:          Math.round(ma50Today * 100) / 100,
    ma200:         Math.round(ma200Today * 100) / 100,
    maDiff:        Math.round(((ma50Today - ma200Today) / ma200Today) * 10000) / 100,
  };
}

// ─── Full technical analysis for one symbol ───────────────────────────────────
// bars = array of { open, high, low, close, volume } sorted oldest→newest
function analyze(bars) {
  if (!bars || bars.length < 20) return null;

  const closes  = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const highs   = bars.map(b => b.high);
  const lows    = bars.map(b => b.low);

  const price   = closes[closes.length - 1];
  const ma50    = sma(closes, 50);
  const ma200   = sma(closes, 200);
  const rsiVal  = rsi(closes);
  const macdRes = macd(closes);
  const bbRes   = bollingerBands(closes);
  const volRes  = volumeAnalysis(volumes);
  const crossRes= crossSignal(closes);

  // 52-week high/low
  const year = closes.slice(-252);
  const high52 = Math.max(...year);
  const low52  = Math.min(...year);
  const pctFrom52High = Math.round(((price - high52) / high52) * 10000) / 100;
  const pctFrom52Low  = Math.round(((price - low52)  / low52)  * 10000) / 100;

  // Average True Range (14-day) for volatility
  const atrResult = ti.ATR.calculate({
    high:   highs.slice(-30),
    low:    lows.slice(-30),
    close:  closes.slice(-30),
    period: 14,
  });
  const atr    = atrResult[atrResult.length - 1] || 0;
  const atrPct = price > 0 ? Math.round((atr / price) * 10000) / 100 : 0;

  return {
    price,
    ma50:           ma50   ? Math.round(ma50   * 100) / 100 : null,
    ma200:          ma200  ? Math.round(ma200  * 100) / 100 : null,
    aboveMa50:      ma50  ? price > ma50  : null,
    aboveMa200:     ma200 ? price > ma200 : null,
    maPctAbove50:   ma50  ? Math.round(((price - ma50)  / ma50)  * 10000) / 100 : null,
    maPctAbove200:  ma200 ? Math.round(((price - ma200) / ma200) * 10000) / 100 : null,
    rsi:            rsiVal ? Math.round(rsiVal * 100) / 100 : null,
    rsiSignal:      rsiVal ? (rsiVal < 30 ? 'oversold' : rsiVal > 70 ? 'overbought' : 'neutral') : 'neutral',
    macd:           macdRes,
    bollinger:      bbRes,
    volume:         volRes,
    cross:          crossRes,
    high52,
    low52,
    pctFrom52High,
    pctFrom52Low,
    atr,
    atrPct,
    barsAnalyzed:   bars.length,
  };
}

module.exports = { analyze, sma, ema, rsi, macd, bollingerBands, volumeAnalysis, crossSignal };
