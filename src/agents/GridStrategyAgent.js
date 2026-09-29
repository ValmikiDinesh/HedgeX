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
    // Round 6: Dynamic Grid tracking
    // Round 6/7: Dynamic Grid & TP Tracking
    this.lastAppliedLongGrid = null;
    this.lastAppliedShortGrid = null;
  }

  async fetchSettings() {
    let settings = await BotSettings.findOne({ singletonId: 'default_settings' });
    if (!settings) {
      settings = new BotSettings();
      await settings.save();
    }
    return settings;
  }

  async executeMarketEntry(side, symbol, quantityRaw, currentPrice, effectiveGridPercent, dbRecord) {
    const isLong = side === 'LONG';
    const entrySide = isLong ? 'BUY' : 'SELL';
    const tpSide = isLong ? 'SELL' : 'BUY';
    const legKey = isLong ? 'longLeg' : 'shortLeg';

    console.log(`📈 Opening ${side} Leg at ~${currentPrice}`);
    try {
      await binanceService.cancelOrdersBySide(symbol, side);
      const entryOrder = await binanceService.placeHedgeOrder(symbol, entrySide, side, quantityRaw, 'MARKET');
      const executionPrice = entryOrder.average || entryOrder.price || currentPrice;
      const filledQty = parseFloat(entryOrder.filled || entryOrder.amount || quantityRaw);
      const tpPriceRaw = isLong 
        ? Math.max(executionPrice * (1 + effectiveGridPercent), currentPrice * 1.0005)
        : Math.min(executionPrice * (1 - effectiveGridPercent), currentPrice * 0.9995);

      try {
        await binanceService.placeHedgeOrder(symbol, tpSide, side, filledQty, 'LIMIT', tpPriceRaw);
        console.log(`✅ ${side} Take-Profit set at ${tpPriceRaw.toFixed(5)}`);
      } catch (tpErr) {
        console.warn(`⚠️ ${side} initial Take-Profit placement failed, retrying once with fresh buffer:`, tpErr.message);
        try {
          const freshPrice = await marketAgent.getCurrentPrice(symbol);
          const bufferedTp = isLong 
            ? Math.max(executionPrice * (1 + effectiveGridPercent), (freshPrice || currentPrice) * 1.001)
            : Math.min(executionPrice * (1 - effectiveGridPercent), (freshPrice || currentPrice) * 0.999);
          await binanceService.placeHedgeOrder(symbol, tpSide, side, filledQty, 'LIMIT', bufferedTp);
          console.log(`✅ ${side} Take-Profit successfully set on retry at ${bufferedTp.toFixed(5)}`);
        } catch (retryErr) {
          console.warn(`⚠️ ${side} initial Take-Profit placement deferred to Self-Healing:`, retryErr.message);
        }
      }

      dbRecord[legKey] = {
        exchangeOrderId: entryOrder.id,
        status: 'open',
        entryPrice: executionPrice,
        quantity: filledQty,
        takeProfitPrice: tpPriceRaw,
        dcaCount: 0,
        lastDcaPrice: null,
        unrealizedPnl: 0
      };
      await dbRecord.save();
    } catch (err) {
      console.error(`❌ Failed to process ${side} leg:`, err.message);
    }
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

      // --- ROUND 6: DYNAMIC ATR-BASED GRID ---
      const maxDcaLayers = this.settings.maxDcaLayers ?? 3;
      let effectiveGridPercent = gridPercentage; // Fallback to static setting

      if (this.settings.useDynamicGrid !== false) {
        const atr = await marketAgent.getLiveATR(symbol);
        if (atr && currentPrice > 0) {
          const rawAtrPercent = atr / currentPrice;
          const minGrid = this.settings.minGridPercentage || 0.0035;
          const maxGrid = this.settings.maxGridPercentage || 0.035;
          effectiveGridPercent = Math.min(Math.max(rawAtrPercent * 1.2, minGrid), maxGrid);
          console.log(`📊 Dynamic Grid: ATR=$${atr.toFixed(6)} | Spacing=${(effectiveGridPercent * 100).toFixed(2)}%`);
        }
      }

      // Fetch or Create DB Record
      let dbRecord = await HedgePosition.findOne({ symbol: symbol, status: 'active' });
      if (!dbRecord) {
        dbRecord = new HedgePosition({ symbol: symbol });
        await dbRecord.save();
      }

      // --- DUST SWEEPER (Phase 9) ---
      // Eliminate partial-fill dust ghosts that paralyze the grid with MIN_NOTIONAL spam
      if (longPos && (Math.abs(parseFloat(longPos.contracts)) * currentPrice) < 5.0) {
         console.warn(`🧹 Detected LONG Dust Position ($${(Math.abs(parseFloat(longPos.contracts)) * currentPrice).toFixed(2)} < $5.00 min notional)...`);
         try {
             await binanceService.placeHedgeOrder(symbol, 'SELL', 'LONG', Math.abs(parseFloat(longPos.contracts)), 'MARKET');
         } catch(e) {
             console.warn(`⚠️ Dust position below exchange min notional. Dropping ghost contracts from memory to prevent grid stall.`);
         }
         // Safely reset DB record so it does NOT trigger a phantom trade log in Section 5
         if (dbRecord.longLeg) {
           dbRecord.longLeg.status = 'closed';
           dbRecord.longLeg.dcaCount = 0;
           dbRecord.longLeg.lastDcaPrice = null;
           await dbRecord.save();
         }
         longPos = null; // ALWAYS clear from memory so healthy position can open!
      }
      
      if (shortPos && (Math.abs(parseFloat(shortPos.contracts)) * currentPrice) < 5.0) {
         console.warn(`🧹 Detected SHORT Dust Position ($${(Math.abs(parseFloat(shortPos.contracts)) * currentPrice).toFixed(2)} < $5.00 min notional)...`);
         try {
             await binanceService.placeHedgeOrder(symbol, 'BUY', 'SHORT', Math.abs(parseFloat(shortPos.contracts)), 'MARKET');
         } catch(e) { 
             console.warn(`⚠️ Dust position below exchange min notional. Dropping ghost contracts from memory to prevent grid stall.`);
         }
         // Safely reset DB record so it does NOT trigger a phantom trade log in Section 6
         if (dbRecord.shortLeg) {
           dbRecord.shortLeg.status = 'closed';
           dbRecord.shortLeg.dcaCount = 0;
           dbRecord.shortLeg.lastDcaPrice = null;
           await dbRecord.save();
         }
         shortPos = null; // ALWAYS clear from memory so healthy position can open!
      }
      
      // Calculate Notional Size symmetrically based on TOTAL wallet balance (including locked margin)
      const balance = await binanceService.getTotalWalletBalance();
      const notionalSize = (balance * positionPercentage) * leverage;
      const quantityRaw = notionalSize / currentPrice;
      
      // Binance requires $5.00 min notional. Pad it safely.
      const minNotional = 5.0 / Math.max(0.1, (1 - effectiveGridPercent));
      const canOpenNewPosition = notionalSize >= minNotional && quantityRaw > 0 && balance > 0 && !isMarginWarning;
      if (!canOpenNewPosition) {
        console.warn(`⚠️ Cannot open new positions: Notional size ($${notionalSize.toFixed(2)}) is below padded Binance minimum of $${minNotional.toFixed(2)} or balance is too low.`);
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
          const nominalExit = oldLeg.takeProfitPrice;
          const qty = oldLeg.quantity;
          
          if (!entry || !nominalExit || !qty || isNaN(entry) || isNaN(nominalExit) || isNaN(qty)) {
            console.warn(`⚠️ Skipping TradeHistory log for ${side}: missing/invalid numeric values.`);
            oldLeg.status = 'closed';
            await dbRecord.save();
            return;
          }

          // Verify whether exit occurred near TP or externally (e.g. manual close on exchange)
          let exit = nominalExit;
          const isLongTpNear = side === 'LONG' && currentPrice >= nominalExit * 0.995;
          const isShortTpNear = side === 'SHORT' && currentPrice <= nominalExit * 1.005;

          if (!isLongTpNear && !isShortTpNear) {
            exit = currentPrice;
            console.warn(`ℹ️ ${side} position closed externally (Current: $${currentPrice}, TP: $${nominalExit}). Logging realized exit at actual price.`);
          }
          
          let grossPnl = 0;
          if (side === 'LONG') {
            grossPnl = (exit - entry) * qty;
          } else {
            grossPnl = (entry - exit) * qty;
          }
          
          const fees = (entry * qty * 0.0005) + (exit * qty * 0.0002);
          const netPnl = grossPnl - fees;
          
          console.log(`💰 ${side} Trade Closed! Realized Net PnL: $${netPnl.toFixed(4)} (Exit: $${exit})`);
          
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

      if (longPos && Math.abs(parseFloat(longPos.contracts)) > 0 && longTpOrders.length === 0) {
        console.warn(`🚨 ORPHANED LONG POSITION DETECTED! Re-applying Take Profit...`);
        try {
          const entryPrice = parseFloat(longPos.info.entryPrice);
          const tpPriceRaw = Math.max(entryPrice * (1 + effectiveGridPercent), currentPrice * 1.0005);
          const qty = Math.abs(parseFloat(longPos.contracts));
          const healOrder = await binanceService.placeHedgeOrder(symbol, 'SELL', 'LONG', qty, 'LIMIT', tpPriceRaw);
          console.log(`✅ LONG Self-Healing Successful!`);
          dbRecord.longLeg.exchangeOrderId = healOrder?.id || 'healed';
          dbRecord.longLeg.status = 'open';
          dbRecord.longLeg.entryPrice = entryPrice;
          dbRecord.longLeg.quantity = qty;
          dbRecord.longLeg.takeProfitPrice = tpPriceRaw;
          dbRecord.longLeg.unrealizedPnl = 0;
          await dbRecord.save();
        } catch (healErr) {
          console.error(`❌ Failed to heal LONG position:`, healErr.message);
        }
      }

      if (shortPos && Math.abs(parseFloat(shortPos.contracts)) > 0 && shortTpOrders.length === 0) {
        console.warn(`🚨 ORPHANED SHORT POSITION DETECTED! Re-applying Take Profit...`);
        try {
          const entryPrice = parseFloat(shortPos.info.entryPrice);
          const tpPriceRaw = Math.min(entryPrice * (1 - effectiveGridPercent), currentPrice * 0.9995);
          const qty = Math.abs(parseFloat(shortPos.contracts));
          const healOrder = await binanceService.placeHedgeOrder(symbol, 'BUY', 'SHORT', qty, 'LIMIT', tpPriceRaw);
          console.log(`✅ SHORT Self-Healing Successful!`);
          dbRecord.shortLeg.exchangeOrderId = healOrder?.id || 'healed';
          dbRecord.shortLeg.status = 'open';
          dbRecord.shortLeg.entryPrice = entryPrice;
          dbRecord.shortLeg.quantity = qty;
          dbRecord.shortLeg.takeProfitPrice = tpPriceRaw;
          dbRecord.shortLeg.unrealizedPnl = 0;
          await dbRecord.save();
        } catch (healErr) {
          console.error(`❌ Failed to heal SHORT position:`, healErr.message);
        }
      }

      // 5. Grid Replenishment Logic - LONG
      if (!longPos || Math.abs(parseFloat(longPos.contracts || 0)) === 0) {
        if (dbRecord.longLeg && dbRecord.longLeg.status === 'open') {
          await logClosedTrade('LONG', dbRecord.longLeg);
          dbRecord.longLeg.status = 'closed';
          dbRecord.longLeg.dcaCount = 0;
          dbRecord.longLeg.lastDcaPrice = null;
          await dbRecord.save();
        }
        this.lastAppliedLongGrid = null; // Reset grid tracking

        if (tradingEnabled && canOpenNewPosition) {
          const existingLongBuy = openOrders.find(o => o.info && o.info.positionSide === 'LONG' && o.info.side === 'BUY' && (o.type && o.type.toLowerCase() === 'limit'));
          const prevEntry = dbRecord.longLeg?.entryPrice;

          if (existingLongBuy) {
            // Trend Breakout Check: If price moved >= 1.5x grid spacing above reload price, advance grid
            if (prevEntry && currentPrice >= prevEntry * (1 + effectiveGridPercent * 1.5)) {
              console.log(`🚀 LONG Trend Breakout! Cancelling resting reload limit to advance grid...`);
              await binanceService.cancelOrdersBySide(symbol, 'LONG');
              await this.executeMarketEntry('LONG', symbol, quantityRaw, currentPrice, effectiveGridPercent, dbRecord);
            }
            // Otherwise, patiently waiting for pullback to fill wholesale limit buy
          } else if (prevEntry && currentPrice >= prevEntry * (1 + effectiveGridPercent * 1.5)) {
            // Direct Trend Breakout without first placing a stale resting limit miles below
            console.log(`🚀 LONG Trend Breakout! Advancing grid immediately to current price...`);
            await this.executeMarketEntry('LONG', symbol, quantityRaw, currentPrice, effectiveGridPercent, dbRecord);
          } else if (prevEntry && currentPrice > prevEntry) {
            // Place Reload LIMIT Buy order back at wholesale base price
            console.log(`🎯 Setting LONG Reload Limit Buy at $${prevEntry.toFixed(5)} (Current: $${currentPrice.toFixed(5)})...`);
            try {
              await binanceService.cancelOrdersBySide(symbol, 'LONG');
              const reloadOrder = await binanceService.placeHedgeOrder(symbol, 'BUY', 'LONG', quantityRaw, 'LIMIT', prevEntry);
              dbRecord.longLeg.exchangeOrderId = reloadOrder?.id || 'reload_pending';
              dbRecord.longLeg.status = 'pending';
              dbRecord.longLeg.entryPrice = prevEntry;
              dbRecord.longLeg.quantity = quantityRaw;
              dbRecord.longLeg.dcaCount = 0;
              dbRecord.longLeg.lastDcaPrice = null;
              await dbRecord.save();
            } catch (reloadErr) {
              console.warn(`⚠️ Failed to place LONG reload limit order, will retry on next tick:`, reloadErr.message);
            }
          } else {
            // Fresh startup or price already pulled back to/below reload price
            await this.executeMarketEntry('LONG', symbol, quantityRaw, currentPrice, effectiveGridPercent, dbRecord);
          }
        }
      } else {
        // ALWAYS self-heal entry price and quantity to exactly match the exchange! Eliminates precision/slippage drift.
        dbRecord.longLeg.entryPrice = parseFloat(longPos.info.entryPrice);
        dbRecord.longLeg.quantity = Math.abs(parseFloat(longPos.contracts));
        
        if (dbRecord.longLeg.status !== 'open') {
           dbRecord.longLeg.status = 'open';
           const entryPrice = parseFloat(longPos.info.entryPrice);
           const tpPriceRaw = Math.max(entryPrice * (1 + effectiveGridPercent), currentPrice * 1.0005);
           const qty = Math.abs(parseFloat(longPos.contracts));
           try {
             await binanceService.placeHedgeOrder(symbol, 'SELL', 'LONG', qty, 'LIMIT', tpPriceRaw);
             console.log(`✅ LONG Take-Profit set on reload fill at $${tpPriceRaw.toFixed(5)}`);
           } catch (tpErr) {
             console.error(`⚠️ Failed to set LONG TP on reload fill:`, tpErr.message);
           }
           dbRecord.longLeg.takeProfitPrice = tpPriceRaw;
           this.lastAppliedLongGrid = effectiveGridPercent;
           await dbRecord.save();
        } else {
           // --- DYNAMIC GRID UPDATING (Phase 8 + Round 6 Significance Threshold) ---
           const expectedTp = parseFloat(longPos.info.entryPrice) * (1 + effectiveGridPercent);
           const lastGrid = this.lastAppliedLongGrid || effectiveGridPercent;
           const gridShift = Math.abs(effectiveGridPercent - lastGrid) / lastGrid;
           const threshold = (this.settings.useDynamicGrid !== false) ? 0.15 : 0.0001;
           const deviation = (this.settings.useDynamicGrid !== false) ? gridShift : Math.abs(dbRecord.longLeg.takeProfitPrice - expectedTp) / expectedTp;
           if (deviation > threshold) {
              console.log(`🔄 Grid shift detected! Adjusting LONG Take-Profit to ${expectedTp.toFixed(4)}...`);
              dbRecord.longLeg.takeProfitPrice = expectedTp;
              this.lastAppliedLongGrid = effectiveGridPercent;
              await binanceService.cancelOrdersBySide(symbol, 'LONG');
              const qty = Math.abs(parseFloat(longPos.contracts));
              try {
                await binanceService.placeHedgeOrder(symbol, 'SELL', 'LONG', qty, 'LIMIT', expectedTp);
                console.log(`✅ LONG Take-Profit updated immediately to $${expectedTp.toFixed(5)}`);
              } catch (tpErr) {
                console.warn(`⚠️ Failed to immediately update LONG TP, Self-Healing will place on next tick:`, tpErr.message);
              }
           }
        }
        
        // --- POSITION STOP-LOSS GUARD (Round 7 - Decoupled Hard Safety Stop) ---
        const stopLossPercent = this.settings.stopLossPercentage ?? 0.05;
        const currentLongDca = dbRecord.longLeg.dcaCount || 0;
        let longSlTriggered = false;
        const isLongSlBreached = stopLossPercent > 0 && currentPrice <= dbRecord.longLeg.entryPrice * (1 - stopLossPercent);

        if (stopLossPercent > 0 && isLongSlBreached) {
          const longSlPrice = dbRecord.longLeg.entryPrice * (1 - stopLossPercent);
          longSlTriggered = true;
          console.warn(`🚨 STOP-LOSS TRIGGERED FOR LONG LEG! Current: $${currentPrice}, SL: $${longSlPrice.toFixed(4)} (-${(stopLossPercent * 100).toFixed(1)}%)`);
            try {
              await binanceService.cancelOrdersBySide(symbol, 'LONG');
              const closeOrder = await binanceService.placeHedgeOrder(symbol, 'SELL', 'LONG', Math.abs(parseFloat(longPos.contracts)), 'MARKET');
              const exitPrice = closeOrder?.average || closeOrder?.price || currentPrice;
              
              const entry = dbRecord.longLeg.entryPrice;
              const qty = Math.abs(parseFloat(longPos.contracts));
              const grossPnl = (exitPrice - entry) * qty;
              const fees = (entry * qty * 0.0005) + (exitPrice * qty * 0.0005);
              const netPnl = grossPnl - fees;
              
              const historyRecord = new TradeHistory({
                symbol: symbol,
                side: 'LONG',
                entryPrice: entry,
                exitPrice: exitPrice,
                quantity: qty,
                grossPnl: grossPnl,
                fees: fees,
                netPnl: netPnl
              });
              await historyRecord.save();
              console.log(`🛡️ LONG Stop-Loss executed. Realized Net PnL: $${netPnl.toFixed(4)}. Opposing SHORT remains active.`);
              
              dbRecord.longLeg.status = 'closed';
              dbRecord.longLeg.entryPrice = null; // Clear so stopped-out leg does not anchor to stale pre-dump entry
              dbRecord.longLeg.dcaCount = 0;
              dbRecord.longLeg.lastDcaPrice = null;
              dbRecord.longLeg.unrealizedPnl = 0;
              dbRecord.longLeg.realizedPnl = netPnl;
              await dbRecord.save();
              longPos = null;
            } catch (slErr) {
              console.error(`❌ Failed to execute LONG stop loss:`, slErr.message);
            }
          }

        // --- DCA LOGIC (Phase 7 + Round 6/7 Persistent Spacing & Max Layers) ---
        if (!longSlTriggered && longPos) {
          const longAnchorPrice = dbRecord.longLeg.lastDcaPrice || dbRecord.longLeg.entryPrice;
          const isLongDcaPriceMet = currentPrice <= longAnchorPrice * (1 - effectiveGridPercent);

          if (tradingEnabled && canOpenNewPosition && currentLongDca < maxDcaLayers && isLongDcaPriceMet) {
            console.log(`📉 Price dropped below grid! DCA LONG leg (Layer ${currentLongDca + 1}/${maxDcaLayers})...`);
            try {
              const verifyPositions = await binanceService.fetchOpenPositions(symbol);
              const verifyLong = verifyPositions.find(p => p.info.positionSide === 'LONG');
              if (verifyLong && Math.abs(parseFloat(verifyLong.contracts)) > 0) {
                  const freeMargin = await binanceService.getBalance();
                  const requiredMargin = (quantityRaw * currentPrice) / leverage;
                  if (freeMargin < requiredMargin * 1.05) {
                    console.warn(`⚠️ DCA LONG skipped: Free margin ($${freeMargin.toFixed(2)}) is below required margin ($${requiredMargin.toFixed(2)}).`);
                  } else {
                    const dcaOrder = await binanceService.placeHedgeOrder(symbol, 'BUY', 'LONG', quantityRaw, 'MARKET');
                    const fillPrice = dcaOrder?.average || dcaOrder?.price || currentPrice;
                    dbRecord.longLeg.dcaCount = currentLongDca + 1;
                    dbRecord.longLeg.lastDcaPrice = fillPrice;
                    
                    // Replace old Take-Profit order ONLY after DCA market fill is confirmed
                    await binanceService.cancelOrdersBySide(symbol, 'LONG');
                    const updatedPositions = await binanceService.fetchOpenPositions(symbol);
                    const updatedLong = updatedPositions.find(p => p.info.positionSide === 'LONG');
                    if (updatedLong && Math.abs(parseFloat(updatedLong.contracts)) > 0) {
                      const newEntry = parseFloat(updatedLong.info.entryPrice);
                      const newQty = Math.abs(parseFloat(updatedLong.contracts));
                      const newTpPrice = Math.max(newEntry * (1 + effectiveGridPercent), currentPrice * 1.0005);
                      dbRecord.longLeg.entryPrice = newEntry;
                      dbRecord.longLeg.quantity = newQty;
                      dbRecord.longLeg.takeProfitPrice = newTpPrice;
                      this.lastAppliedLongGrid = effectiveGridPercent;
                      try {
                        await binanceService.placeHedgeOrder(symbol, 'SELL', 'LONG', newQty, 'LIMIT', newTpPrice);
                      } catch (tpErr) {
                        console.warn(`⚠️ DCA TP placement deferred to self-healing:`, tpErr.message);
                      }
                    }
                    await dbRecord.save();
                  }
              } else {
                  console.warn(`🚨 DCA Aborted! Long position closed right before market order placement.`);
              }
            } catch (dcaErr) {
              console.error(`❌ Failed to DCA LONG leg:`, dcaErr.message);
            }
          } else if (currentLongDca >= maxDcaLayers && isLongDcaPriceMet) {
            console.warn(`🛑 DCA LONG capped at ${maxDcaLayers} layers. No more entries until position resets.`);
          }
          
          // Sync Live Net PnL to DB
          dbRecord.longLeg.unrealizedPnl = calculateNetPnl(longPos.info.unRealizedProfit, parseFloat(longPos.info.entryPrice), Math.abs(parseFloat(longPos.contracts)));
        }
      }
      
      // 6. Grid Replenishment Logic - SHORT
      if (!shortPos || Math.abs(parseFloat(shortPos.contracts || 0)) === 0) {
        if (dbRecord.shortLeg && dbRecord.shortLeg.status === 'open') {
          await logClosedTrade('SHORT', dbRecord.shortLeg);
          dbRecord.shortLeg.status = 'closed';
          dbRecord.shortLeg.dcaCount = 0;
          dbRecord.shortLeg.lastDcaPrice = null;
          await dbRecord.save();
        }
        this.lastAppliedShortGrid = null; // Reset grid tracking

        if (tradingEnabled && canOpenNewPosition) {
          const existingShortSell = openOrders.find(o => o.info && o.info.positionSide === 'SHORT' && o.info.side === 'SELL' && (o.type && o.type.toLowerCase() === 'limit'));
          const prevEntry = dbRecord.shortLeg?.entryPrice;

          if (existingShortSell) {
            // Trend Breakout Check: If price dumped <= 1.5x grid spacing below reload price, advance grid
            if (prevEntry && currentPrice <= prevEntry * (1 - effectiveGridPercent * 1.5)) {
              console.log(`🚀 SHORT Trend Breakout! Cancelling resting reload limit to advance grid...`);
              await binanceService.cancelOrdersBySide(symbol, 'SHORT');
              await this.executeMarketEntry('SHORT', symbol, quantityRaw, currentPrice, effectiveGridPercent, dbRecord);
            }
            // Otherwise, patiently waiting for pullback to fill wholesale limit sell
          } else if (prevEntry && currentPrice <= prevEntry * (1 - effectiveGridPercent * 1.5)) {
            // Direct Trend Breakout without first placing a stale resting limit miles above
            console.log(`🚀 SHORT Trend Breakout! Advancing grid immediately to current price...`);
            await this.executeMarketEntry('SHORT', symbol, quantityRaw, currentPrice, effectiveGridPercent, dbRecord);
          } else if (prevEntry && currentPrice < prevEntry) {
            // Place Reload LIMIT Sell order back at wholesale base price
            console.log(`🎯 Setting SHORT Reload Limit Sell at $${prevEntry.toFixed(5)} (Current: $${currentPrice.toFixed(5)})...`);
            try {
              await binanceService.cancelOrdersBySide(symbol, 'SHORT');
              const reloadOrder = await binanceService.placeHedgeOrder(symbol, 'SELL', 'SHORT', quantityRaw, 'LIMIT', prevEntry);
              dbRecord.shortLeg.exchangeOrderId = reloadOrder?.id || 'reload_pending';
              dbRecord.shortLeg.status = 'pending';
              dbRecord.shortLeg.entryPrice = prevEntry;
              dbRecord.shortLeg.quantity = quantityRaw;
              dbRecord.shortLeg.dcaCount = 0;
              dbRecord.shortLeg.lastDcaPrice = null;
              await dbRecord.save();
            } catch (reloadErr) {
              console.warn(`⚠️ Failed to place SHORT reload limit order, will retry on next tick:`, reloadErr.message);
            }
          } else {
            // Fresh startup or price already pulled back to/above reload price
            await this.executeMarketEntry('SHORT', symbol, quantityRaw, currentPrice, effectiveGridPercent, dbRecord);
          }
        }
      } else {
        // ALWAYS self-heal entry price and quantity to exactly match the exchange! Eliminates precision/slippage drift.
        dbRecord.shortLeg.entryPrice = parseFloat(shortPos.info.entryPrice);
        dbRecord.shortLeg.quantity = Math.abs(parseFloat(shortPos.contracts));
        
        if (dbRecord.shortLeg.status !== 'open') {
           dbRecord.shortLeg.status = 'open';
           const entryPrice = parseFloat(shortPos.info.entryPrice);
           const tpPriceRaw = Math.min(entryPrice * (1 - effectiveGridPercent), currentPrice * 0.9995);
           const qty = Math.abs(parseFloat(shortPos.contracts));
           try {
             await binanceService.placeHedgeOrder(symbol, 'BUY', 'SHORT', qty, 'LIMIT', tpPriceRaw);
             console.log(`✅ SHORT Take-Profit set on reload fill at $${tpPriceRaw.toFixed(5)}`);
           } catch (tpErr) {
             console.error(`⚠️ Failed to set SHORT TP on reload fill:`, tpErr.message);
           }
           dbRecord.shortLeg.takeProfitPrice = tpPriceRaw;
           this.lastAppliedShortGrid = effectiveGridPercent;
           await dbRecord.save();
        } else {
           // --- DYNAMIC GRID UPDATING (Phase 8 + Round 6 Significance Threshold) ---
           const expectedTp = parseFloat(shortPos.info.entryPrice) * (1 - effectiveGridPercent);
           const lastGrid = this.lastAppliedShortGrid || effectiveGridPercent;
           const gridShift = Math.abs(effectiveGridPercent - lastGrid) / lastGrid;
           const threshold = (this.settings.useDynamicGrid !== false) ? 0.15 : 0.0001;
           const deviation = (this.settings.useDynamicGrid !== false) ? gridShift : Math.abs(dbRecord.shortLeg.takeProfitPrice - expectedTp) / expectedTp;
           if (deviation > threshold) {
              console.log(`🔄 Grid shift detected! Adjusting SHORT Take-Profit to ${expectedTp.toFixed(4)}...`);
              dbRecord.shortLeg.takeProfitPrice = expectedTp;
              this.lastAppliedShortGrid = effectiveGridPercent;
              await binanceService.cancelOrdersBySide(symbol, 'SHORT');
              const qty = Math.abs(parseFloat(shortPos.contracts));
              try {
                await binanceService.placeHedgeOrder(symbol, 'BUY', 'SHORT', qty, 'LIMIT', expectedTp);
                console.log(`✅ SHORT Take-Profit updated immediately to $${expectedTp.toFixed(5)}`);
              } catch (tpErr) {
                console.warn(`⚠️ Failed to immediately update SHORT TP, Self-Healing will place on next tick:`, tpErr.message);
              }
           }
        }
        
        // --- POSITION STOP-LOSS GUARD (Round 7 - Decoupled Hard Safety Stop) ---
        const stopLossPercent = this.settings.stopLossPercentage ?? 0.05;
        const currentShortDca = dbRecord.shortLeg.dcaCount || 0;
        let shortSlTriggered = false;
        const isShortSlBreached = stopLossPercent > 0 && currentPrice >= dbRecord.shortLeg.entryPrice * (1 + stopLossPercent);

        if (stopLossPercent > 0 && isShortSlBreached) {
          const shortSlPrice = dbRecord.shortLeg.entryPrice * (1 + stopLossPercent);
          shortSlTriggered = true;
          console.warn(`🚨 STOP-LOSS TRIGGERED FOR SHORT LEG! Current: $${currentPrice}, SL: $${shortSlPrice.toFixed(4)} (+${(stopLossPercent * 100).toFixed(1)}%)`);
            try {
              await binanceService.cancelOrdersBySide(symbol, 'SHORT');
              const closeOrder = await binanceService.placeHedgeOrder(symbol, 'BUY', 'SHORT', Math.abs(parseFloat(shortPos.contracts)), 'MARKET');
              const exitPrice = closeOrder?.average || closeOrder?.price || currentPrice;
              
              const entry = dbRecord.shortLeg.entryPrice;
              const qty = Math.abs(parseFloat(shortPos.contracts));
              const grossPnl = (entry - exitPrice) * qty;
              const fees = (entry * qty * 0.0005) + (exitPrice * qty * 0.0005);
              const netPnl = grossPnl - fees;
              
              const historyRecord = new TradeHistory({
                symbol: symbol,
                side: 'SHORT',
                entryPrice: entry,
                exitPrice: exitPrice,
                quantity: qty,
                grossPnl: grossPnl,
                fees: fees,
                netPnl: netPnl
              });
              await historyRecord.save();
              console.log(`🛡️ SHORT Stop-Loss executed. Realized Net PnL: $${netPnl.toFixed(4)}. Opposing LONG remains active.`);
              
              dbRecord.shortLeg.status = 'closed';
              dbRecord.shortLeg.entryPrice = null; // Clear so stopped-out leg does not anchor to stale pre-dump entry
              dbRecord.shortLeg.dcaCount = 0;
              dbRecord.shortLeg.lastDcaPrice = null;
              dbRecord.shortLeg.unrealizedPnl = 0;
              dbRecord.shortLeg.realizedPnl = netPnl;
              await dbRecord.save();
              shortPos = null;
            } catch (slErr) {
              console.error(`❌ Failed to execute SHORT stop loss:`, slErr.message);
            }
          }

        // --- DCA LOGIC (Phase 7 + Round 6/7 Persistent Spacing & Max Layers) ---
        if (!shortSlTriggered && shortPos) {
          const shortAnchorPrice = dbRecord.shortLeg.lastDcaPrice || dbRecord.shortLeg.entryPrice;
          const isShortDcaPriceMet = currentPrice >= shortAnchorPrice * (1 + effectiveGridPercent);

          if (tradingEnabled && canOpenNewPosition && currentShortDca < maxDcaLayers && isShortDcaPriceMet) {
            console.log(`📈 Price pumped above grid! DCA SHORT leg (Layer ${currentShortDca + 1}/${maxDcaLayers})...`);
            try {
              const verifyPositions = await binanceService.fetchOpenPositions(symbol);
              const verifyShort = verifyPositions.find(p => p.info.positionSide === 'SHORT');
              if (verifyShort && Math.abs(parseFloat(verifyShort.contracts)) > 0) {
                  const freeMargin = await binanceService.getBalance();
                  const requiredMargin = (quantityRaw * currentPrice) / leverage;
                  if (freeMargin < requiredMargin * 1.05) {
                    console.warn(`⚠️ DCA SHORT skipped: Free margin ($${freeMargin.toFixed(2)}) is below required margin ($${requiredMargin.toFixed(2)}).`);
                  } else {
                    const dcaOrder = await binanceService.placeHedgeOrder(symbol, 'SELL', 'SHORT', quantityRaw, 'MARKET');
                    const fillPrice = dcaOrder?.average || dcaOrder?.price || currentPrice;
                    dbRecord.shortLeg.dcaCount = currentShortDca + 1;
                    dbRecord.shortLeg.lastDcaPrice = fillPrice;
                    
                    // Replace old Take-Profit order ONLY after DCA market fill is confirmed
                    await binanceService.cancelOrdersBySide(symbol, 'SHORT');
                    const updatedPositions = await binanceService.fetchOpenPositions(symbol);
                    const updatedShort = updatedPositions.find(p => p.info.positionSide === 'SHORT');
                    if (updatedShort && Math.abs(parseFloat(updatedShort.contracts)) > 0) {
                      const newEntry = parseFloat(updatedShort.info.entryPrice);
                      const newQty = Math.abs(parseFloat(updatedShort.contracts));
                      const newTpPrice = Math.min(newEntry * (1 - effectiveGridPercent), currentPrice * 0.9995);
                      dbRecord.shortLeg.entryPrice = newEntry;
                      dbRecord.shortLeg.quantity = newQty;
                      dbRecord.shortLeg.takeProfitPrice = newTpPrice;
                      this.lastAppliedShortGrid = effectiveGridPercent;
                      try {
                        await binanceService.placeHedgeOrder(symbol, 'BUY', 'SHORT', newQty, 'LIMIT', newTpPrice);
                      } catch (tpErr) {
                        console.warn(`⚠️ DCA TP placement deferred to self-healing:`, tpErr.message);
                      }
                    }
                    await dbRecord.save();
                  }
              } else {
                  console.warn(`🚨 DCA Aborted! Short position closed right before market order placement.`);
              }
            } catch (dcaErr) {
              console.error(`❌ Failed to DCA SHORT leg:`, dcaErr.message);
            }
          } else if (currentShortDca >= maxDcaLayers && isShortDcaPriceMet) {
            console.warn(`🛑 DCA SHORT capped at ${maxDcaLayers} layers. No more entries until position resets.`);
          }
          
          // Sync Live Net PnL to DB
          dbRecord.shortLeg.unrealizedPnl = calculateNetPnl(shortPos.info.unRealizedProfit, parseFloat(shortPos.info.entryPrice), Math.abs(parseFloat(shortPos.contracts)));
        }
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
