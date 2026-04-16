// Trade executor — places orders via Alpaca API
// Only called after user approval + guardrails pass

const axios      = require('axios');
const cfg        = require('../config/env');
const db         = require('../db/db');
const guardrails = require('./guardrails');

const headers = () => ({
  'APCA-API-KEY-ID':     cfg.alpaca.key,
  'APCA-API-SECRET-KEY': cfg.alpaca.secret,
  'Content-Type':        'application/json',
});

// ─── Alpaca API helpers ───────────────────────────────────────────────────────
async function alpacaGet(path) {
  const res = await axios.get(`${cfg.alpaca.baseUrl}/v2${path}`, {
    headers: headers(), timeout: 10000,
  });
  return res.data;
}

async function alpacaPost(path, body) {
  const res = await axios.post(`${cfg.alpaca.baseUrl}/v2${path}`, body, {
    headers: headers(), timeout: 10000,
  });
  return res.data;
}

async function alpacaDelete(path) {
  const res = await axios.delete(`${cfg.alpaca.baseUrl}/v2${path}`, {
    headers: headers(), timeout: 10000,
  });
  return res.data;
}

// ─── Get current account info ────────────────────────────────────────────────
async function getAccount() {
  return alpacaGet('/account');
}

// ─── Get all open positions from Alpaca ──────────────────────────────────────
async function getAlpacaPositions() {
  return alpacaGet('/positions');
}

// ─── Execute a buy trade ─────────────────────────────────────────────────────
// Called after user approves via dashboard or email link
async function executeBuy(tradeId) {
  const trade = await db.queryOne(
    'SELECT * FROM trades WHERE id = ? AND status = ?',
    [tradeId, 'approved']
  );
  if (!trade) throw new Error(`Trade ${tradeId} not found or not approved`);

  // Final guardrail check
  const check = await guardrails.checkAll(trade.symbol, trade.shares, trade.entry_price);
  if (!check.allowed) {
    await db.query(
      "UPDATE trades SET status='cancelled' WHERE id=?", [tradeId]
    );
    throw new Error(`Guardrail blocked: ${check.reason}`);
  }

  await db.query("UPDATE trades SET status='submitted', submitted_at=NOW() WHERE id=?", [tradeId]);

  try {
    // Place market buy order
    const order = await alpacaPost('/orders', {
      symbol:        trade.symbol,
      qty:           trade.shares,
      side:          'buy',
      type:          'market',
      time_in_force: 'day',
    });

    await db.query(
      "UPDATE trades SET alpaca_order_id=?, status='submitted' WHERE id=?",
      [order.id, tradeId]
    );

    await db.log('info', 'executor', `Buy order submitted: ${trade.shares} ${trade.symbol}`, { orderId: order.id });

    // Place stop loss order immediately
    const stopOrder = await placeStopLoss(trade.symbol, trade.shares, trade.stop_price);
    if (stopOrder?.id) {
      await db.query(
        'UPDATE trades SET alpaca_stop_id=? WHERE id=?',
        [stopOrder.id, tradeId]
      );
    }

    return { success: true, orderId: order.id, stopOrderId: stopOrder?.id };
  } catch (err) {
    await db.query("UPDATE trades SET status='cancelled' WHERE id=?", [tradeId]);
    await db.log('error', 'executor', `Order failed for ${trade.symbol}: ${err.message}`);
    throw err;
  }
}

// ─── Place stop loss order ────────────────────────────────────────────────────
async function placeStopLoss(symbol, shares, stopPrice) {
  try {
    const order = await alpacaPost('/orders', {
      symbol,
      qty:           shares,
      side:          'sell',
      type:          'stop',
      stop_price:    stopPrice.toFixed(2),
      time_in_force: 'gtc', // Good till cancelled
    });
    await db.log('info', 'executor', `Stop loss placed: ${symbol} @ $${stopPrice}`);
    return order;
  } catch (err) {
    await db.log('error', 'executor', `Stop loss failed for ${symbol}: ${err.message}`);
    return null;
  }
}

// ─── Close a position ─────────────────────────────────────────────────────────
async function closePosition(symbol, reason = 'manual') {
  try {
    // Cancel existing stop order first
    const pos = await db.queryOne(
      `SELECT t.*, p.current_price FROM trades t
       JOIN positions p ON p.trade_id = t.id
       WHERE t.symbol = ? AND t.status IN ('filled','partially_filled')`,
      [symbol]
    );

    if (pos?.alpaca_stop_id) {
      try { await alpacaDelete(`/orders/${pos.alpaca_stop_id}`); } catch (_) {}
    }

    // Market sell
    const order = await alpacaPost('/orders', {
      symbol,
      qty:           pos?.shares || 1,
      side:          'sell',
      type:          'market',
      time_in_force: 'day',
    });

    if (pos) {
      const closePrice = pos.current_price || pos.entry_price;
      const pnl        = (closePrice - pos.entry_price) * pos.shares;
      const pnlPct     = ((closePrice - pos.entry_price) / pos.entry_price) * 100;

      await db.query(
        `UPDATE trades SET status='closed', closed_at=NOW(), close_price=?,
         close_reason=?, pnl=?, pnl_pct=? WHERE id=?`,
        [closePrice, reason, pnl.toFixed(2), pnlPct.toFixed(2), pos.id]
      );
      await db.query('DELETE FROM positions WHERE trade_id=?', [pos.id]);
    }

    await db.log('info', 'executor', `Position closed: ${symbol} — ${reason}`);
    return { success: true, orderId: order.id };
  } catch (err) {
    await db.log('error', 'executor', `Close failed for ${symbol}: ${err.message}`);
    throw err;
  }
}

// ─── Sync positions with Alpaca (called every 5 min) ──────────────────────────
async function syncPositions() {
  try {
    const alpacaPos = await getAlpacaPositions();
    const alpacaMap = {};
    for (const p of alpacaPos) alpacaMap[p.symbol] = p;

    // Update current prices on open positions
    const dbPositions = await db.query('SELECT * FROM positions');
    for (const pos of dbPositions) {
      const ap = alpacaMap[pos.symbol];
      if (ap) {
        const currentPrice  = parseFloat(ap.current_price);
        const unrealizedPnl = parseFloat(ap.unrealized_pl);
        const unrealizedPct = parseFloat(ap.unrealized_plpc) * 100;
        await db.query(
          'UPDATE positions SET current_price=?, unrealized_pnl=?, unrealized_pct=?, updated_at=NOW() WHERE id=?',
          [currentPrice, unrealizedPnl, unrealizedPct, pos.id]
        );
      } else {
        // Position no longer exists on Alpaca — likely stop was hit
        await db.log('info', 'executor', `Position ${pos.symbol} no longer on Alpaca — marking closed`);
        const trade = await db.queryOne('SELECT * FROM trades WHERE id=?', [pos.trade_id]);
        if (trade) {
          const pnl    = (pos.current_price - pos.entry_price) * pos.shares;
          const pnlPct = ((pos.current_price - pos.entry_price) / pos.entry_price) * 100;
          await db.query(
            `UPDATE trades SET status='closed', closed_at=NOW(), close_price=?,
             close_reason='stop_triggered', pnl=?, pnl_pct=? WHERE id=?`,
            [pos.current_price, pnl.toFixed(2), pnlPct.toFixed(2), pos.trade_id]
          );
        }
        await db.query('DELETE FROM positions WHERE id=?', [pos.id]);
      }
    }

    // Mark buy orders as filled if Alpaca shows them filled
    const pendingTrades = await db.query(
      "SELECT * FROM trades WHERE status = 'submitted' AND alpaca_order_id IS NOT NULL"
    );
    for (const trade of pendingTrades) {
      try {
        const order = await alpacaGet(`/orders/${trade.alpaca_order_id}`);
        if (order.status === 'filled') {
          const fillPrice = parseFloat(order.filled_avg_price);
          await db.query(
            "UPDATE trades SET status='filled', filled_at=NOW(), fill_price=? WHERE id=?",
            [fillPrice, trade.id]
          );
          // Create position record
          await db.query(
            `INSERT IGNORE INTO positions (trade_id, symbol, shares, entry_price, current_price,
             stop_price, target_price, opened_at)
             VALUES (?,?,?,?,?,?,?,NOW())`,
            [trade.id, trade.symbol, trade.shares, fillPrice, fillPrice,
             trade.stop_price, trade.target_price]
          );
        }
      } catch (_) {}
    }
  } catch (err) {
    await db.log('error', 'executor', `Sync failed: ${err.message}`);
  }
}

// ─── Execute an approved portfolio plan ──────────────────────────────────────
// Order of operations: close exits first (free up capital), then open buys.
// Each step is logged. Failures on individual legs do not abort the whole plan.
async function executePlan(plan, planId) {
  const log = (msg) => db.log('info', 'executor', `[Plan ${planId}] ${msg}`);
  const results = { sold: [], bought: [], errors: [] };

  // ── Step 1: Close all exits (sells + swaps) ────────────────────────────
  for (const exit of (plan.exits || [])) {
    try {
      await log(`Closing ${exit.symbol} — ${exit.reason}`);
      await closePosition(exit.symbol, exit.action === 'swap' ? 'swap' : 'plan_exit');
      results.sold.push(exit.symbol);
    } catch (err) {
      await log(`Failed to close ${exit.symbol}: ${err.message}`);
      results.errors.push(`Close ${exit.symbol}: ${err.message}`);
    }
  }

  // Brief pause to let Alpaca process the sells before buying
  if (results.sold.length > 0) {
    await new Promise(r => setTimeout(r, 3000));
  }

  // ── Step 2: Open all new buys ──────────────────────────────────────────
  for (const buy of (plan.buys || [])) {
    try {
      if (buy.shares < 1) {
        results.errors.push(`${buy.symbol}: shares < 1, skipped`);
        continue;
      }

      // Final guardrail check
      const check = await guardrails.checkAll(buy.symbol, buy.shares, buy.price);
      if (!check.allowed) {
        results.errors.push(`${buy.symbol} blocked: ${check.reason}`);
        await log(`Guardrail blocked ${buy.symbol}: ${check.reason}`);
        continue;
      }

      // Create trade record
      const tradeId = await db.insert(
        `INSERT INTO trades (candidate_id, symbol, side, shares, entry_price,
         stop_price, target_price, status, approved_at)
         VALUES (?, ?, 'buy', ?, ?, ?, ?, 'approved', NOW())`,
        [buy.candidateId || null, buy.symbol, buy.shares,
         buy.price, buy.stop, buy.target]
      );

      await db.query("UPDATE trades SET status='submitted', submitted_at=NOW() WHERE id=?", [tradeId]);

      const order = await alpacaPost('/orders', {
        symbol:        buy.symbol,
        qty:           buy.shares,
        side:          'buy',
        type:          'market',
        time_in_force: 'day',
      });

      await db.query(
        "UPDATE trades SET alpaca_order_id=? WHERE id=?",
        [order.id, tradeId]
      );

      // Place stop loss
      const stopOrder = await placeStopLoss(buy.symbol, buy.shares, buy.stop);
      if (stopOrder?.id) {
        await db.query('UPDATE trades SET alpaca_stop_id=? WHERE id=?', [stopOrder.id, tradeId]);
      }

      if (buy.candidateId) {
        await db.query("UPDATE candidates SET status='selected' WHERE id=?", [buy.candidateId]);
      }

      results.bought.push(buy.symbol);
      await log(`Bought ${buy.shares} ${buy.symbol} @ market, stop $${buy.stop}`);

    } catch (err) {
      await log(`Failed to buy ${buy.symbol}: ${err.message}`);
      results.errors.push(`Buy ${buy.symbol}: ${err.message}`);
    }
  }

  await log(`Plan complete — sold: [${results.sold.join(',')}] bought: [${results.bought.join(',')}] errors: ${results.errors.length}`);
  return results;
}

// ─── Direct order placement (portfolio dashboard) ────────────────────────────
async function placeDirectOrder({ symbol, qty, side = 'buy', type, timeInForce, limitPrice, extendedHours = false }) {
  const body = {
    symbol: symbol.toUpperCase(),
    qty:    parseInt(qty),
    side,
    type,
    time_in_force: timeInForce,
  };
  if (type === 'limit' && limitPrice) body.limit_price = parseFloat(limitPrice).toFixed(2);
  if (extendedHours) body.extended_hours = true;
  return alpacaPost('/orders', body);
}

async function getOpenOrders() {
  return alpacaGet('/orders?status=open&limit=50');
}

async function cancelAlpacaOrder(orderId) {
  return alpacaDelete(`/orders/${orderId}`);
}

async function getMarketClock() {
  return alpacaGet('/clock');
}

module.exports = {
  executeBuy, executePlan, closePosition, syncPositions,
  getAccount, getAlpacaPositions, placeStopLoss,
  placeDirectOrder, getOpenOrders, cancelAlpacaOrder, getMarketClock,
};
