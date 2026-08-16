import ccxt from 'ccxt';
import dotenv from 'dotenv';
dotenv.config();

class BinanceService {
  constructor() {
    const config = {
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_API_SECRET,
      enableRateLimit: true,
      options: {
        defaultType: 'future', // Use USDⓈ-M Futures
      },
    };
    this.exchange = new ccxt.binance(config);
    this.proExchange = new ccxt.pro.binance(config);
  }

  async initializeHedgeMode() {
    try {
      // Load markets to get precision rules for coins
      await this.exchange.loadMarkets();
      console.log('✅ Exchange Markets Loaded (Precision Data OK)');
      
      // Check current position mode
      const response = await this.exchange.fapiPrivateGetPositionSideDual();
      const isHedgeMode = response.dualSidePosition;
      
      if (!isHedgeMode) {
        console.log('Switching account to Hedge Mode (Dual-Side Position)...');
        await this.exchange.fapiPrivatePostPositionSideDual({ dualSidePosition: 'true' });
        console.log('✅ Successfully enabled Hedge Mode.');
      } else {
        console.log('✅ Account is already in Hedge Mode.');
      }
    } catch (err) {
      // Binance throws an error if we try to change it while positions are open
      if (err.message.includes('-4059')) {
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
      
      // Format dynamically using Binance's strict precision rules
      const quantity = this.exchange.amountToPrecision(symbol, quantityRaw);
      
      let order;
      if (type.toUpperCase() === 'MARKET') {
        order = await this.exchange.createOrder(symbol, 'market', side, quantity, undefined, params);
      } else if (type.toUpperCase() === 'LIMIT' && priceRaw) {
        const price = this.exchange.priceToPrecision(symbol, priceRaw);
        order = await this.exchange.createOrder(symbol, 'limit', side, quantity, price, params);
      }
      return order;
    } catch (err) {
      console.error(`❌ Failed to place ${positionSide} order:`, err.message);
      throw err;
    }
  }
  
  async getBalance() {
    try {
      const balance = await this.exchange.fetchBalance();
      return balance?.USDT?.free || 0;
    } catch (err) {
      console.error('❌ Failed to fetch free balance:', err.message);
      throw err;
    }
  }

  async getTotalWalletBalance() {
    try {
      const balance = await this.exchange.fetchBalance();
      return parseFloat(balance.info.totalWalletBalance) || 0;
    } catch (err) {
      console.error('❌ Failed to fetch total wallet balance:', err.message);
      throw err;
    }
  }

  async fetchOpenPositions(symbol) {
    try {
      const positions = await this.exchange.fetchPositions([symbol]);
      return positions.filter(p => p.contracts > 0); // Only return active positions
    } catch (err) {
      console.error(`❌ Failed to fetch open positions for ${symbol}:`, err.message);
      throw err;
    }
  }

  async fetchOpenOrders(symbol) {
    try {
      return await this.exchange.fetchOpenOrders(symbol);
    } catch (err) {
      console.error(`❌ Failed to fetch open orders for ${symbol}:`, err.message);
      throw err;
    }
  }

  async cancelAllOrders(symbol) {
    try {
      await this.exchange.cancelAllOrders(symbol);
      console.log(`✅ Cancelled all open limit orders for ${symbol}`);
    } catch (err) {
      console.error(`❌ Failed to cancel orders for ${symbol}:`, err.message);
      throw err;
    }
  }

  async cancelOrdersBySide(symbol, positionSide) {
    try {
      // positionSide must be 'LONG' or 'SHORT'
      const openOrders = await this.exchange.fetchOpenOrders(symbol);
      for (const order of openOrders) {
        if (order.info && order.info.positionSide === positionSide) {
          await this.exchange.cancelOrder(order.id, symbol);
          console.log(`✅ Cleaned up old ${positionSide} limit order (${order.id})`);
        }
      }
    } catch (err) {
      console.error(`❌ Failed to cleanup orders for ${positionSide}:`, err.message);
    }
  }

  async setMarginMode(symbol) {
    try {
      await this.exchange.fapiPrivatePostMarginType({
        symbol: symbol.replace('/', ''),
        marginType: 'CROSSED'
      });
      console.log(`✅ Margin mode strictly set to CROSSED for ${symbol}`);
    } catch (err) {
      // Binance throws -4046 if it's already set to CROSSED
      if (!err.message.includes('-4046')) {
        console.error(`❌ Failed to set CROSSED margin:`, err.message);
        throw err;
      }
    }
  }

  async setLeverage(symbol, leverage) {
    try {
      // 1. Force Cross Margin FIRST
      await this.setMarginMode(symbol);
      
      // 2. Set Leverage
      await this.exchange.fapiPrivatePostLeverage({
        symbol: symbol.replace('/', ''), // Ensure format like DOGEUSDT
        leverage: leverage
      });
      console.log(`✅ Leverage strictly set to ${leverage}x for ${symbol}`);
    } catch (err) {
      // Ignore if it's already set (-4028)
      if (!err.message.includes('-4028')) {
        console.error(`❌ Failed to set leverage to ${leverage}:`, err.message);
        throw err;
      }
    }
  }
}

export default new BinanceService();
