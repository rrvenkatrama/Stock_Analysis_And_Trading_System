# Stock Scoring & Recommendation Methodology

**Last Updated:** 2026-04-22  
**Version:** 2.0 (Fully Configurable Weights)

---

## Quick Reference

### Recommendation Rules
| Score | Recommendation | Meaning |
|-------|---|---|
| **> 50** | 🟢 BUY | Strong entry signal |
| **20 to 50** | 🟡 HOLD | Mixed signals; wait |
| **≤ 20** | 🔴 SELL | Weak/negative signals |
| **Layer 4 ≥3** | 🔴 FORCE SELL | Momentum too bearish |

### Score Formula
```
Score = (Σ positive weights - Σ |negative weights|) / max(5, total_signals) × 100
Range: -100 to +100 (can be negative)
```

---

## Signal Weight System (Fully Configurable)

### How Weights Work
Signal weights are **stored in the `signal_weights` database table** and can be **any numeric value**:

- **Positive weights** = bullish signals (enter the signal's weight, e.g., +1, +2, +3)
- **Negative weights** = bearish signals (enter negative values, e.g., -1, -2, -3)
- **Higher absolute value** = stronger impact on score
- **0** = signal doesn't affect score (rarely used)

### Current Setup (Example)
Most signals currently set to ±1 for balanced weighting:
```
golden_cross_active     → weight: +1  (can increase to +3 if very powerful)
death_cross_active      → weight: -1  (can decrease to -3 if dangerous)
above_50ma              → weight: +1
below_50ma              → weight: -1
macd_trend_up           → weight: +1
macd_trend_down         → weight: -1
```

### Change Weights Anytime (No Code Deploy)
```sql
-- Emphasize powerful signals
UPDATE signal_weights SET weight = 3 WHERE signal_name = 'golden_cross_active';
UPDATE signal_weights SET weight = -3 WHERE signal_name = 'death_cross_active';

-- De-emphasize weak signals
UPDATE signal_weights SET weight = 0.5 WHERE signal_name = 'price_above_50ma';

-- View all weights
SELECT signal_name, weight FROM signal_weights ORDER BY weight DESC;
```

Then reload cache:
- **Manual**: Call `settingsCache.reloadSettings()`
- **Automatic**: Next scheduled analyzer run

---

## Recommendation Logic (Decision Tree)

### Step 1: Calculate Signal Score
```
positiveCount = sum of all positive weights (e.g., +1 + +1 + +2 = +4)
negativeCount = sum of absolute values of negative weights (e.g., |-1| + |-1| = 2)
totalSignals = positiveCount + negativeCount

Score = (positiveCount - negativeCount) / max(5, totalSignals) × 100
```

### Step 2: Apply Signal-Based Recommendation
```javascript
if (score > 50)            → recommendation = 'BUY'
if (score >= 20 && <= 50)  → recommendation = 'HOLD'
if (score < 20)            → recommendation = 'SELL'
```

### Step 3: Apply Layer 4 Override
**Layer 4 checks momentum deterioration.** If **≥3 of 5 conditions are met**, force SELL regardless of signal score:

1. Price < 50-day MA
2. 50-day MA < 200-day MA
3. MACD bearish trend
4. EMA 9 < EMA 21
5. SPY < SPY 50-day MA (market regime)

```javascript
if (layer4_bearish_count >= 3) {
  recommendation = 'SELL'  // Override signal score
}
```

**Why Layer 4?** Protects against false entries when trend is breaking down. Even if fundamentals are strong (high signal score), weak momentum suggests waiting.

---

## All Signal Categories

### Moving Averages (50 & 200 Day SMA)
| Signal | Bullish | Bearish | Notes |
|--------|---------|---------|-------|
| Golden cross (50MA > 200MA) | +1 | — | Active bullish trend |
| Death cross (50MA < 200MA) | — | -1 | Active bearish trend |
| Price > 200MA | +1 | — | Major resistance broken |
| Price > 50MA only | +1 | — | Minor resistance broken |
| Price < 50MA | — | -1 | Below key support |
| Price < 200MA | — | -1 | Below major support |

### Overextension Above 50MA (Poor Entry Risk)
| Range Above 50MA | Weight | Meaning |
|---|---|---|
| 10-15% | -1 | Stretched entry; retracement risk |
| 15-25% | -1 | Dangerous; likely pullback |
| >25% | -1 | Extreme; mean-reversion setup |

### EMA 9/21 Short-Term Momentum
| Signal | Bullish | Bearish | Notes |
|--------|---------|---------|-------|
| EMA9 just crossed above EMA21 (≤1d ago) | +1 | — | Swing entry; momentum turning |
| EMA9 above EMA21 (sustained) | +1 | — | Bullish momentum |
| EMA9 below EMA21 | — | -1 | Bearish momentum |
| EMA9 crossed below EMA21 (≤3d ago) | — | -1 | Momentum deteriorating |

### Volume Confirmation
| Signal | Bullish | Bearish | Notes |
|--------|---------|---------|-------|
| Price up + volume ≥1.5× 20-day avg | +1 | — | Institutional buying |
| Price down + volume ≥1.5× 20-day avg | — | -1 | Heavy selling pressure |
| Price up + volume 1.2-1.5× avg | +1 | — | Moderate bullish volume |

### RSI (14-period)
| Range | Bullish | Bearish | Notes |
|-------|---------|---------|-------|
| <30 (oversold) | +1 | — | Recovery setup |
| 30-45 (recovering) | +1 | — | Momentum building |
| >65 (overbought) | — | -1 | Pullback likely |

### MACD (12/26/9)
| Signal | Bullish | Bearish | Notes |
|--------|---------|---------|-------|
| MACD crosses above signal (≤1d ago) | +1 | — | Momentum turning positive |
| MACD > signal (above zero line) | +1 | — | Bullish trend |
| MACD < signal (below zero line) | — | -1 | Bearish trend |
| MACD crosses below signal | — | -1 | Momentum turning negative |

### Valuation (Stocks Only, Sector-Relative)
| Signal | Bullish | Bearish | Notes |
|--------|---------|---------|-------|
| PE 40%+ below sector avg | +1 | — | Deep value |
| PE 20-40% below sector avg | +1 | — | Good value |
| PE 30%+ above sector avg | — | -1 | Expensive relative to peers |
| PEG <1 (cheap vs growth) | +1 | — | Undervalued |
| PEG 1-2 (fair value) | +1 | — | Fairly priced |
| PEG >3 (expensive) | — | -1 | Overpriced growth |
| Forward PE < Trailing PE | +1 | — | Growth accelerating |

### Fundamental Quality (3Y Averages)
| Signal | Bullish | Bearish | Notes |
|--------|---------|---------|-------|
| EPS growth >20% | +1 | — | Strong earnings growth |
| EPS growth 10-20% | +1 | — | Moderate growth |
| EPS growth negative | — | -1 | Deteriorating earnings |
| Revenue growth >15% | +1 | — | Expanding business |
| Revenue growth 5-15% | +1 | — | Slow growth |
| ROE >20% | +1 | — | High-quality business |
| ROE 10-20% | +1 | — | Good quality |
| ROE negative | — | -1 | Value destruction |
| Debt/Equity <0.3 | +1 | — | Low leverage; safe |
| Debt/Equity >2.0 | — | -1 | High leverage; risky |

### Dividend Income
| Yield | Bullish | Notes |
|-------|---------|-------|
| ≥5% | +1 | High income |
| ≥3% | +1 | Good income |
| ≥1.5% | +1 | Modest income |
| ≥0.5% | +1 | Token dividend |

### Analyst Consensus (≥3 analysts required)
| Signal | Bullish | Bearish | Notes |
|--------|---------|---------|-------|
| ≥70% buy | +1 | — | Strong consensus |
| ≥50% buy | +1 | — | Consensus buy |
| ≥40% sell | — | -1 | Consensus sell |

### Short Interest
| Signal | Bullish | Bearish | Notes |
|--------|---------|---------|-------|
| >20% short + price rising | +1 | — | Squeeze potential |
| >30% short + price falling | — | -1 | Bears winning |

### Market Context (SPY Analysis)
| Signal | Bullish | Bearish | Notes |
|--------|---------|---------|-------|
| SPY > 200MA + MACD bullish | +1 | — | Global bullish regime |
| SPY < 200MA | — | -1 | Global bearish regime |

---

## Real Example: Adobe (ADBE) on 2026-04-22

### Raw Signals
```
Bullish (+1 each = +6 total):
  ✓ MACD trending up
  ✓ PE 13.9 is 40%+ below sector (sector avg 28x)
  ✓ PEG 0.76 (undervalued vs 18% growth)
  ✓ EPS growth 18% (moderate, 10-20% range)
  ✓ Revenue growth 11% (5-15% range)
  ✓ ROE 61.3% (>20%, high quality)

Bearish (-1 each = -4 total):
  ✗ 50MA below 200MA (death zone active)
  ✗ Price below 50MA
  ✗ Price below 200MA
  ✗ EMA 9 below EMA 21 (bearish momentum)
```

### Score Calculation
```
positiveCount = 6
negativeCount = 4
totalSignals = 10
denominator = max(5, 10) = 10

Score = (6 - 4) / 10 × 100 = 2/10 × 100 = 20/100
```

### Recommendation Decision
```
Signal-based: score=20, threshold=20 → SELL (at edge of threshold)

Layer 4 check:
  ✗ Price < 50MA (YES)
  ✗ 50MA < 200MA (YES)
  ✗ EMA9 < EMA21 (YES)
  ? MACD bearish (NO — MACD is bullish)
  ? SPY < 50MA (depends on SPY status)
  
  Layer 4 count: 3/5 ≥3 → FORCE SELL
```

### Final Recommendation
```
SELL (score 20 + Layer 4 override both agree)

Why: Stock has good fundamentals (valuations, growth, quality) but is in
a technical downtrend. The price is below key moving averages and momentum
is negative. Wait for price to recover above 50MA and EMA cross to turn
before entering.
```

---

## How to Update Weights

### Database Table Structure
```sql
CREATE TABLE signal_weights (
  id INT PRIMARY KEY AUTO_INCREMENT,
  signal_name VARCHAR(120) UNIQUE NOT NULL,
  weight DECIMAL(4,1) DEFAULT 1.0,
  signal_type VARCHAR(40),
  description TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Update Weights
```sql
-- Increase impact of powerful signals
UPDATE signal_weights SET weight = 3 WHERE signal_name = 'golden_cross_active';
UPDATE signal_weights SET weight = -3 WHERE signal_name = 'death_cross_active';

-- Decrease impact of weak signals
UPDATE signal_weights SET weight = 0.5 WHERE signal_name = 'above_50ma';

-- Use decimals if needed (e.g., for fine-tuning)
UPDATE signal_weights SET weight = 2.5 WHERE signal_name = 'macd_bullish_cross_now';
UPDATE signal_weights SET weight = -2.5 WHERE signal_name = 'macd_trend_down';

-- Check current setup
SELECT signal_name, weight, signal_type 
FROM signal_weights 
ORDER BY signal_type, weight DESC;
```

### Apply Changes
Changes take effect when `settingsCache.reloadSettings()` is called:
- **Automatic**: Next scheduled analyzer run
- **Manual**: In scripts, call before analyzer:
  ```javascript
  await settingsCache.reloadSettings();
  const result = await analyzer.analyzeSymbol('AAPL');
  ```

---

## Implementation Notes

### What Signal Names Map To
All signals in `portfolio_app/analyzer.js` use the W object to map signal names:
```javascript
const W = {
  goldenCrossActive:       'golden_cross_active',
  deathCrossActive:        'death_cross_active',
  above50MA:               'above_50ma',
  below50MA:               'below_50ma',
  ema9BelowEma21:          'ema9_below_ema21',
  // ... etc
};
```

These names **must match exactly** with the `signal_name` column in the database.

### Score Calculation Code
```javascript
function computeScore(signals) {
  let positiveCount = 0;
  let negativeCount = 0;
  
  const add = (signalName, label) => {
    const weight = settingsCache.getSignalWeight(signalName);
    if (weight > 0) {
      positiveCount += weight;
    } else if (weight < 0) {
      negativeCount -= weight;  // Add absolute value
    }
    // weight == 0: signal ignored
  };
  
  // ... call add() for each signal condition ...
  
  const totalSignals = positiveCount + negativeCount;
  const denominator = Math.max(5, totalSignals);
  const finalScore = ((positiveCount - negativeCount) / denominator) * 100;
  
  return { finalScore, positiveCount, negativeCount };
}
```

---

## Key Design Principles

### 1. Weights Are Fully Flexible
- Any positive or negative value works: +3, -2.5, +0.5, -1, etc.
- Higher absolute value = stronger signal
- Example strategies:
  - **Conservative**: All ±1 (equal weighting)
  - **Aggressive**: Crosses ±3, MAs ±1 (prioritize major trends)
  - **Momentum-focused**: MACD/EMA ±2, technicals ±1 (prioritize momentum)

### 2. Layer 4 Is Position-Exit Logic
Layer 4 checks momentum to prevent buying when trend is breaking down.
- Used for **initial entry recommendations**
- Also used by **autotrader position management** (separate sell logic)
- ≥3 bearish conditions **always force SELL**

### 3. Score Can Be Negative
Example: Stock with 2 positive signals and 8 negative signals:
```
Score = (2 - 8) / max(5,10) × 100 = -60/100 = -60
Recommendation: SELL
```
Negative scores are valid and indicate strong bearish signals.

### 4. Cache Must Be Reloaded
Analyzer reads weights from `settingsCache`, not directly from database:
- **Always call `settingsCache.reloadSettings()`** in batch scripts before analyzer runs
- Automatic refresh on scheduled runs

### 5. No Hardcoded Weights
Weights live in database only. Never hardcode `+3` or `-2` in analyzer.js.
Change via SQL, not code.

---

## Common Scenarios & Adjustments

### Scenario 1: Golden Cross Too Weak (+1)
If golden crosses don't drive buys strongly enough:
```sql
UPDATE signal_weights SET weight = 3 WHERE signal_name = 'golden_cross_active';
UPDATE signal_weights SET weight = 2 WHERE signal_name = 'golden_cross_recent';
```
Effect: Stocks with active golden cross will score +2 higher (from +1).

### Scenario 2: Overextension Too Harsh (-1)
If stocks 20% above 50MA are getting filtered too aggressively:
```sql
UPDATE signal_weights SET weight = -0.5 WHERE signal_name = 'overextended_10pct';
UPDATE signal_weights SET weight = -1.0 WHERE signal_name = 'overextended_15pct';
```
Effect: Overextension penalties cut in half.

### Scenario 3: Momentum Signals Too Strong
If MACD crosses are causing too many false entries:
```sql
UPDATE signal_weights SET weight = 0.5 WHERE signal_name = 'macd_bullish_cross_now';
UPDATE signal_weights SET weight = 0.5 WHERE signal_name = 'macd_bullish_cross_recent';
```
Effect: Momentum signals weakened; fundamentals become relatively stronger.

---

## Troubleshooting

### All Stocks Showing 0/100 Score
**Cause**: `settingsCache.reloadSettings()` not called before analyzer ran.  
**Fix**: Add cache reload in batch scripts:
```javascript
const settingsCache = require('../portfolio_app/settingsCache');
await settingsCache.reloadSettings();
```

### Weights Changed but Scores Not Updated
**Cause**: Cache not reloaded; scheduler hasn't run yet.  
**Fix**: Manually reload or wait for next scheduled run.

### Signal Name Not Found in Database
**Cause**: Typo in W object mapping or database signal_name.  
**Fix**: Check exact name:
```sql
SELECT signal_name FROM signal_weights 
WHERE signal_name LIKE '%death%';
```
Ensure W object uses exact same name.

---

## Document History

| Date | Change |
|---|---|
| 2026-04-22 | Complete rewrite. Clarified that signal weights are fully configurable (any value, not just ±1). Added decision tree, all signal categories, examples, and troubleshooting. |
