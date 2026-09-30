import ccxt from 'ccxt';
import dotenv from 'dotenv';
dotenv.config();

class BinanceService {
  constructor() {
    const config = {
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_API_SECRET,
      enableRateLimit: true,
      timeout: 15000,
      has: {
        fetchCurrencies: false,
      },
      options: {
        defaultType: 'future', // Use USDⓈ-M Futures
        fetchMarkets: ['linear'], // Strictly linear futures, avoids unauthorized spot sapi calls
      },
    };
    this.exchange = new ccxt.binance(config);
    this.proExchange = new ccxt.pro.binance(config);
    this._lastFetchPosError = 0;
    this._lastFetchOrdersError = 0;
    this._lastBalanceError = 0;
    this._lastMarginLeverageError = 0;
  }

  toRawSymbol(symbol) {
    if (!symbol || typeof symbol !== 'string') return '';
    let raw = symbol
      .trim()
      .replace(/[/:]/g, '')
      .replace(/(USDT|BUSD|USDC)\1$/i, '$1')
      .toUpperCase();
    if (raw && !raw.endsWith('USDT') && !raw.endsWith('BUSD') && !raw.endsWith('USDC')) {
      raw = raw + 'USDT';
    }
    return raw;
  }

  toUnifiedSymbol(symbol) {
    if (!symbol || typeof symbol !== 'string') return '';
    const raw = this.toRawSymbol(symbol);
    
    if (this.exchange.markets) {
      if (this.exchange.markets[raw]?.symbol) {
        return this.exchange.markets[raw].symbol;
      }
      if (this.exchange.markets_by_id && Array.isArray(this.exchange.markets_by_id[raw]) && this.exchange.markets_by_id[raw][0]?.symbol) {
        return this.exchange.markets_by_id[raw][0].symbol;
      }
      const match = Object.values(this.exchange.markets).find(m => m?.id === raw);
      if (match?.symbol) return match.symbol;
    }
    
    // Standard USD-M futures unified format
    if (raw.endsWith('USDT')) {
      const base = raw.replace(/USDT$/, '');
      return `${base}/USDT:USDT`;
    }
    return symbol;
  }

  async ensureMarketsLoaded() {
    if (!this.exchange.markets || Object.keys(this.exchange.markets).length === 0) {
      try {
        await this.exchange.loadMarkets();
        if (this.proExchange && (!this.proExchange.markets || Object.keys(this.proExchange.markets).length === 0)) {
          this.proExchange.markets = this.exchange.markets;
          this.proExchange.markets_by_id = this.exchange.markets_by_id;
          this.proExchange.symbols = this.exchange.symbols;
          this.proExchange.ids = this.exchange.ids;
        }
      } catch (loadErr) {
        console.warn(`⚠️ Lazy loadMarkets warning:`, loadErr.message);
      }
    }
  }

  async initializeHedgeMode() {
    try {
      await this.exchange.loadMarkets();
      console.log('✅ Exchange Markets Loaded (Precision Data OK)');
      
      const response = await this.exchange.fapiPrivateGetPositionSideDual();
      const isHedgeMode = Boolean(response?.dualSidePosition === true || response?.dualSidePosition === 'true');
      
      if (!isHedgeMode) {
        console.log('Switching account to Hedge Mode (Dual-Side Position)...');
        await this.exchange.fapiPrivatePostPositionSideDual({ dualSidePosition: 'true' });
        console.log('✅ Successfully enabled Hedge Mode.');
      } else {
        console.log('✅ Account is already in Hedge Mode.');
      }
    } catch (err) {
      if (err.message && (err.message.includes('-4059') || err.message.includes('No need to change'))) {
        console.log('✅ Account is already in Hedge Mode.');
      } else {
        console.error('❌ Error configuring Hedge Mode:', err.message);
        throw err;
      }
    }
  }

  async placeHedgeOrder(symbol, side, positionSide, quantityRaw, type = 'MARKET', priceRaw = null) {
    try {
      const params = { positionSide }; // 'LONG' or 'SHORT'
      await this.ensureMarketsLoaded();

      const unifiedSymbol = this.toUnifiedSymbol(symbol);
      const rawSymbol = this.toRawSymbol(symbol);
      const targetSymbol = this.exchange.markets[unifiedSymbol] 
        ? unifiedSymbol 
        : (this.exchange.markets[rawSymbol] ? rawSymbol : symbol);

      // Format dynamically using Binance's strict precision rules
      let quantity = this.exchange.amountToPrecision(targetSymbol, quantityRaw);
      if (!quantity || parseFloat(quantity) <= 0) {
        throw new Error(`Invalid order quantity (${quantityRaw} rounded to ${quantity}) for ${targetSymbol}`);
      }

      const market = this.exchange.markets ? this.exchange.markets[targetSymbol] : null;
      if (market?.limits?.amount?.min && parseFloat(quantity) < market.limits.amount.min) {
        throw new Error(`Order quantity ${quantity} is below exchange minimum of ${market.limits.amount.min} for ${targetSymbol}`);
      }

      // Check minCost / minNotional filter (Binance USD-M requires at least 5.0 USDT notional value)
      const minCost = market?.limits?.cost?.min || 5.0;
      const refPrice = (priceRaw && parseFloat(priceRaw) > 0) 
        ? parseFloat(priceRaw) 
        : (market?.last || (market?.info?.lastPrice ? parseFloat(market.info.lastPrice) : 0));
      if (refPrice > 0) {
        const notional = parseFloat(quantity) * refPrice;
        if (notional < minCost) {
          const neededQtyRaw = (minCost * 1.02) / refPrice;
          const adjustedQty = this.exchange.amountToPrecision(targetSymbol, neededQtyRaw);
          if (parseFloat(adjustedQty) > parseFloat(quantity)) {
            quantity = adjustedQty;
          }
        }
      }
      
      let order;
      if (type.toUpperCase() === 'MARKET') {
        order = await this.exchange.createOrder(targetSymbol, 'market', side.toLowerCase(), quantity, undefined, params);
      } else if (type.toUpperCase() === 'LIMIT') {
        if (!priceRaw || parseFloat(priceRaw) <= 0) {
          throw new Error(`Invalid limit price (${priceRaw}) for ${targetSymbol}`);
        }
        const price = this.exchange.priceToPrecision(targetSymbol, priceRaw);
        order = await this.exchange.createOrder(targetSymbol, 'limit', side.toLowerCase(), quantity, price, params);
      }
      return order;
    } catch (err) {
      console.error(`❌ Failed to place ${positionSide} ${side} order on ${symbol}:`, err.message);
      throw err;
    }
  }
  
  async getBalance() {
    try {
      const balance = await this.exchange.fetchBalance();
      return parseFloat(balance?.USDT?.free || 0);
    } catch (err) {
      const now = Date.now();
      if (!this._lastBalanceError || now - this._lastBalanceError > 60000) {
        console.error('❌ Failed to fetch free balance:', err.message);
        this._lastBalanceError = now;
      }
      throw err;
    }
  }

  async getTotalWalletBalance() {
    try {
      const balance = await this.exchange.fetchBalance();
      return parseFloat(balance.info?.totalWalletBalance || balance?.USDT?.total || 0);
    } catch (err) {
      const now = Date.now();
      if (!this._lastBalanceError || now - this._lastBalanceError > 60000) {
        console.error('❌ Failed to fetch total wallet balance:', err.message);
        this._lastBalanceError = now;
      }
      throw err;
    }
  }

  async fetchOpenPositions(symbol) {
    try {
      await this.ensureMarketsLoaded();
      const rawSymbol = this.toRawSymbol(symbol);
      const unifiedSymbol = this.toUnifiedSymbol(symbol);
      
      let positions = [];
      try {
        positions = await this.exchange.fetchPositions([unifiedSymbol]);
      } catch (_) {
        positions = await this.exchange.fetchPositions();
      }

      if (!Array.isArray(positions)) return [];

      return positions.filter(p => {
        const pRaw = this.toRawSymbol(p.symbol || p.info?.symbol || p.id);
        const matchesSymbol = pRaw === rawSymbol || p.symbol === unifiedSymbol;
        const contracts = Math.abs(parseFloat(p.contracts ?? p.info?.positionAmt ?? 0));
        return matchesSymbol && contracts > 0;
      });
    } catch (err) {
      const now = Date.now();
      if (!this._lastFetchPosError || now - this._lastFetchPosError > 60000) {
        console.error(`❌ Failed to fetch open positions for ${symbol}:`, err.message);
        this._lastFetchPosError = now;
      }
      throw err;
    }
  }

  async fetchOpenOrders(symbol) {
    try {
      await this.ensureMarketsLoaded();
      const unifiedSymbol = this.toUnifiedSymbol(symbol);
      const rawSymbol = this.toRawSymbol(symbol);
      const targetSymbol = this.exchange.markets[unifiedSymbol] ? unifiedSymbol : (this.exchange.markets[rawSymbol] ? rawSymbol : symbol);
      let orders = [];
      try {
        orders = await this.exchange.fetchOpenOrders(targetSymbol);
      } catch (orderErr) {
        if (targetSymbol !== unifiedSymbol) {
          orders = await this.exchange.fetchOpenOrders(unifiedSymbol);
        } else {
          throw orderErr;
        }
      }
      return Array.isArray(orders) ? orders : [];
    } catch (err) {
      const now = Date.now();
      if (!this._lastFetchOrdersError || now - this._lastFetchOrdersError > 60000) {
        console.error(`❌ Failed to fetch open orders for ${symbol}:`, err.message);
        this._lastFetchOrdersError = now;
      }
      return []; // Return empty array on error so caller can proceed safely
    }
  }

  async cancelAllOrders(symbol) {
    try {
      await this.ensureMarketsLoaded();
      const unifiedSymbol = this.toUnifiedSymbol(symbol);
      const rawSymbol = this.toRawSymbol(symbol);
      const targetSymbol = this.exchange.markets[unifiedSymbol] ? unifiedSymbol : (this.exchange.markets[rawSymbol] ? rawSymbol : symbol);
      try {
        await this.exchange.cancelAllOrders(targetSymbol);
        console.log(`✅ Cancelled all open limit orders for ${symbol}`);
      } catch (err) {
        if (err.message && err.message.includes('-2011')) return;
        // Fallback: fetch open orders and cancel individually
        const openOrders = await this.fetchOpenOrders(symbol);
        if (openOrders.length > 0) {
          await Promise.allSettled(openOrders.map(o => this.exchange.cancelOrder(o.id, o.symbol || targetSymbol)));
          console.log(`✅ Cancelled ${openOrders.length} orders individually for ${symbol}`);
        }
      }
    } catch (err) {
      // Ignore if no open orders to cancel (-2011)
      if (err.message && err.message.includes('-2011')) {
        return;
      }
      console.error(`❌ Failed to cancel orders for ${symbol}:`, err.message);
      throw err;
    }
  }

  async cancelOrdersBySide(symbol, positionSide) {
    try {
      const openOrders = await this.fetchOpenOrders(symbol);
      const matchingOrders = openOrders.filter(o => {
        if (!o.info) return false;
        if (positionSide === 'BOTH') return true;
        return o.info.positionSide === positionSide;
      });
      if (matchingOrders.length === 0) return;

      const unifiedSymbol = this.toUnifiedSymbol(symbol);
      const rawSymbol = this.toRawSymbol(symbol);
      const targetSymbol = this.exchange.markets[unifiedSymbol] ? unifiedSymbol : rawSymbol;

      await Promise.allSettled(
        matchingOrders.map(async (order) => {
          try {
            await this.exchange.cancelOrder(order.id, order.symbol || targetSymbol);
            console.log(`✅ Cleaned up old ${positionSide} limit order (${order.id})`);
          } catch (cancelErr) {
            if (!cancelErr.message || !cancelErr.message.includes('-2011')) {
              console.warn(`⚠️ Warning cancelling ${positionSide} order (${order.id}):`, cancelErr.message);
            }
          }
        })
      );
    } catch (err) {
      console.error(`❌ Failed to cleanup orders for ${positionSide}:`, err.message);
    }
  }

  async setMarginMode(symbol) {
    try {
      const rawSymbol = this.toRawSymbol(symbol);
      await this.exchange.fapiPrivatePostMarginType({
        symbol: rawSymbol,
        marginType: 'CROSSED'
      });
      console.log(`✅ Margin mode strictly set to CROSSED for ${symbol}`);
    } catch (err) {
      // Binance throws -4046 if already set to CROSSED, -4059 if positions are open
      if (!err.message || (!err.message.includes('-4046') && !err.message.includes('-4059'))) {
        const now = Date.now();
        if (now - this._lastMarginLeverageError > 60000) {
          console.error(`❌ Failed to set CROSSED margin:`, err.message);
          this._lastMarginLeverageError = now;
        }
        throw err;
      }
    }
  }

  async setLeverage(symbol, leverage) {
    try {
      const rawSymbol = this.toRawSymbol(symbol);
      await this.setMarginMode(symbol);
      
      await this.exchange.fapiPrivatePostLeverage({
        symbol: rawSymbol,
        leverage: leverage
      });
      console.log(`✅ Leverage strictly set to ${leverage}x for ${symbol}`);
    } catch (err) {
      // Ignore if already set (-4028)
      if (!err.message || !err.message.includes('-4028')) {
        const now = Date.now();
        if (now - this._lastMarginLeverageError > 60000) {
          console.error(`❌ Failed to set leverage to ${leverage}:`, err.message);
          this._lastMarginLeverageError = now;
        }
        throw err;
      }
    }
  }
}

export default new BinanceService();
