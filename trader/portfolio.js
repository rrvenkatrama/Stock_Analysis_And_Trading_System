// Portfolio Recommendation Engine
// Runs after each scan. Builds a daily plan: what to buy, sell, hold, and swap.
// Human approves the whole plan at once — no individual stock picking needed.
//
// SWAP STRATEGY:
//   - Never sell a winner heading toward target (up >3%, target still >2% away)
//   - Never swap just for small score differences — need HOLD_SWAP_SCORE_DIFF points gap
//   - Never swap into earnings week (daysToEarnings <= 5)
//   - Exit fast if within 1.5% of stop loss — protect capital
//   - If score collapsed (< adaptive threshold) AND better candidate exists → swap
//   - Close old position first, then buy new (sequential execution)

const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');

// ─── Build the daily portfolio plan ──────────────────────────────────────────
// candidates: array of scored scan results (from scan.js)
// openPositions: rows from positions JOIN trades
// account: Alpaca account info
// params: from config/params.js
async function buildPlan(candidates, openPositions, account, params) {
  const buyingPower     = parseFloat(account.buying_power || 0);
  const accountEquity   = parseFloat(account.equity || account.portfolio_value || account.cash || params.account_size || 10000);
  const deployPct       = params.portfolio_deploy_pct   || 0.50;
  const deployable      = buyingPower * deployPct;
  const maxSlots        = params.max_open_positions     || 4;
  const maxPerPosition  = accountEquity * (params.max_position_pct || 0.10);
  const swapScoreGap    = params.hold_swap_score_diff   || 20;
  const minHoldGainPct  = params.min_hold_gain_pct      || 3;   // % gain → protect winner
  const minTargetRemain = params.min_target_remain_pct  || 2;   // % to target → let it run
  const stopWarnPct     = params.stop_warn_pct          || 1.5; // % to stop → exit early

  // Build a map of fresh scores from today's scan (symbol → scored result)
  const freshScores = {};
  for (const c of candidates) freshScores[c.symbol] = c;

  // ── Step 1: Evaluate every open position ────────────────────────────────
  const holds = [];
  const exits = []; // 'sell' (stop/score) or 'swap' (better candidate available)

  const heldSymbols = new Set(openPositions.map(p => p.symbol));

  for (const pos of openPositions) {
    const entryPrice   = parseFloat(pos.entry_price  || pos.t_entry);
    const currentPrice = parseFloat(pos.current_price || entryPrice);
    const stopPrice    = parseFloat(pos.stop_price   || pos.t_stop);
    const targetPrice  = parseFloat(pos.target_price || pos.t_target);
    const gainPct      = ((currentPrice - entryPrice) / entryPrice) * 100;
    const toTargetPct  = ((targetPrice  - currentPrice) / currentPrice) * 100;
    const toStopPct    = ((currentPrice - stopPrice)    / currentPrice) * 100;

    // Get today's fresh score for this position if it was re-scanned
    const fresh      = freshScores[pos.symbol];
    const freshScore = fresh?.scored?.compositeScore ?? null;
    const threshold  = fresh?.scored?.adaptiveThreshold ?? (params.min_score_threshold || 55);

    // Rule 1: Protect a winner still heading to target
    if (gainPct >= minHoldGainPct && toTargetPct >= minTargetRemain) {
      holds.push({
        symbol: pos.symbol,
        gainPct: gainPct.toFixed(1),
        toTargetPct: toTargetPct.toFixed(1),
        currentPrice, entryPrice, stopPrice, targetPrice,
        reason: `Up ${gainPct.toFixed(1)}% with ${toTargetPct.toFixed(1)}% remaining to target — let it run`,
        action: 'hold',
      });
      continue;
    }

    // Rule 2: Exit fast if dangerously close to stop
    if (toStopPct <= stopWarnPct) {
      exits.push({
        symbol: pos.symbol,
        gainPct: gainPct.toFixed(1),
        currentPrice, entryPrice, stopPrice, targetPrice,
        reason: `Within ${toStopPct.toFixed(1)}% of stop loss — exit to protect capital`,
        action: 'sell',
        swapFor: null,
      });
      continue;
    }

    // Rule 3: Score has fallen below threshold — look for a better swap
    if (freshScore !== null && freshScore < threshold) {
      // Find best candidate that is not this symbol and not already held
      const betterCandidate = candidates.find(c =>
        c.symbol !== pos.symbol &&
        !heldSymbols.has(c.symbol) &&
        c.scored.compositeScore >= threshold &&
        (c.fundData?.daysToEarnings == null || c.fundData.daysToEarnings > 5)
      );

      if (betterCandidate) {
        exits.push({
          symbol: pos.symbol,
          gainPct: gainPct.toFixed(1),
          freshScore,
          currentPrice, entryPrice, stopPrice, targetPrice,
          reason: `Score fell to ${freshScore}/100 (below threshold ${threshold}) — swapping into ${betterCandidate.symbol} (${betterCandidate.scored.compositeScore}/100)`,
          action: 'swap',
          swapFor: betterCandidate.symbol,
        });
        continue;
      }
      // No better candidate — hold and note the weak score
      holds.push({
        symbol: pos.symbol,
        gainPct: gainPct.toFixed(1),
        freshScore,
        currentPrice, entryPrice, stopPrice, targetPrice,
        reason: `Score ${freshScore}/100 is weak but no better candidate available — hold`,
        action: 'hold',
      });
      continue;
    }

    // Rule 4: Better candidate exists AND score gap >= swapScoreGap AND position flat/down
    if (freshScore !== null && gainPct < minHoldGainPct) {
      const dominatingCandidate = candidates.find(c =>
        c.symbol !== pos.symbol &&
        !heldSymbols.has(c.symbol) &&
        c.scored.compositeScore >= freshScore + swapScoreGap &&
        (c.fundData?.daysToEarnings == null || c.fundData.daysToEarnings > 5)
      );

      if (dominatingCandidate) {
        exits.push({
          symbol: pos.symbol,
          gainPct: gainPct.toFixed(1),
          freshScore,
          currentPrice, entryPrice, stopPrice, targetPrice,
          reason: `${dominatingCandidate.symbol} scores ${dominatingCandidate.scored.compositeScore} vs ${freshScore} here — ${dominatingCandidate.scored.compositeScore - freshScore} point advantage`,
          action: 'swap',
          swapFor: dominatingCandidate.symbol,
        });
        continue;
      }
    }

    // Default: hold
    holds.push({
      symbol: pos.symbol,
      gainPct: gainPct.toFixed(1),
      freshScore,
      currentPrice, entryPrice, stopPrice, targetPrice,
      reason: freshScore
        ? `Score ${freshScore}/100 — momentum intact`
        : `Momentum intact — hold`,
      action: 'hold',
    });
  }

  // ── Step 2: Determine open slots and size new buys ───────────────────────
  const holdCount  = holds.length;
  const openSlots  = maxSlots - holdCount; // exits free up slots for new buys

  // Exclude held symbols AND swap targets already claimed
  const heldSymbols    = new Set(holds.map(h => h.symbol));
  const claimedSwaps   = new Set(exits.filter(e => e.swapFor).map(e => e.swapFor));

  // Eligible new candidates: pass threshold, not held, no earnings this week
  const eligible = candidates.filter(c =>
    !heldSymbols.has(c.symbol) &&
    c.scored.compositeScore >= c.scored.adaptiveThreshold &&
    (c.fundData?.daysToEarnings == null || c.fundData.daysToEarnings > 5)
  );

  // Prioritise swap targets first, then top scored
  const swapBuys    = eligible.filter(c => claimedSwaps.has(c.symbol));
  const freshBuys   = eligible.filter(c => !claimedSwaps.has(c.symbol));
  const buyQueue    = [...swapBuys, ...freshBuys].slice(0, openSlots);

  // Per-position budget: split deployable equally, cap at max per position
  const perSlot = Math.min(
    openSlots > 0 ? deployable / openSlots : 0,
    maxPerPosition
  );

  const buys = buyQueue.map(c => {
    const price  = parseFloat(c.scored.levels.entry) || parseFloat(c.tech?.price) || 0;
    const shares = price > 0 ? Math.floor(perSlot / price) : 0;
    return {
      symbol:        c.symbol,
      candidateId:   c.candidateDbId || null,
      score:         c.scored.compositeScore,
      probability:   c.scored.probability,
      price,
      shares,
      estimatedCost: +(shares * price).toFixed(2),
      target:        c.scored.levels.target,
      stop:          c.scored.levels.stop,
      riskReward:    c.scored.levels.riskReward,
      holdDays:      c.scored.levels.holdDays,
      reasons:       c.scored.reasons,
      isSwapFor:     exits.find(e => e.swapFor === c.symbol)?.symbol || null,
    };
  }).filter(b => b.shares > 0);

  const totalCost = buys.reduce((s, b) => s + b.estimatedCost, 0);

  return {
    buys,
    exits,
    holds,
    deployable:   +deployable.toFixed(2),
    totalCost:    +totalCost.toFixed(2),
    buyingPower:  +buyingPower.toFixed(2),
    openSlots,
    summary: buildSummary(buys, exits, holds, totalCost, deployable),
  };
}

function buildSummary(buys, exits, holds, totalCost, deployable) {
  const parts = [];
  if (buys.length)  parts.push(`${buys.length} new position${buys.length > 1 ? 's' : ''}`);
  if (exits.length) parts.push(`${exits.length} exit${exits.length > 1 ? 's' : ''}`);
  if (holds.length) parts.push(`${holds.length} hold${holds.length > 1 ? 's' : ''}`);
  const action = parts.join(', ') || 'No changes — hold all';
  return `${action} · Deploying $${totalCost.toFixed(0)} of $${deployable.toFixed(0)} available`;
}

// ── Save plan to DB ──────────────────────────────────────────────────────────
async function savePlan(plan, scanSessionId) {
  const token   = uuidv4();
  const expires = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 hours (EOD)

  // Expire any previous pending plans
  await db.query("UPDATE portfolio_plans SET status='expired' WHERE status='pending'");

  const id = await db.insert(
    `INSERT INTO portfolio_plans
       (scan_session_id, status, plan_json, approval_token, approval_expires_at)
     VALUES (?, 'pending', ?, ?, ?)`,
    [scanSessionId, JSON.stringify(plan), token, expires]
  );

  return { id, token };
}

// ── Load latest pending plan ─────────────────────────────────────────────────
async function getLatestPlan() {
  return db.queryOne(
    `SELECT * FROM portfolio_plans ORDER BY created_at DESC LIMIT 1`
  );
}

async function getPlanByToken(token) {
  return db.queryOne(
    `SELECT * FROM portfolio_plans WHERE approval_token = ?`,
    [token]
  );
}

async function approvePlan(planId) {
  await db.query(
    "UPDATE portfolio_plans SET status='approved', approved_at=NOW() WHERE id=?",
    [planId]
  );
}

async function rejectPlan(planId) {
  await db.query(
    "UPDATE portfolio_plans SET status='rejected' WHERE id=?",
    [planId]
  );
}

async function markExecuted(planId) {
  await db.query(
    "UPDATE portfolio_plans SET status='executed', executed_at=NOW() WHERE id=?",
    [planId]
  );
}

module.exports = { buildPlan, savePlan, getLatestPlan, getPlanByToken, approvePlan, rejectPlan, markExecuted };
