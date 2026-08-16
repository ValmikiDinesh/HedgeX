import binanceService from '../services/BinanceService.js';
import BotSettings from '../models/BotSettings.js';
import HedgePosition from '../models/HedgePosition.js';
import TradeHistory from '../models/TradeHistory.js';

class RiskManager {
  async checkMarginSafety(symbol) {
    try {
      // Fetch margin info from the standard balance endpoint
      const balanceObj = await binanceService.exchange.fetchBalance();
      const marginInfo = balanceObj.info;
      
      const totalMarginBalance = parseFloat(marginInfo.totalMarginBalance);
      const totalMaintMargin = parseFloat(marginInfo.totalMaintMargin);
      
      if (isNaN(totalMarginBalance) || isNaN(totalMaintMargin)) {
        console.warn('⚠️ Could not determine margin balance. Safely pausing trading.');
        return false; // Safely abort if API fails to return margin info
      }
      
      const marginRatio = totalMarginBalance > 0 ? (totalMaintMargin / totalMarginBalance) * 100 : 0;
      
      console.log(`🛡️ Risk Manager: Current Margin Ratio is ${marginRatio.toFixed(2)}%`);
      
      if (marginRatio > 80.0) {
        console.warn(`🚨 DANGER: Margin Ratio exceeded 80%! Hitting Panic Button!`);
        
        // TRIGGER GLOBAL KILLSWITCH IMMEDIATELY (Do this BEFORE API calls so it never gets bypassed)
        try {
          await BotSettings.updateOne({ singletonId: 'default_settings' }, { $set: { tradingEnabled: false } });
          console.warn(`🔒 TRADING ENGINE LOCKED: Flip "Trading Active" switch on Dashboard to resume.`);
        } catch (dbErr) {
          console.error(`❌ Failed to lock trading engine! FATAL DB ERROR.`, dbErr.message);
        }
        
        // ATTEMPT MARKET CLOSE
        try {
          await this.panicCloseAll(symbol);
        } catch (panicErr) {
          console.error(`❌ Panic Close sequence aborted midway due to unexpected error:`, panicErr.message);
        }
        
        return 'PANIC';
      }
      
      if (marginRatio > 60.0) {
        console.warn(`⚠️ WARNING: Margin Ratio at ${marginRatio.toFixed(2)}%. Entering Capital Preservation Mode.`);
        return 'WARNING';
      }

      return 'SAFE';
    } catch (err) {
      console.error('❌ RiskManager Error:', err.message);
      return 'PANIC'; // Default to PANIC if API fails so we don't accidentally trade blind
    }
  }

  async panicCloseAll(symbol) {
    console.log(`🚨 PANIC BUTTON ACTIVATED FOR ${symbol} 🚨`);
    
    // 1. Cancel all open limit orders
    try {
      await binanceService.cancelAllOrders(symbol);
    } catch (err) {
      console.error(`❌ Failed to cancel orders during panic, proceeding to market close anyway!`, err.message);
    }
    
    // 2. Fetch all open positions (if this fails, we can't market close, but we still update DB)
    let positions = [];
    try {
      positions = await binanceService.fetchOpenPositions(symbol);
    } catch (err) {
      console.error(`❌ Failed to fetch open positions during panic!`, err.message);
    }
    
    // 3. Market close each position
    for (const pos of positions) {
      if (!pos.contracts || Math.abs(parseFloat(pos.contracts)) === 0) continue;

      const isLong = pos.info.positionSide === 'LONG';
      const sideToClose = isLong ? 'SELL' : 'BUY';
      const positionSide = isLong ? 'LONG' : 'SHORT';
      
      console.log(`🚨 Emergency Closing ${positionSide} position...`);
      try {
        await binanceService.placeHedgeOrder(
          symbol, 
          sideToClose, 
          positionSide, 
          Math.abs(pos.contracts), 
          'MARKET'
        );
        
        // Log panic close loss to TradeHistory
        const entryPrice = parseFloat(pos.info.entryPrice);
        const qty = Math.abs(parseFloat(pos.contracts));
        const unRealizedPnl = parseFloat(pos.info.unRealizedProfit || 0);
        // Estimate fees: Taker on entry + Taker on exit (roughly 0.10% total)
        const fees = qty * entryPrice * 0.001; 
        const netPnl = unRealizedPnl - fees;
        
        // Fetch current price for exit price estimation
        const ticker = await binanceService.exchange.fetchTicker(symbol);
        const currentPrice = ticker.last || entryPrice;

        const historyRecord = new TradeHistory({
          symbol: symbol,
          side: positionSide,
          entryPrice: entryPrice,
          exitPrice: currentPrice,
          quantity: qty,
          grossPnl: unRealizedPnl,
          fees: fees,
          netPnl: netPnl
        });
        await historyRecord.save();
        
        console.log(`✅ Emergency closed ${positionSide} successfully.`);
      } catch (err) {
        console.error(`❌ Failed to emergency close ${positionSide}:`, err.message);
      }
    }
    
    // 3. Mark DB as closed so Strategy Agent doesn't mistakenly log phantom profits
    try {
      await HedgePosition.updateMany(
        { symbol: symbol, status: 'active' },
        { $set: { status: 'closed' } }
      );
    } catch (dbErr) {
      console.error(`❌ Failed to update DB state during panic:`, dbErr.message);
      throw new Error(`Panic DB Update Failed: ${dbErr.message}`);
    }
    
    console.log(`🚨 Panic Sequence Complete. Account is flat.`);
  }
}

export default new RiskManager();
