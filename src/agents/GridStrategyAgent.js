import binanceService from '../services/BinanceService.js';
import marketAgent from './MarketAgent.js';
import riskManager from './RiskManager.js';
import HedgePosition from '../models/HedgePosition.js';
import BotSettings from '../models/BotSettings.js';
import TradeHistory from '../models/TradeHistory.js';

class GridStrategyAgent {
  constructor() {
    this.isActive = false;
    this.currentSymbol = null; // Track internally to detect symbol changes
    this.currentLeverage = null; // Track internally to detect leverage changes
    this.settings = null;
  }

  async fetchSettings() {
    let settings = await BotSettings.findOne({ singletonId: 'default_settings' });
    if (!settings) {
      settings = new BotSettings();
      await settings.save();
    }
    return settings;
  }

  async runGridLoop() {
    if (this.isActive) return;
    this.isActive = true;
    
    try {
      // 1. Fetch Dynamic Settings
      this.settings = await this.fetchSettings();
      const { symbol, gridPercentage, positionPercentage, tradingEnabled } = this.settings;
      let leverage = this.settings.leverage;

      // 2. Coin Swap is handled dynamically by index.js and DB state. No need to duplicate here.
      
      // Update tracking symbol & leverage independently
      const symbolChanged = this.currentSymbol !== symbol;
      if (symbolChanged) {
        this.currentSymbol = symbol;
      }
      
      if (this.currentLeverage !== leverage || symbolChanged) {
        try {
          await binanceService.setLeverage(symbol, leverage);
          this.currentLeverage = leverage;
        } catch (err) {
          console.error(`❌ Leverage update failed. Reverting DB setting back to known good state (${this.currentLeverage || 1}x) to prevent margin desync!`);
          const fallbackLeverage = this.currentLeverage || 1;
          await BotSettings.updateOne({ singletonId: 'default_settings' }, { $set: { leverage: fallbackLeverage } });
          leverage = fallbackLeverage;
        }
      }

      // 3. Check Margin Safety
      const safetyStatus = await riskManager.checkMarginSafety(symbol);
      if (safetyStatus === 'PANIC') {
        this.isActive = false;
        return;
      }
      const isMarginWarning = (safetyStatus === 'WARNING');

      // 4. Fetch current active positions and orders
      const positions = await binanceService.fetchOpenPositions(symbol);
      let longPos = positions.find(p => p.info.positionSide === 'LONG');
      let shortPos = positions.find(p => p.info.positionSide === 'SHORT');
      
      const currentPrice = await marketAgent.getCurrentPrice(symbol);
      if (!currentPrice) {
        this.isActive = false;
        return;
      }

      // --- DUST SWEEPER (Phase 9) ---
      // Eliminate partial-fill dust ghosts that paralyze the grid with MIN_NOTIONAL spam
      if (longPos && (Math.abs(parseFloat(longPos.contracts)) * currentPrice) < 5.0) {
         console.warn(`🧹 Sweeping LONG Dust Position ($${(Math.abs(parseFloat(longPos.contracts)) * currentPrice).toFixed(2)})...`);
         try {
             await binanceService.placeHedgeOrder(symbol, 'SELL', 'LONG', Math.abs(parseFloat(longPos.contracts)), 'MARKET');
             longPos = null; // Clear from memory to immediately replenish a healthy position
         } catch(e) { console.error('Failed to sweep LONG dust:', e.message); }
      }
      
      if (shortPos && (Math.abs(parseFloat(shortPos.contracts)) * currentPrice) < 5.0) {
         console.warn(`🧹 Sweeping SHORT Dust Position ($${(Math.abs(parseFloat(shortPos.contracts)) * currentPrice).toFixed(2)})...`);
         try {
             await binanceService.placeHedgeOrder(symbol, 'BUY', 'SHORT', Math.abs(parseFloat(shortPos.contracts)), 'MARKET');
             shortPos = null; 
         } catch(e) { console.error('Failed to sweep SHORT dust:', e.message); }
      }
      
      // Calculate Notional Size symmetrically based on TOTAL wallet balance (including locked margin)
      const balance = await binanceService.getTotalWalletBalance();
      const notionalSize = (balance * positionPercentage) * leverage;
      const quantityRaw = notionalSize / currentPrice;
      
      // Binance requires $5.00 min notional. Pad it safely.
      const minNotional = 5.0 / Math.max(0.1, (1 - gridPercentage));
      const canOpenNewPosition = notionalSize >= minNotional && quantityRaw > 0 && balance > 0 && !isMarginWarning;
      if (!canOpenNewPosition) {
        console.warn(`⚠️ Cannot open new positions: Notional size ($${notionalSize.toFixed(2)}) is below padded Binance minimum of $${minNotional.toFixed(2)} or balance is too low.`);
      }

      // Fetch or Create DB Record
      let dbRecord = await HedgePosition.findOne({ symbol: symbol, status: 'active' });
      if (!dbRecord) {
        dbRecord = new HedgePosition({ symbol: symbol });
        await dbRecord.save();
      }

      // Helper function to calculate Net PnL (Deducting 0.07% round-trip exchange fees)
      const calculateNetPnl = (unRealizedPnlStr, entryPrice, qty) => {
        const grossPnl = parseFloat(unRealizedPnlStr || 0);
        // Estimate Maker (0.02%) + Taker (0.05%) = 0.07% total fees on the notional size
        const estimatedFees = (entryPrice * qty) * 0.0007; 
        return grossPnl - estimatedFees;
      };

      // Helper function to log closed trades
      const logClosedTrade = async (side, oldLeg) => {
        if (!oldLeg || oldLeg.status !== 'open') return;
        
        try {
          const entry = oldLeg.entryPrice;
          const exit = oldLeg.takeProfitPrice;
          const qty = oldLeg.quantity;
          
          let grossPnl = 0;
          if (side === 'LONG') {
            grossPnl = (exit - entry) * qty;
          } else {
            grossPnl = (entry - exit) * qty;
          }
          
          const fees = (entry * qty * 0.0005) + (exit * qty * 0.0002);
          const netPnl = grossPnl - fees;
          
          console.log(`💰 ${side} Trade Closed! Realized Net PnL: $${netPnl.toFixed(4)}`);
          
          const historyRecord = new TradeHistory({
            symbol: symbol,
            side: side,
            entryPrice: entry,
            exitPrice: exit,
            quantity: qty,
            grossPnl: grossPnl,
            fees: fees,
            netPnl: netPnl
          });
          await historyRecord.save();
          
          // CRITICAL BUG FIX: Mutate state to prevent infinite double-logging
          oldLeg.status = 'closed';
          await dbRecord.save();
        } catch (err) {
          console.error(`❌ Failed to log closed trade:`, err.message);
        }
      };
      
      // 4.5 Self-Healing State Machine (Detect & Repair Orphaned Positions)
      const openOrders = await binanceService.fetchOpenOrders(symbol);
      // STRICT FILTER: A LONG TP is a SELL order. A SHORT TP is a BUY order.
      const longTpOrders = openOrders.filter(o => o.info.positionSide === 'LONG' && o.info.side === 'SELL' && (o.type && o.type.toLowerCase() === 'limit'));
      const shortTpOrders = openOrders.filter(o => o.info.positionSide === 'SHORT' && o.info.side === 'BUY' && (o.type && o.type.toLowerCase() === 'limit'));

      if (longPos && parseFloat(longPos.contracts) > 0 && longTpOrders.length === 0) {
        console.warn(`🚨 ORPHANED LONG POSITION DETECTED! Re-applying Take Profit...`);
        try {
          const entryPrice = parseFloat(longPos.info.entryPrice);
          const tpPriceRaw = entryPrice * (1 + gridPercentage);
          const qty = Math.abs(parseFloat(longPos.contracts));
          const healOrder = await binanceService.placeHedgeOrder(symbol, 'SELL', 'LONG', qty, 'LIMIT', tpPriceRaw);
          console.log(`✅ LONG Self-Healing Successful!`);
          dbRecord.longLeg = {
            exchangeOrderId: healOrder?.id || 'healed',
            status: 'open',
            entryPrice: entryPrice,
            quantity: qty,
            takeProfitPrice: tpPriceRaw,
            unrealizedPnl: 0
          };
          await dbRecord.save();
        } catch (healErr) {
          console.error(`❌ Failed to heal LONG position:`, healErr.message);
        }
      }

      if (shortPos && parseFloat(shortPos.contracts) > 0 && shortTpOrders.length === 0) {
        console.warn(`🚨 ORPHANED SHORT POSITION DETECTED! Re-applying Take Profit...`);
        try {
          const entryPrice = parseFloat(shortPos.info.entryPrice);
          const tpPriceRaw = entryPrice * (1 - gridPercentage);
          const qty = Math.abs(parseFloat(shortPos.contracts));
          const healOrder = await binanceService.placeHedgeOrder(symbol, 'BUY', 'SHORT', qty, 'LIMIT', tpPriceRaw);
          console.log(`✅ SHORT Self-Healing Successful!`);
          dbRecord.shortLeg = {
            exchangeOrderId: healOrder?.id || 'healed',
            status: 'open',
            entryPrice: entryPrice,
            quantity: qty,
            takeProfitPrice: tpPriceRaw,
            unrealizedPnl: 0
          };
          await dbRecord.save();
        } catch (healErr) {
          console.error(`❌ Failed to heal SHORT position:`, healErr.message);
        }
      }

      // 5. Grid Replenishment Logic - LONG
      if (!longPos || parseFloat(longPos.contracts) === 0) {
        await logClosedTrade('LONG', dbRecord.longLeg);
        if (tradingEnabled && canOpenNewPosition) {
          console.log(`📈 Opening LONG Leg at ~${currentPrice}`);
          try {
            await binanceService.cancelOrdersBySide(symbol, 'LONG');
            const entryOrder = await binanceService.placeHedgeOrder(symbol, 'BUY', 'LONG', quantityRaw, 'MARKET');
            const executionPrice = entryOrder.average || entryOrder.price || currentPrice;
            
            try {
              const tpPriceRaw = executionPrice * (1 + gridPercentage);
              await binanceService.placeHedgeOrder(symbol, 'SELL', 'LONG', quantityRaw, 'LIMIT', tpPriceRaw);
              console.log(`✅ LONG Take-Profit set`);
            } catch (tpErr) {
              console.error(`🚨 FATAL: LONG TP failed to place! Rolling back Entry Position...`);
              await binanceService.placeHedgeOrder(symbol, 'SELL', 'LONG', quantityRaw, 'MARKET');
              await BotSettings.updateOne({ singletonId: 'default_settings' }, { $set: { tradingEnabled: false } });
              console.warn(`🔒 TRADING ENGINE LOCKED due to TP placement failure to prevent fee drain.`);
              throw new Error("Long TP Placement Failed.");
            }

            dbRecord.longLeg = {
              exchangeOrderId: entryOrder.id,
              status: 'open',
              entryPrice: executionPrice,
              quantity: quantityRaw,
              takeProfitPrice: executionPrice * (1 + gridPercentage),
              unrealizedPnl: 0
            };
            await dbRecord.save();
          } catch (err) {
            console.error('❌ Failed to process LONG leg:', err.message);
          }
        }
      } else {
        // ALWAYS self-heal entry price and quantity to exactly match the exchange! Eliminates precision/slippage drift.
        dbRecord.longLeg.entryPrice = parseFloat(longPos.info.entryPrice);
        dbRecord.longLeg.quantity = Math.abs(parseFloat(longPos.contracts));
        
        if (dbRecord.longLeg.status !== 'open') {
           dbRecord.longLeg.status = 'open';
           dbRecord.longLeg.takeProfitPrice = parseFloat(longPos.info.entryPrice) * (1 + gridPercentage);
        } else {
           // --- NEW DYNAMIC GRID UPDATING (Phase 8) ---
           // If user changes gridPercentage in UI, detect deviation and update live orders!
           const expectedTp = parseFloat(longPos.info.entryPrice) * (1 + gridPercentage);
           if (Math.abs(dbRecord.longLeg.takeProfitPrice - expectedTp) > (expectedTp * 0.0001)) {
              console.log(`🔄 User updated grid target! Adjusting LONG Take-Profit to ${expectedTp.toFixed(4)}...`);
              dbRecord.longLeg.takeProfitPrice = expectedTp;
              await binanceService.cancelOrdersBySide(symbol, 'LONG'); // Triggers Self-Healing on next tick!
           }
        }
        
        // --- NEW DCA LOGIC (Phase 7) ---
        if (tradingEnabled && canOpenNewPosition && currentPrice <= dbRecord.longLeg.entryPrice * (1 - gridPercentage)) {
          console.log(`📉 Price dropped below grid! Averaging down LONG leg...`);
          try {
            await binanceService.cancelOrdersBySide(symbol, 'LONG');
            // Verify position hasn't been closed by exchange right as we cancelled the limit order
            const verifyPositions = await binanceService.fetchOpenPositions(symbol);
            const verifyLong = verifyPositions.find(p => p.info.positionSide === 'LONG');
            if (verifyLong && Math.abs(parseFloat(verifyLong.contracts)) > 0) {
                await binanceService.placeHedgeOrder(symbol, 'BUY', 'LONG', quantityRaw, 'MARKET');
            } else {
                console.warn(`🚨 DCA Aborted! Long position closed right before market order placement.`);
            }
          } catch (dcaErr) {
            console.error(`❌ Failed to DCA LONG leg:`, dcaErr.message);
          }
        }
        
        // Sync Live Net PnL to DB
        dbRecord.longLeg.unrealizedPnl = calculateNetPnl(longPos.info.unRealizedProfit, parseFloat(longPos.info.entryPrice), parseFloat(longPos.contracts));
      }
      
      // 6. Grid Replenishment Logic - SHORT
      if (!shortPos || parseFloat(shortPos.contracts) === 0) {
        await logClosedTrade('SHORT', dbRecord.shortLeg);
        if (tradingEnabled && canOpenNewPosition) {
          console.log(`📉 Opening SHORT Leg at ~${currentPrice}`);
          try {
            await binanceService.cancelOrdersBySide(symbol, 'SHORT');
            const entryOrder = await binanceService.placeHedgeOrder(symbol, 'SELL', 'SHORT', quantityRaw, 'MARKET');
            const executionPrice = entryOrder.average || entryOrder.price || currentPrice;
            
            try {
              const tpPriceRaw = executionPrice * (1 - gridPercentage);
              await binanceService.placeHedgeOrder(symbol, 'BUY', 'SHORT', quantityRaw, 'LIMIT', tpPriceRaw);
              console.log(`✅ SHORT Take-Profit set`);
            } catch (tpErr) {
              console.error(`🚨 FATAL: SHORT TP failed to place! Rolling back Entry Position...`);
              await binanceService.placeHedgeOrder(symbol, 'BUY', 'SHORT', quantityRaw, 'MARKET');
              await BotSettings.updateOne({ singletonId: 'default_settings' }, { $set: { tradingEnabled: false } });
              console.warn(`🔒 TRADING ENGINE LOCKED due to TP placement failure to prevent fee drain.`);
              throw new Error("Short TP Placement Failed.");
            }

            dbRecord.shortLeg = {
              exchangeOrderId: entryOrder.id,
              status: 'open',
              entryPrice: executionPrice,
              quantity: quantityRaw,
              takeProfitPrice: executionPrice * (1 - gridPercentage),
              unrealizedPnl: 0
            };
            await dbRecord.save();
          } catch (err) {
            console.error('❌ Failed to process SHORT leg:', err.message);
          }
        }
      } else {
         // ALWAYS self-heal entry price and quantity to exactly match the exchange! Eliminates precision/slippage drift.
         dbRecord.shortLeg.entryPrice = parseFloat(shortPos.info.entryPrice);
         dbRecord.shortLeg.quantity = Math.abs(parseFloat(shortPos.contracts));
         
         if (dbRecord.shortLeg.status !== 'open') {
            dbRecord.shortLeg.status = 'open';
            dbRecord.shortLeg.takeProfitPrice = parseFloat(shortPos.info.entryPrice) * (1 - gridPercentage);
         } else {
            // --- NEW DYNAMIC GRID UPDATING (Phase 8) ---
            const expectedTp = parseFloat(shortPos.info.entryPrice) * (1 - gridPercentage);
            if (Math.abs(dbRecord.shortLeg.takeProfitPrice - expectedTp) > (expectedTp * 0.0001)) {
               console.log(`🔄 User updated grid target! Adjusting SHORT Take-Profit to ${expectedTp.toFixed(4)}...`);
               dbRecord.shortLeg.takeProfitPrice = expectedTp;
               await binanceService.cancelOrdersBySide(symbol, 'SHORT'); // Triggers Self-Healing on next tick!
            }
         }
         
         // --- NEW DCA LOGIC (Phase 7) ---
         if (tradingEnabled && canOpenNewPosition && currentPrice >= dbRecord.shortLeg.entryPrice * (1 + gridPercentage)) {
           console.log(`📈 Price pumped above grid! Averaging down SHORT leg...`);
           try {
             await binanceService.cancelOrdersBySide(symbol, 'SHORT');
             // Verify position hasn't been closed by exchange right as we cancelled the limit order
             const verifyPositions = await binanceService.fetchOpenPositions(symbol);
             const verifyShort = verifyPositions.find(p => p.info.positionSide === 'SHORT');
             if (verifyShort && Math.abs(parseFloat(verifyShort.contracts)) > 0) {
                 await binanceService.placeHedgeOrder(symbol, 'SELL', 'SHORT', quantityRaw, 'MARKET');
             } else {
                 console.warn(`🚨 DCA Aborted! Short position closed right before market order placement.`);
             }
           } catch (dcaErr) {
             console.error(`❌ Failed to DCA SHORT leg:`, dcaErr.message);
           }
         }
         
         // Sync Live Net PnL to DB
         dbRecord.shortLeg.unrealizedPnl = calculateNetPnl(shortPos.info.unRealizedProfit, parseFloat(shortPos.info.entryPrice), Math.abs(parseFloat(shortPos.contracts)));
      }

      // Only save if the symbol didn't change mid-loop (prevents zombie positions)
      if (this.currentSymbol === symbol) {
        await dbRecord.save();
      }

    } catch (err) {
      console.error('❌ Grid Loop Error:', err.message);
    } finally {
      this.isActive = false;
    }
  }
}

export default new GridStrategyAgent();
