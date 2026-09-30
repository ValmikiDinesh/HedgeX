import binanceService from '../services/BinanceService.js';
import { EventEmitter } from 'events';

class MarketAgent extends EventEmitter {
  constructor() {
    super();
    this.livePrice = null;
    this.lastPriceTimestamp = 0;
    this.isWatching = false;
    this.currentSymbol = null;
    this._loopRunning = false;
  }

  async startWatching(symbol) {
    if (!symbol) return;
    const targetSymbol = binanceService.toUnifiedSymbol(symbol);
    if (this.isWatching && this.currentSymbol === targetSymbol && this._loopRunning) return;
    
    this.currentSymbol = targetSymbol;
    this.isWatching = true;
    this.livePrice = null; // Reset price for new symbol
    this.lastPriceTimestamp = 0;
    console.log(`📡 MarketAgent: Starting WebSocket stream for ${targetSymbol}...`);
    
    // Run continuous background loop with loop safety guard
    if (!this._loopRunning) {
      this._loopRunning = true;
      (async () => {
        try {
          while (this.isWatching && this.currentSymbol) {
            const activeSymbol = this.currentSymbol;
            try {
              const trades = await binanceService.proExchange.watchTrades(activeSymbol);
              if (this.currentSymbol !== activeSymbol) continue; // Drop stale tick if symbol changed while waiting
              if (!trades || trades.length === 0) continue;
              this.livePrice = trades[trades.length - 1].price;
              this.lastPriceTimestamp = Date.now();
              this.emit('price_tick', this.livePrice);
            } catch (err) {
              if (this.currentSymbol === activeSymbol) {
                console.error(`❌ MarketAgent WebSocket Error for ${activeSymbol}:`, err.message);
                // Wait a bit before retrying on error
                await new Promise(res => setTimeout(res, 5000));
              }
            }
          }
        } finally {
          this._loopRunning = false;
        }
      })();
    }
  }

  stopWatching() {
    this.isWatching = false;
    this.currentSymbol = null;
  }

  async getCurrentPrice(symbol) {
    if (!symbol) return this.livePrice;
    const unifiedSymbol = binanceService.toUnifiedSymbol(symbol);
    const rawSymbol = binanceService.toRawSymbol(symbol);

    // If not watching yet, or symbol changed, start it.
    if (!this.isWatching || this.currentSymbol !== unifiedSymbol) {
      this.startWatching(unifiedSymbol);
    }
    
    const now = Date.now();
    // Return cached price ONLY if fresh (less than 15 seconds old)
    if (this.livePrice !== null && (now - this.lastPriceTimestamp < 15000)) {
      return this.livePrice;
    }
    
    // Fallback to REST for initial fetch or if WebSocket is silent/stale > 15s
    try {
      await binanceService.ensureMarketsLoaded();
      const targetSymbol = binanceService.exchange.markets[unifiedSymbol] ? unifiedSymbol : rawSymbol;
      const ticker = await binanceService.exchange.fetchTicker(targetSymbol);
      if (ticker && ticker.last) {
        this.livePrice = ticker.last;
        this.lastPriceTimestamp = now;
        this.emit('price_tick', this.livePrice);
        return ticker.last;
      }
      return this.livePrice;
    } catch (err) {
      console.error(`❌ MarketAgent REST Error: Failed to fetch price for ${symbol}:`, err.message);
      return this.livePrice; // Stale fallback as last resort
    }
  }

  // Round 6: Calculate ATR with 60-second caching to avoid unnecessary API calls
  async getLiveATR(symbol, timeframe = '5m', period = 14) {
    if (!symbol) return null;
    const now = Date.now();
    const rawSymbol = binanceService.toRawSymbol(symbol);
    // Return cached value if less than 60 seconds old and same symbol
    if (this._cachedATR && this._atrSymbol === rawSymbol && (now - this._atrLastFetched) < 60000) {
      return this._cachedATR;
    }

    try {
      await binanceService.ensureMarketsLoaded();
      const unifiedSymbol = binanceService.toUnifiedSymbol(symbol);
      const targetSymbol = binanceService.exchange.markets[unifiedSymbol] ? unifiedSymbol : rawSymbol;
      const ohlcv = await binanceService.exchange.fetchOHLCV(targetSymbol, timeframe, undefined, period + 5);
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
      this._atrSymbol = rawSymbol;
      this._atrLastFetched = now;

      return atr;
    } catch (err) {
      console.error(`⚠️ Failed to compute ATR for ${symbol}:`, err.message);
      return this._cachedATR || null; // Return stale cache on error, or null
    }
  }
}

export default new MarketAgent();
