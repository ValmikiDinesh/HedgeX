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
    this._heartbeatInterval = null;
  }

  async startWatching(symbol) {
    if (!symbol) return;
    const targetSymbol = binanceService.toUnifiedSymbol(symbol);
    if (this.isWatching && this.currentSymbol === targetSymbol && this._loopRunning) return;
    
    if (this.currentSymbol !== targetSymbol) {
      this.livePrice = null;
    }
    this.currentSymbol = targetSymbol;
    this.isWatching = true;
    this.lastPriceTimestamp = 0;
    console.log(`📡 MarketAgent: Starting WebSocket stream for ${targetSymbol}...`);
    
    // Fetch initial price immediately so UI doesn't wait
    this.getCurrentPrice(targetSymbol).catch(() => {});
    
    // Setup fallback heartbeat (if WebSocket quiet for > 20s, poll REST)
    if (!this._heartbeatInterval) {
      this._heartbeatInterval = setInterval(async () => {
        if (this.isWatching && this.currentSymbol) {
          const now = Date.now();
          if (now - this.lastPriceTimestamp > 20000) {
            try {
              const freshPrice = await this.getCurrentPrice(this.currentSymbol);
              if (freshPrice && freshPrice > 0) {
                this.emit('price_tick', freshPrice);
              }
            } catch (_) {}
          }
        }
      }, 10000);
    }

    // Run continuous background WebSocket loop
    if (!this._loopRunning) {
      this._loopRunning = true;
      (async () => {
        try {
          while (this.isWatching && this.currentSymbol) {
            const activeSymbol = this.currentSymbol;
            try {
              const trades = await binanceService.proExchange.watchTrades(activeSymbol);
              if (this.currentSymbol !== activeSymbol) continue; // Drop stale tick if symbol changed
              if (!trades || trades.length === 0) continue;
              this.livePrice = trades[trades.length - 1].price;
              this.lastPriceTimestamp = Date.now();
              this.emit('price_tick', this.livePrice);
            } catch (err) {
              if (this.currentSymbol === activeSymbol) {
                // If CCXT pro fails, wait 5s before retrying
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
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  async getCurrentPrice(symbol) {
    if (!symbol) return this.livePrice;
    const unifiedSymbol = binanceService.toUnifiedSymbol(symbol);
    const rawSymbol = binanceService.toRawSymbol(symbol);

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
      const targetSymbol = binanceService.exchange.markets[unifiedSymbol] 
        ? unifiedSymbol 
        : (binanceService.exchange.markets[rawSymbol] ? rawSymbol : unifiedSymbol);
      const ticker = await binanceService.exchange.fetchTicker(targetSymbol);
      if (ticker && ticker.last) {
        this.livePrice = ticker.last;
        this.lastPriceTimestamp = now;
        this.emit('price_tick', this.livePrice);
        return ticker.last;
      }
      return this.livePrice;
    } catch (err) {
      return this.livePrice;
    }
  }

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
      const targetSymbol = binanceService.exchange.markets[unifiedSymbol] 
        ? unifiedSymbol 
        : (binanceService.exchange.markets[rawSymbol] ? rawSymbol : unifiedSymbol);
      
      const ohlcv = await binanceService.exchange.fetchOHLCV(targetSymbol, timeframe, undefined, period + 5);
      if (!Array.isArray(ohlcv) || ohlcv.length <= period) return null;

      let trValues = [];
      for (let i = 1; i < ohlcv.length; i++) {
        const high = ohlcv[i][2];
        const low = ohlcv[i][3];
        const prevClose = ohlcv[i - 1][4];
        if (high === undefined || low === undefined || prevClose === undefined) continue;
        
        const tr = Math.max(
          high - low,
          Math.abs(high - prevClose),
          Math.abs(low - prevClose)
        );
        trValues.push(tr);
      }

      if (trValues.length < period) return null;

      const atr = trValues.slice(-period).reduce((a, b) => a + b, 0) / period;

      this._cachedATR = atr;
      this._atrSymbol = rawSymbol;
      this._atrLastFetched = now;

      return atr;
    } catch (err) {
      return this._cachedATR || null;
    }
  }
}

export default new MarketAgent();
