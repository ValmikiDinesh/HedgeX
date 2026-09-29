import binanceService from '../services/BinanceService.js';
import { EventEmitter } from 'events';

class MarketAgent extends EventEmitter {
  constructor() {
    super();
    this.livePrice = null;
    this.lastPriceTimestamp = 0;
    this.isWatching = false;
    this.currentSymbol = null;
  }

  async startWatching(symbol) {
    if (this.isWatching && this.currentSymbol === symbol) return;
    this.currentSymbol = symbol;
    this.isWatching = true;
    this.livePrice = null; // Reset price for new symbol
    this.lastPriceTimestamp = 0;
    console.log(`📡 MarketAgent: Starting WebSocket stream for ${symbol}...`);
    
    // Run continuous background loop
    (async () => {
      while (this.isWatching && this.currentSymbol === symbol) {
        try {
          const trades = await binanceService.proExchange.watchTrades(symbol);
          if (this.currentSymbol !== symbol) return; // Drop stale tick if symbol changed while waiting
          if (!trades || trades.length === 0) continue;
          this.livePrice = trades[trades.length - 1].price;
          this.lastPriceTimestamp = Date.now();
          this.emit('price_tick', this.livePrice);
        } catch (err) {
          console.error(`❌ MarketAgent WebSocket Error:`, err.message);
          // Wait a bit before retrying on error
          await new Promise(res => setTimeout(res, 5000));
        }
      }
    })();
  }

  stopWatching() {
    this.isWatching = false;
  }

  async getCurrentPrice(symbol) {
    // If not watching yet, or symbol changed, start it.
    if (!this.isWatching || this.currentSymbol !== symbol) {
      this.startWatching(symbol);
    }
    
    const now = Date.now();
    // Return cached price ONLY if fresh (less than 15 seconds old)
    if (this.livePrice !== null && (now - this.lastPriceTimestamp < 15000)) {
      return this.livePrice;
    }
    
    // Fallback to REST for initial fetch or if WebSocket is silent/stale > 15s
    try {
      const ticker = await binanceService.exchange.fetchTicker(symbol);
      this.livePrice = ticker.last;
      this.lastPriceTimestamp = now;
      return ticker.last;
    } catch (err) {
      console.error(`❌ MarketAgent REST Error: Failed to fetch price for ${symbol}:`, err.message);
      return this.livePrice; // Stale fallback as last resort
    }
  }

  // Round 6: Calculate ATR with 60-second caching to avoid unnecessary API calls
  async getLiveATR(symbol, timeframe = '5m', period = 14) {
    const now = Date.now();
    // Return cached value if less than 60 seconds old and same symbol
    if (this._cachedATR && this._atrSymbol === symbol && (now - this._atrLastFetched) < 60000) {
      return this._cachedATR;
    }

    try {
      const ohlcv = await binanceService.exchange.fetchOHLCV(symbol, timeframe, undefined, period + 5);
      if (!ohlcv || ohlcv.length < period) return null;

      let trValues = [];
      for (let i = 1; i < ohlcv.length; i++) {
        const high = ohlcv[i][2];
        const low = ohlcv[i][3];
        const prevClose = ohlcv[i - 1][4];
        const tr = Math.max(
          high - low,
          Math.abs(high - prevClose),
          Math.abs(low - prevClose)
        );
        trValues.push(tr);
      }

      const atr = trValues.slice(-period).reduce((a, b) => a + b, 0) / period;

      // Cache the result
      this._cachedATR = atr;
      this._atrSymbol = symbol;
      this._atrLastFetched = now;

      return atr;
    } catch (err) {
      console.error(`⚠️ Failed to compute ATR for ${symbol}:`, err.message);
      return this._cachedATR || null; // Return stale cache on error, or null
    }
  }
}

export default new MarketAgent();
