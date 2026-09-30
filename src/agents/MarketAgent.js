import binanceService from '../services/BinanceService.js';
import { EventEmitter } from 'events';

class MarketAgent extends EventEmitter {
  constructor() {
    super();
    this.livePrice = null;
    this.lastPriceTimestamp = 0;
    this.isWatching = false;
    this.currentSymbol = null;
    this._livePriceSymbol = null;
    this._loopRunning = false;
    this._heartbeatInterval = null;
  }

  async startWatching(symbol) {
    if (!symbol) return;
    const targetSymbol = binanceService.toUnifiedSymbol(symbol);
    if (this.isWatching && this.currentSymbol === targetSymbol && this._loopRunning) return;
    
    if (this.currentSymbol !== targetSymbol) {
      this.livePrice = null;
      this._livePriceSymbol = null;
    }
    this.currentSymbol = targetSymbol;
    this.isWatching = true;
    this.lastPriceTimestamp = 0;
    console.log(`📡 MarketAgent: Starting WebSocket stream for ${targetSymbol}...`);
    
    // Fetch initial price immediately so UI doesn't wait
    this.getCurrentPrice(targetSymbol).catch(() => {});
    
    // Setup fallback heartbeat (if WebSocket quiet for > 12s, poll REST)
    if (!this._heartbeatInterval) {
      this._heartbeatInterval = setInterval(async () => {
        if (this.isWatching && this.currentSymbol) {
          const now = Date.now();
          if (now - this.lastPriceTimestamp > 12000) {
            try {
              const freshPrice = await this.getCurrentPrice(this.currentSymbol, true);
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
              let cancelTimer;
              const timeoutPromise = new Promise(resolve => {
                cancelTimer = setTimeout(() => resolve(null), 5000);
              });
              
              const tickPromise = (binanceService.proExchange && binanceService.proExchange.has && binanceService.proExchange.has['watchTicker'])
                ? binanceService.proExchange.watchTicker(activeSymbol)
                : binanceService.proExchange.watchTrades(activeSymbol);

              const result = await Promise.race([
                tickPromise.catch(() => null),
                timeoutPromise
              ]);
              clearTimeout(cancelTimer);

              if (this.currentSymbol !== activeSymbol) continue; // Drop stale tick if symbol changed
              if (!result) continue;

              let price = 0;
              if (Array.isArray(result) && result.length > 0) {
                price = parseFloat(result[result.length - 1].price);
              } else if (result && typeof result === 'object') {
                price = parseFloat(result.last || result.close || result.info?.lastPrice || result.info?.c || 0);
              }

              if (price && price > 0 && isFinite(price)) {
                this.livePrice = price;
                this._livePriceSymbol = activeSymbol;
                this.lastPriceTimestamp = Date.now();
                this.emit('price_tick', this.livePrice);
              }
            } catch (err) {
              if (this.currentSymbol === activeSymbol) {
                await new Promise(res => setTimeout(res, 3000));
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
    this._livePriceSymbol = null;
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  async getCurrentPrice(symbol, forceRefresh = false) {
    if (!symbol) return this.livePrice;
    const unifiedSymbol = binanceService.toUnifiedSymbol(symbol);
    const rawSymbol = binanceService.toRawSymbol(symbol);

    if (!this.isWatching || this.currentSymbol !== unifiedSymbol) {
      this.startWatching(unifiedSymbol);
    }
    
    const now = Date.now();
    // Return cached price ONLY if fresh (less than 15 seconds old), symbol matches, and not force refreshing
    if (!forceRefresh && this.livePrice !== null && (this._livePriceSymbol === unifiedSymbol || this._livePriceSymbol === rawSymbol) && (now - this.lastPriceTimestamp < 15000)) {
      return this.livePrice;
    }
    
    // Fallback to REST for initial fetch or if WebSocket is silent/stale > 15s
    try {
      await binanceService.ensureMarketsLoaded();
      const targetSymbol = binanceService.exchange.markets[unifiedSymbol] 
        ? unifiedSymbol 
        : (binanceService.exchange.markets[rawSymbol] ? rawSymbol : unifiedSymbol);
      const ticker = await binanceService.exchange.fetchTicker(targetSymbol);
      if (ticker && (ticker.last || ticker.close)) {
        const lastPrice = parseFloat(ticker.last || ticker.close);
        if (lastPrice && lastPrice > 0 && isFinite(lastPrice)) {
          this.livePrice = lastPrice;
          this._livePriceSymbol = unifiedSymbol;
          this.lastPriceTimestamp = now;
          this.emit('price_tick', this.livePrice);
          return lastPrice;
        }
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
      
      let ohlcv;
      try {
        ohlcv = await binanceService.exchange.fetchOHLCV(targetSymbol, timeframe, undefined, period + 5);
      } catch (fetchErr) {
        if (targetSymbol !== unifiedSymbol) {
          ohlcv = await binanceService.exchange.fetchOHLCV(unifiedSymbol, timeframe, undefined, period + 5);
        } else {
          throw fetchErr;
        }
      }
      if (!Array.isArray(ohlcv) || ohlcv.length <= period) return null;

      let trValues = [];
      for (let i = 1; i < ohlcv.length; i++) {
        const high = parseFloat(ohlcv[i][2]);
        const low = parseFloat(ohlcv[i][3]);
        const prevClose = parseFloat(ohlcv[i - 1][4]);
        if (isNaN(high) || isNaN(low) || isNaN(prevClose)) continue;
        
        const tr = Math.max(
          high - low,
          Math.abs(high - prevClose),
          Math.abs(low - prevClose)
        );
        if (isFinite(tr)) trValues.push(tr);
      }

      if (trValues.length < period) return null;

      const sum = trValues.slice(-period).reduce((a, b) => a + b, 0);
      const atr = sum / period;
      if (!isFinite(atr) || atr <= 0) return null;

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
