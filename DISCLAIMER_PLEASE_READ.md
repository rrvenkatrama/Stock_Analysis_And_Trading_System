# ⚠️ DISCLAIMER — PLEASE READ BEFORE USING THIS SOFTWARE

## This Is Not Financial Advice

StockTrader is a **personal research and automation tool** built for the author's own use.
It is shared publicly for educational purposes only.

**Nothing in this codebase constitutes financial advice, investment advice, trading advice,
or any other kind of advice. The author is not a licensed financial advisor, broker, or
investment professional.**

---

## Use At Your Own Risk

By using, copying, modifying, or deploying any part of this software, you agree that:

1. **You assume full responsibility** for any trades, losses, or financial outcomes that
   result from using this software, directly or indirectly.

2. **The author accepts no liability** for any financial loss, data loss, missed trades,
   incorrect signals, software bugs, API failures, or any other damages arising from the
   use of this software.

3. **Past performance of any scoring or signal logic does not guarantee future results.**
   Markets are unpredictable. Any system that worked yesterday may fail tomorrow.

4. **This software can place real orders with real money** if connected to a live Alpaca
   account. Always verify your `.env` configuration before enabling Autorun.

5. **The autotrader feature executes market orders automatically.** Understand exactly
   what it does before turning it on with real capital.

---

## Known Risks

- **API failures** (Alpaca, Finnhub, Yahoo Finance) can cause missed signals or incorrect data
- **Software bugs** can result in unintended orders or missed exits
- **Market gaps** (overnight, earnings, halts) can cause losses beyond the configured stop-loss
- **Rate limiting** on data providers can cause stale signals
- **Paper trading results do not guarantee live trading results**

---

## Before Using With Real Money

- [ ] Run in **paper trading mode** (default) for at least 4–8 weeks
- [ ] Verify all signals and recommendations manually before trusting automation
- [ ] Start with a small amount of capital you can afford to lose entirely
- [ ] Understand every parameter in `.env` and `config/params.js`
- [ ] Have an independent stop-loss strategy outside this software
- [ ] Consult a licensed financial advisor

---

## License

This software is provided **"as is"**, without warranty of any kind, express or implied.
The author makes no warranties regarding correctness, reliability, or fitness for any
particular purpose.

---

*By proceeding, you acknowledge that you have read and understood this disclaimer,
and that you are using this software entirely at your own risk.*
