// Claude AI advisor for autotrader buy decisions
// Called at 9:35 AM ET before executing new position entries.
//
// Flow:
//   1. Receives top-10 eligible candidates (new positions only) + market context
//   2. Builds a detailed prompt: market conditions + full signal breakdown per stock
//   3. Calls Claude (Haiku 4.5 — fast + cheap ~$0.001/run)
//   4. Parses structured JSON response
//   5. Returns ranked picks + market assessment
//   6. Falls back to top-5-by-score if Claude fails or returns malformed JSON

const Anthropic = require('@anthropic-ai/sdk');
const db        = require('../db/db');

const MODEL = 'claude-sonnet-4-6';

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set in environment');
  return new Anthropic({ apiKey: key });
}

// ─── Format a single stock's full signal breakdown for Claude ─────────────────
// Parses the stored `why` text (e.g. "+5: Golden cross 6d ago\n-1: RSI ≥ 70...")
// and reconstructs a structured block with Layer 4 conditions explicitly listed.
function formatCandidateBlock(sig, spySig) {
  const price    = sig.price    ? `$${parseFloat(sig.price).toFixed(2)}`    : 'N/A';
  const rsi      = sig.rsi      ? parseFloat(sig.rsi).toFixed(1)            : 'N/A';
  const ma50f    = sig.ma50     ? parseFloat(sig.ma50)                      : null;
  const ma200f   = sig.ma200    ? parseFloat(sig.ma200)                     : null;
  const ema9f    = sig.ema9     ? parseFloat(sig.ema9)                      : null;
  const ema21f   = sig.ema21    ? parseFloat(sig.ema21)                     : null;
  const spyPrice = spySig?.price ? parseFloat(spySig.price)                 : null;

  // Split the stored why text into bullish/bearish signal lines
  const whyLines   = (sig.why || '').split('\n').map(l => l.trim()).filter(Boolean);
  const bullish    = whyLines.filter(l => l.startsWith('+'));
  const bearish    = whyLines.filter(l => l.startsWith('-'));

  // Layer 4 — evaluate each of the 5 conditions explicitly
  const l4Conditions = [
    {
      label: 'Price below 50MA',
      met:   ma50f !== null && sig.price !== null && parseFloat(sig.price) < ma50f,
    },
    {
      label: '50MA below 200MA (death zone)',
      met:   ma50f !== null && ma200f !== null && ma50f < ma200f,
    },
    {
      label: 'MACD bearish trend',
      met:   sig.macd_trend === 'bearish' || sig.macd_trend === 'below_signal',
    },
    {
      label: 'EMA9 below EMA21 (short-term momentum negative)',
      met:   ema9f !== null && ema21f !== null && ema9f < ema21f,
    },
    {
      label: 'SPY below SPY 200MA (market regime bearish)',
      met:   spyPrice !== null && spySig?.ma200 !== null && spyPrice < parseFloat(spySig?.ma200),
    },
  ];
  const l4MetCount = l4Conditions.filter(c => c.met).length;
  const l4Lines    = l4Conditions.map(c => `  [${c.met ? '✗ BEARISH' : '✓ ok    '}] ${c.label}`).join('\n');
  const l4Verdict  = l4MetCount >= 3
    ? `⚠️  ${l4MetCount}/5 conditions met — MOMENTUM FAILING (≥3 triggers force SELL)`
    : `✓  ${l4MetCount}/5 conditions met — momentum safe`;

  // Overextension above 50MA
  let extLine = '';
  if (ma50f && sig.price) {
    const pctAbove = ((parseFloat(sig.price) / ma50f) - 1) * 100;
    if (pctAbove > 0) extLine = `  Price ${pctAbove.toFixed(1)}% above 50MA\n`;
  }

  // Analyst consensus
  let analystLine = '';
  if (sig.analyst_buy !== null || sig.analyst_sell !== null) {
    analystLine = `  Analyst: ${sig.analyst_buy ?? 0} buy / ${sig.analyst_hold ?? 0} hold / ${sig.analyst_sell ?? 0} sell\n`;
  }

  // Target price upside
  let targetLine = '';
  if (sig.target_mean && sig.price) {
    const upside = ((parseFloat(sig.target_mean) / parseFloat(sig.price)) - 1) * 100;
    targetLine = `  Analyst target: $${parseFloat(sig.target_mean).toFixed(2)} (${upside > 0 ? '+' : ''}${upside.toFixed(1)}% upside)\n`;
  }

  return `
═══ ${sig.symbol}${sig.name ? ` (${sig.name})` : ''} ═══
Score: ${sig.score}/100  |  Price: ${price}  |  RSI: ${rsi}  |  Sector: ${sig.sector || 'N/A'}
${extLine}${analystLine}${targetLine}
BULLISH SIGNALS:
${bullish.length ? bullish.map(l => `  ${l}`).join('\n') : '  (none)'}

BEARISH SIGNALS:
${bearish.length ? bearish.map(l => `  ${l}`).join('\n') : '  (none)'}

MOMENTUM HEALTH (Layer 4 — force SELL if ≥3 of 5 bearish):
${l4Lines}
Layer 4 verdict: ${l4Verdict}
`.trim();
}

// ─── Format market context block ─────────────────────────────────────────────
function formatMarketContext(regime, vix, spySig, fearGreed) {
  const regimeLabel = {
    bull:    '🟢 BULL — SPY above both 50MA and 200MA. Entries allowed.',
    caution: '🟡 CAUTION — SPY above 200MA but below 50MA. Correction in progress.',
    bear:    '🔴 BEAR — SPY below 200MA. Entries blocked.',
    unknown: '⚪ UNKNOWN — SPY data unavailable.',
  }[regime] || regime;

  const vixLabel = vix === null    ? 'N/A'
                 : vix < 15        ? `${vix.toFixed(1)} — Low (calm market)`
                 : vix < 25        ? `${vix.toFixed(1)} — Elevated (some caution)`
                 :                   `${vix.toFixed(1)} — High (volatile — size positions down)`;

  const fgLabel = fearGreed === null ? 'N/A'
                : fearGreed < 25     ? `${fearGreed}/100 — Extreme Fear`
                : fearGreed < 45     ? `${fearGreed}/100 — Fear`
                : fearGreed < 55     ? `${fearGreed}/100 — Neutral`
                : fearGreed < 75     ? `${fearGreed}/100 — Greed`
                :                      `${fearGreed}/100 — Extreme Greed`;

  const spyLine = spySig
    ? `SPY: $${parseFloat(spySig.price).toFixed(2)} | MACD: ${spySig.macd_trend || 'N/A'} | RSI: ${spySig.rsi ? parseFloat(spySig.rsi).toFixed(1) : 'N/A'}`
    : 'SPY: data unavailable';

  return `CURRENT MARKET CONDITIONS:
  Regime:       ${regimeLabel}
  ${spyLine}
  VIX:          ${vixLabel}
  Fear & Greed: ${fgLabel}`;
}

// ─── Build full prompt ────────────────────────────────────────────────────────
function buildPrompt(candidates, marketContext) {
  const stockBlocks = candidates.map((c, i) =>
    `[CANDIDATE ${i + 1}]\n${formatCandidateBlock(c.sig, c.spySig)}`
  ).join('\n\n');

  return `You are a professional swing trader making buy decisions for a real money account.

${marketContext}

CANDIDATE STOCKS (pre-screened: score ≥65, pick_flag=1, not in portfolio):
${stockBlocks}

INSTRUCTIONS:
- Review all candidates considering today's market sentiment, trends, and each stock's full signal picture
- In fearful/volatile markets (high VIX, Fear & Greed < 45): prefer defensive names, strong fundamentals, low Layer 4 count
- In bullish/calm markets: momentum names with fresh golden crosses and aligned EMAs are acceptable
- You may recommend fewer than 5 if some candidates are clearly unsuitable
- Stocks with Layer 4 ≥ 3 should almost never be bought regardless of score
- Explain your reasoning briefly for each stock

Respond ONLY with valid JSON in exactly this format (no markdown, no code blocks, raw JSON only):
{
  "rankings": [
    {
      "rank": 1,
      "symbol": "TICKER",
      "buy": true,
      "confidence": "high",
      "reasoning": "One or two sentences explaining why."
    }
  ],
  "market_assessment": "One sentence on today's market conditions and how it shaped your picks.",
  "symbols_to_buy": ["TICKER1", "TICKER2"]
}

confidence must be one of: "high", "medium", "low"
symbols_to_buy must contain ONLY the symbols where buy=true, in ranked order.
Include ALL candidates in rankings (even those you decline to buy, with buy=false).`;
}

// ─── Parse Claude's JSON response ────────────────────────────────────────────
function parseResponse(raw) {
  // Strip any accidental markdown code fences
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  const parsed  = JSON.parse(cleaned);

  if (!parsed.rankings || !Array.isArray(parsed.rankings)) throw new Error('Missing rankings array');
  if (!parsed.symbols_to_buy || !Array.isArray(parsed.symbols_to_buy)) throw new Error('Missing symbols_to_buy');

  // Validate each ranking entry
  for (const r of parsed.rankings) {
    if (!r.symbol || typeof r.rank !== 'number') throw new Error(`Invalid ranking entry: ${JSON.stringify(r)}`);
  }

  return {
    rankings:         parsed.rankings,
    market_assessment: parsed.market_assessment || '',
    symbols_to_buy:   parsed.symbols_to_buy.map(s => s.toUpperCase()),
  };
}

// ─── Main export — get Claude's ranked picks ─────────────────────────────────
// candidates: array of { sig: stock_signals row, spySig: SPY row }
// regime, vix, fearGreed: market context values
// Returns: { rankings, market_assessment, symbols_to_buy, fallback: bool }
async function getRankedPicks(candidates, regime, vix, fearGreed) {
  // Always fetch SPY signal for Layer 4 condition 5
  const spySig = await db.queryOne(`SELECT price, ma50, ma200, macd_trend, rsi FROM stock_signals WHERE symbol = 'SPY'`)
    .catch(() => null);

  // Attach SPY to each candidate (needed for Layer 4 formatting)
  const enriched = candidates.map(sig => ({ sig, spySig }));

  const marketContext = formatMarketContext(regime, vix, spySig, fearGreed);
  const prompt        = buildPrompt(enriched, marketContext);

  try {
    const client   = getClient();
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: 2048,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw    = response.content[0]?.text || '';
    const result = parseResponse(raw);

    await db.log('info', 'claude_advisor',
      `Claude ranked ${result.symbols_to_buy.length} buys from ${candidates.length} candidates: ${result.symbols_to_buy.join(', ')}`);

    // Log full rankings including declined stocks so we can audit why each was or wasn't picked
    for (const r of result.rankings) {
      await db.log('info', 'claude_advisor',
        `  #${r.rank} ${r.symbol} [${r.buy ? 'BUY' : 'SKIP'}, ${r.confidence}] ${r.reasoning || ''}`);
    }
    if (result.market_assessment) {
      await db.log('info', 'claude_advisor', `  Market: ${result.market_assessment}`);
    }

    return { ...result, fallback: false, rawResponse: raw };

  } catch (err) {
    // Fallback: top 5 by score (already sorted)
    await db.log('warn', 'claude_advisor',
      `Claude failed (${err.message}) — falling back to top-5-by-score`);

    const fallbackSymbols = candidates.slice(0, 5).map(s => s.symbol);
    return {
      rankings:          fallbackSymbols.map((sym, i) => ({
        rank: i + 1, symbol: sym, buy: true, confidence: 'medium',
        reasoning: 'Claude unavailable — selected by score rank.',
      })),
      market_assessment: 'Claude unavailable — fallback to score-based selection.',
      symbols_to_buy:    fallbackSymbols,
      fallback:          true,
      rawResponse:       null,
    };
  }
}

module.exports = { getRankedPicks };
