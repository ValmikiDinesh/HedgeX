import binanceService from '../services/BinanceService.js';
import BotSettings from '../models/BotSettings.js';
import HedgePosition from '../models/HedgePosition.js';
import TradeHistory from '../models/TradeHistory.js';

class RiskManager {
  constructor() {
    this._lastRiskErrorLog = 0;
  }

  async checkMarginSafety(symbol) {
    try {
      const balanceObj = await binanceService.exchange.fetchBalance();
      const marginInfo = balanceObj?.info || {};
      
      const totalMarginBalance = parseFloat(marginInfo.totalMarginBalance ?? balanceObj?.USDT?.total ?? 0);
      const totalMaintMargin = parseFloat(marginInfo.totalMaintMargin ?? 0);
      
      if (isNaN(totalMarginBalance) || isNaN(totalMaintMargin)) {
        console.warn('⚠️ Could not determine margin balance. Temporarily pausing trading for this tick.');
        return 'PAUSE'; // Pause tick without triggering destructive panic close
      }
      
      let marginRatio = 0;
      if (totalMarginBalance > 0) {
        marginRatio = (totalMaintMargin / totalMarginBalance) * 100;
      } else if (totalMaintMargin > 0) {
        marginRatio = 100.0;
      } else {
        marginRatio = 0;
      }
      
      if (marginRatio > 80.0) {
        console.warn(`🚨 DANGER: Margin Ratio exceeded 80% (${marginRatio.toFixed(2)}%)! Hitting Panic Button!`);
        
        // TRIGGER GLOBAL KILLSWITCH IMMEDIATELY
        try {
          await BotSettings.updateOne({ singletonId: 'default_settings' }, { $set: { tradingEnabled: false } });
          console.warn(`🔒 TRADING ENGINE LOCKED: Flip "Trading Active" switch on Dashboard to resume.`);
        } catch (dbErr) {
          console.error(`❌ Failed to lock trading engine:`, dbErr.message);
        }
        
        // ATTEMPT MARKET CLOSE
        try {
          await this.panicCloseAll(symbol);
        } catch (panicErr) {
          console.error(`❌ Panic Close sequence aborted midway:`, panicErr.message);
        }
        
        return 'PANIC';
      }
      
      if (marginRatio > 60.0) {
        console.warn(`⚠️ WARNING: Margin Ratio at ${marginRatio.toFixed(2)}%. Entering Capital Preservation Mode.`);
        return 'WARNING';
      }

      return 'SAFE';
    } catch (err) {
      const now = Date.now();
      if (now - this._lastRiskErrorLog > 60000) {
        console.error('❌ RiskManager Balance Check Error:', err.message);
        this._lastRiskErrorLog = now;
      }
      return 'PAUSE'; // Pause trading safely on transient API errors without wiping positions
    }
  }

  async panicCloseAll(symbol) {
    console.log(`🚨 PANIC BUTTON ACTIVATED FOR ${symbol} 🚨`);
    
    // 1. Cancel all open limit orders
    try {
      await binanceService.cancelAllOrders(symbol);
    } catch (err) {
      console.error(`❌ Failed to cancel orders during panic, proceeding to market close:`, err.message);
    }
    
    // 2. Fetch all open positions
    let positions = [];
    try {
      positions = await binanceService.fetchOpenPositions(symbol);
    } catch (err) {
      console.error(`❌ Failed to fetch open positions during panic:`, err.message);
    }
    
    // 3. Market close each position
    for (const pos of positions) {
      const contracts = Math.abs(parseFloat(pos.contracts ?? pos.info?.positionAmt ?? 0));
      if (!contracts || contracts <= 0) continue;

      const posAmt = parseFloat(pos.info?.positionAmt ?? pos.contracts ?? 0);
      const rawSide = (pos.info?.positionSide || (pos.side ? pos.side.toUpperCase() : '')).toUpperCase();
      const isLong = rawSide === 'LONG' || (rawSide === 'BOTH' && posAmt > 0) || (pos.side === 'long') || (!rawSide && posAmt > 0);
      const sideToClose = isLong ? 'SELL' : 'BUY';
      const positionSide = (rawSide === 'BOTH') ? 'BOTH' : (isLong ? 'LONG' : 'SHORT');
      
      console.log(`🚨 Emergency Closing ${isLong ? 'LONG' : 'SHORT'} position (${contracts} contracts)...`);
      try {
        const closeOrder = await binanceService.placeHedgeOrder(
          symbol, 
          sideToClose, 
          positionSide, 
          contracts, 
          'MARKET'
        );
        
        const entryPrice = parseFloat(pos.info?.entryPrice || pos.entryPrice || 0);
        let currentPrice = parseFloat(closeOrder?.average || closeOrder?.price || 0);
        if (!currentPrice || currentPrice <= 0) {
          try {
            const ticker = await binanceService.exchange.fetchTicker(binanceService.toUnifiedSymbol(symbol));
            currentPrice = ticker?.last || entryPrice;
          } catch (_) {
            currentPrice = entryPrice;
          }
        }
        
        const grossPnl = isLong 
          ? (currentPrice - entryPrice) * contracts 
          : (entryPrice - currentPrice) * contracts;
        const fees = (entryPrice > 0 && contracts > 0) 
          ? (contracts * entryPrice * 0.0005) + (contracts * currentPrice * 0.0005) 
          : 0; 
        const netPnl = grossPnl - fees;

        if (entryPrice > 0 && contracts > 0) {
          const historyRecord = new TradeHistory({
            symbol: symbol,
            side: isLong ? 'LONG' : 'SHORT',
            entryPrice: entryPrice,
            exitPrice: currentPrice,
            quantity: contracts,
            grossPnl: isFinite(grossPnl) ? grossPnl : 0,
            fees: isFinite(fees) ? fees : 0,
            netPnl: isFinite(netPnl) ? netPnl : 0
          });
          await historyRecord.save();
        }
        
        console.log(`✅ Emergency closed ${isLong ? 'LONG' : 'SHORT'} successfully.`);
      } catch (err) {
        console.error(`❌ Failed to emergency close ${isLong ? 'LONG' : 'SHORT'}:`, err.message);
      }
    }
    
    // 4. Mark DB active positions as closed
    try {
      const rawSym = binanceService.toRawSymbol(symbol);
      const unifiedSym = binanceService.toUnifiedSymbol(symbol);
      await HedgePosition.updateMany(
        { symbol: { $in: [symbol, rawSym, unifiedSym] }, status: 'active' },
        { 
          $set: { 
            status: 'closed',
            'longLeg.status': 'closed',
            'shortLeg.status': 'closed'
          } 
        }
      );
    } catch (dbErr) {
      console.error(`❌ Failed to update DB state during panic:`, dbErr.message);
    }
    
    console.log(`🚨 Panic Sequence Complete for ${symbol}.`);
  }
}

export default new RiskManager();
