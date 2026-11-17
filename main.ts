// Two-leg cbBTC swing bot for the 24h BTC race (bars-replay/v1).
//
// Idea: the money in a 24h cbBTC replay is in the swings, and the tape has two
// kinds of them. Leg A buys the crash: price 3% below its 120-bar high after a
// hard 60-minute fall, once it has bounced off its 10-bar low. Leg B buys the
// ordinary dip: 1% below the 240-bar high, once it has bounced off its 10-bar
// low — the move a flat, choppy day makes again and again. Leg B is capped at
// two trades a window: in a falling market its dips keep coming and each one
// loses, so after two it stands down and lets leg A (or cash) carry the day.
// Both legs buy the whole stake, long only, and exit on a take-profit, a
// trailing stop off the peak since entry, a hard stop under cost, or a maximum
// hold, whichever comes first. A full-size round trip pays roughly 37 bps in
// fees, slippage and pool impact, so entries demand a dislocation and exits
// demand a real move; the bot never trades the chop in between.
//
// Backtested on the kit's dev window (2026-11-16 06:03Z -> 2026-11-17 06:03Z)
// and on the previous race's dev window (2026-11-14 08:28Z -> 2026-11-15
// 08:28Z) with the harness's exact fill model (fee 4 bps, slippage 2 bps,
// constant-product impact against each bar's open depth): dev +25.71 USDC on
// 2 round trips (2 wins, max drawdown 1.70%), previous window +17.41 USDC on
// 3 round trips (1 win, max drawdown 3.40%). The house baselines on the dev
// window: ema-cross -106.21, rsi-bollinger -24.25, adx-momentum -32.66,
// buy-and-hold +1.07, momentum +2.45.
//
// Protocol: the harness sends one `hello`, then one `batch` per bar (the bar
// that just closed, the fills of the previous batch's orders, and the
// account), and this bot answers every batch with exactly one reply echoing
// its seq. Orders decided on a batch fill at the next bar's open, so every
// decision here is made on closes only. No clock, no network, no randomness:
// the same bars always give the same orders, run after run. All comparisons
// are integer or float64 arithmetic on the bars as received; the EMAs and
// means the baselines use are not needed here.
//
// Entries (flat only, whole cash, max slippage 100 bps vs the latest close):
//   A) crash bounce: close >= 3% below the 120-bar high, 60-minute return
//      <= -1.5%, and the close bounced >= 0.3% off the 10-bar low.
//   B) flat-day dip: close >= 1% below the 240-bar high, and the close
//      bounced >= 0.2% off the 10-bar low; at most two B trades per run.
// Exits (whole position, whichever comes first):
//   A) take profit +4.5% over cost, trailing stop 1.5% below the peak value
//      since entry, hard stop -2% under cost, max hold 360 bars.
//   B) take profit +2% over cost, trailing stop 2% below the peak value
//      since entry, hard stop -1% under cost, max hold 720 bars.
// After any exit the bot may enter again on the next bar if an entry still
// holds (leg B only while it has trades left).

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;
/** History needed before either leg may fire: 240 bars for the 240-bar high. */
const MIN_HISTORY = 241;

/** Leg A: crash bounce. */
const A_DIP = 0.03;
const A_RET60 = -0.015;
const A_BOUNCE = 0.003;
const A_TP_NUM = 1045n; // +4.5% over cost
const A_TRAIL_NUM = 985n; // 1.5% below the peak value since entry
const A_STOP_NUM = 980n; // -2% under cost
const A_HOLD = 360;
/** Leg B: flat-day dip. */
const B_DIP = 0.01;
const B_BOUNCE = 0.002;
const B_TP_NUM = 1020n; // +2% over cost
const B_TRAIL_NUM = 980n; // 2% below the peak value since entry
const B_STOP_NUM = 990n; // -1% under cost
const B_HOLD = 720;
const B_MAX_TRADES = 2;

type Leg = 'A' | 'B';

/** Closes seen so far, raw price units (ratios are scale-free). */
const closes: number[] = [];
let leg: Leg | null = null;
let pendingLeg: Leg | null = null;
let bTrades = 0;
let peak = 0n;
let entrySeq = -1;
let buyCount = 0;
let sellCount = 0;

function maxBefore(n: number): number {
  // Max of the n closes before the current one.
  let m = -Infinity;
  for (let k = closes.length - 1 - n; k < closes.length - 1; k++) {
    if (closes[k] > m) m = closes[k];
  }
  return m;
}

function minBefore(n: number): number {
  // Min of the n closes before the current one.
  let m = Infinity;
  for (let k = closes.length - 1 - n; k < closes.length - 1; k++) {
    if (closes[k] < m) m = closes[k];
  }
  return m;
}

await runBars({
  onBatch(state, batch) {
    // Settle the previous batch's fills first: a filled buy names its leg,
    // a filled sell clears it. A rejected buy counts for nothing.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        leg = pendingLeg;
        if (leg === 'B') bTrades++;
        pendingLeg = null;
      } else {
        leg = null;
        pendingLeg = null;
        peak = 0n;
        entrySeq = -1;
      }
    }
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(Number(bar.c));
    }
    if (state.warmingUp) return [];
    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      if (value > peak) peak = value;
      const useLeg: Leg = leg ?? 'B';
      const tp = useLeg === 'A' ? A_TP_NUM : B_TP_NUM;
      const trail = useLeg === 'A' ? A_TRAIL_NUM : B_TRAIL_NUM;
      const stop = useLeg === 'A' ? A_STOP_NUM : B_STOP_NUM;
      const hold = useLeg === 'A' ? A_HOLD : B_HOLD;
      if (
        value * 1000n >= held.cost * tp ||
        value * 1000n <= peak * trail ||
        value * 1000n <= held.cost * stop ||
        (entrySeq >= 0 && state.seq - entrySeq >= hold)
      ) {
        sellCount++;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `sell${sellCount}` };
        return [sell];
      }
      return [];
    }
    if (closes.length < MIN_HISTORY) return [];
    const close = closes[closes.length - 1];
    const high120 = maxBefore(120);
    const high240 = maxBefore(240);
    const low10 = minBefore(10);
    const ret60 = close / closes[closes.length - 61] - 1;
    const { caps, fees } = state.hello;
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let slice = stake < byWeight ? stake : byWeight;
    if (state.cash < slice) slice = state.cash;
    if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
    // Leg A first: the crash bounce.
    if (close <= high120 * (1 - A_DIP) && ret60 <= A_RET60 && close >= low10 * (1 + A_BOUNCE)) {
      buyCount++;
      pendingLeg = 'A';
      entrySeq = state.seq + 1;
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `buyA${buyCount}` };
      return [buy];
    }
    // Leg B: the flat-day dip, at most two trades a run.
    if (bTrades < B_MAX_TRADES && close <= high240 * (1 - B_DIP) && close >= low10 * (1 + B_BOUNCE)) {
      buyCount++;
      pendingLeg = 'B';
      entrySeq = state.seq + 1;
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `buyB${buyCount}` };
      return [buy];
    }
    return [];
  },
});
