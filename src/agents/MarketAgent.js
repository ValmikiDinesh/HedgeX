import binanceService from '../services/BinanceService.js';
import { EventEmitter } from 'events';

class MarketAgent extends EventEmitter {
  constructor() {
    super();
    this.livePrice = null;
    this.isWatching = false;
    this.currentSymbol = null;
  }

  async startWatching(symbol) {
    if (this.isWatching && this.currentSymbol === symbol) return;
    this.currentSymbol = symbol;
    this.isWatching = true;
    this.livePrice = null; // Reset price for new symbol
    console.log(`📡 MarketAgent: Starting WebSocket stream for ${symbol}...`);
    
    // Run continuous background loop
    (async () => {
      while (this.isWatching && this.currentSymbol === symbol) {
        try {
          const trades = await binanceService.proExchange.watchTrades(symbol);
          if (this.currentSymbol !== symbol) return; // Drop stale tick if symbol changed while waiting
          if (!trades || trades.length === 0) continue;
          this.livePrice = trades[trades.length - 1].price;
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
    
    // If we have a cached price, return it instantly
    if (this.livePrice !== null) {
      return this.livePrice;
    }
    
    // Fallback to REST for the very first fetch if WebSocket hasn't ticked yet
    try {
      const ticker = await binanceService.exchange.fetchTicker(symbol);
      this.livePrice = ticker.last;
      return ticker.last;
    } catch (err) {
      console.error(`❌ MarketAgent REST Error: Failed to fetch price for ${symbol}:`, err.message);
      return null;
    }
  }
}

export default new MarketAgent();
