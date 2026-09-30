import binanceService from '../services/BinanceService.js';
import marketAgent from './MarketAgent.js';
import riskManager from './RiskManager.js';
import HedgePosition from '../models/HedgePosition.js';
import BotSettings from '../models/BotSettings.js';
import TradeHistory from '../models/TradeHistory.js';

const STOP_LOSS_COOLDOWN_MS = 5 * 60 * 1000; // 5-minute cooldown after stop-loss to avoid knife-catching

class GridStrategyAgent {
  constructor() {
    this.isActive = false;
    this.currentSymbol = null; // Track internally to detect symbol changes
    this.currentLeverage = null; // Track internally to detect leverage changes
    this.settings = null;
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
      let tpPriceRaw = isLong 
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
          tpPriceRaw = bufferedTp;
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
        unrealizedPnl: 0,
        stoppedOutAt: null
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
      const rawSymbol = binanceService.toRawSymbol(this.settings.symbol);
      const symbol = rawSymbol;
      const { gridPercentage, positionPercentage, tradingEnabled } = this.settings;
      let leverage = this.settings.leverage;

      // Update tracking symbol & leverage independently
      const symbolChanged = this.currentSymbol !== symbol;
      if (symbolChanged) {
        this.currentSymbol = symbol;
        this.lastAppliedLongGrid = null;
        this.lastAppliedShortGrid = null;
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
      if (safetyStatus === 'PANIC' || safetyStatus === 'PAUSE') {
        this.isActive = false;
        return;
      }
      const isMarginWarning = (safetyStatus === 'WARNING');

      // 4. Fetch current active positions and orders
      const positions = await binanceService.fetchOpenPositions(symbol);
      let longPos = positions.find(p => (p.info?.positionSide === 'LONG') || (p.side === 'long'));
      let shortPos = positions.find(p => (p.info?.positionSide === 'SHORT') || (p.side === 'short'));
      
      const currentPrice = await marketAgent.getCurrentPrice(symbol);
      if (!currentPrice || currentPrice <= 0) {
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

      // Fetch or Create DB Record (always sort by createdAt desc for consistency)
      let dbRecord = await HedgePosition.findOne({ symbol: symbol, status: 'active' }).sort({ createdAt: -1 });
      if (!dbRecord) {
        dbRecord = new HedgePosition({ symbol: symbol });
        await dbRecord.save();
      }

      // --- DUST SWEEPER ---
      // Safely drop ghost dust positions (< $5.00 min notional) without spamming failing market orders
      if (longPos) {
        const longNotional = Math.abs(parseFloat(longPos.contracts)) * currentPrice;
        if (longNotional < 5.0) {
          console.warn(`🧹 Detected LONG Dust Position ($${longNotional.toFixed(2)} < $5.00 min notional). Dropping ghost contracts from memory.`);
          await binanceService.cancelOrdersBySide(symbol, 'LONG').catch(() => {});
          if (dbRecord.longLeg) {
            dbRecord.longLeg.status = 'closed';
            dbRecord.longLeg.dcaCount = 0;
            dbRecord.longLeg.lastDcaPrice = null;
            await dbRecord.save();
          }
          longPos = null;
        }
      }
      
      if (shortPos) {
        const shortNotional = Math.abs(parseFloat(shortPos.contracts)) * currentPrice;
        if (shortNotional < 5.0) {
          console.warn(`🧹 Detected SHORT Dust Position ($${shortNotional.toFixed(2)} < $5.00 min notional). Dropping ghost contracts from memory.`);
          await binanceService.cancelOrdersBySide(symbol, 'SHORT').catch(() => {});
          if (dbRecord.shortLeg) {
            dbRecord.shortLeg.status = 'closed';
            dbRecord.shortLeg.dcaCount = 0;
            dbRecord.shortLeg.lastDcaPrice = null;
            await dbRecord.save();
          }
          shortPos = null;
        }
      }
      
      // Calculate Notional Size symmetrically based on TOTAL wallet balance
      const balance = await binanceService.getTotalWalletBalance();
      const notionalSize = (balance * positionPercentage) * leverage;
      const quantityRaw = notionalSize / currentPrice;
      
      // Binance requires $5.00 min notional. Pad it safely.
      const minNotional = 5.0 / Math.max(0.1, (1 - effectiveGridPercent));
      const canOpenNewPosition = notionalSize >= minNotional && quantityRaw > 0 && balance > 0 && !isMarginWarning;
      if (!canOpenNewPosition && tradingEnabled) {
        console.warn(`⚠️ Cannot open new positions: Notional size ($${notionalSize.toFixed(2)}) is below padded Binance minimum of $${minNotional.toFixed(2)} or balance is too low.`);
      }

      // Helper function to calculate Net PnL (Deducting ~0.07% round-trip exchange fees)
      const calculateNetPnl = (unRealizedPnlStr, entryPrice, qty) => {
        const grossPnl = parseFloat(unRealizedPnlStr || 0);
        const safeEntry = isFinite(entryPrice) ? entryPrice : 0;
        const safeQty = isFinite(qty) ? qty : 0;
        const estimatedFees = (safeEntry * safeQty) * 0.0007; 
        return grossPnl - estimatedFees;
      };

      // Helper function to log closed trades
      const logClosedTrade = async (side, oldLeg) => {
        if (!oldLeg || oldLeg.status !== 'open') return;
        
        try {
          const entry = oldLeg.entryPrice;
          const nominalExit = oldLeg.takeProfitPrice;
          const qty = oldLeg.quantity;
          
          if (!entry || !qty || isNaN(entry) || isNaN(qty) || entry <= 0 || qty <= 0) {
            console.warn(`⚠️ Skipping TradeHistory log for ${side}: missing/invalid numeric values.`);
            oldLeg.status = 'closed';
            await dbRecord.save();
            return;
          }

          // In hedge mode, when position closes naturally, limit TP order executed at nominalExit
          const exit = (nominalExit && nominalExit > 0) ? nominalExit : currentPrice;
          
          let grossPnl = 0;
          if (side === 'LONG') {
            grossPnl = (exit - entry) * qty;
          } else {
            grossPnl = (entry - exit) * qty;
          }
          
          const fees = (entry * qty * 0.0005) + (exit * qty * 0.0002);
          const netPnl = grossPnl - fees;
          
          console.log(`💰 ${side} Trade Closed! Realized Net PnL: $${netPnl.toFixed(4)} (Entry: $${entry}, Exit: $${exit})`);
          
          const historyRecord = new TradeHistory({
            symbol: symbol,
            side: side,
            entryPrice: entry,
            exitPrice: exit,
            quantity: qty,
            grossPnl: isFinite(grossPnl) ? grossPnl : 0,
            fees: isFinite(fees) ? fees : 0,
            netPnl: isFinite(netPnl) ? netPnl : 0
          });
          await historyRecord.save();
          
          oldLeg.status = 'closed';
          await dbRecord.save();
        } catch (err) {
          console.error(`❌ Failed to log closed trade:`, err.message);
        }
      };
      
      // 4.5 Self-Healing State Machine (Detect & Repair Orphaned Positions)
      const openOrders = await binanceService.fetchOpenOrders(symbol);
      const longTpOrders = openOrders.filter(o => o.info && o.info.positionSide === 'LONG' && o.info.side === 'SELL' && (o.type && o.type.toLowerCase() === 'limit'));
      const shortTpOrders = openOrders.filter(o => o.info && o.info.positionSide === 'SHORT' && o.info.side === 'BUY' && (o.type && o.type.toLowerCase() === 'limit'));

      // LONG Self-Healing
      if (longPos && Math.abs(parseFloat(longPos.contracts)) > 0 && longTpOrders.length === 0) {
        const entryPrice = parseFloat(longPos.info?.entryPrice || longPos.entryPrice || 0);
        const qty = Math.abs(parseFloat(longPos.contracts));
        const targetTp = entryPrice * (1 + effectiveGridPercent);

        // PROACTIVE PROFIT-TAKING: If price already reached/surpassed TP, market close immediately!
        if (currentPrice >= targetTp && entryPrice > 0) {
          console.log(`🎯 LONG Take-Profit target already met ($${currentPrice} >= $${targetTp.toFixed(5)})! Market closing to lock in profit...`);
          try {
            await binanceService.cancelOrdersBySide(symbol, 'LONG');
            const closeOrder = await binanceService.placeHedgeOrder(symbol, 'SELL', 'LONG', qty, 'MARKET');
            const exitPrice = closeOrder?.average || closeOrder?.price || currentPrice;
            const grossPnl = (exitPrice - entryPrice) * qty;
            const fees = (entryPrice * qty * 0.0005) + (exitPrice * qty * 0.0005);
            const netPnl = grossPnl - fees;

            const historyRecord = new TradeHistory({
              symbol: symbol,
              side: 'LONG',
              entryPrice: entryPrice,
              exitPrice: exitPrice,
              quantity: qty,
              grossPnl: isFinite(grossPnl) ? grossPnl : 0,
              fees: isFinite(fees) ? fees : 0,
              netPnl: isFinite(netPnl) ? netPnl : 0
            });
            await historyRecord.save();
            dbRecord.longLeg.status = 'closed';
            dbRecord.longLeg.dcaCount = 0;
            dbRecord.longLeg.lastDcaPrice = null;
            await dbRecord.save();
            longPos = null;
            console.log(`✅ LONG Profit locked via Market Close. Realized Net PnL: $${netPnl.toFixed(4)}`);
          } catch (closeErr) {
            console.error(`❌ Failed to market close in-profit LONG position:`, closeErr.message);
          }
        } else if (entryPrice > 0) {
          console.warn(`🚨 ORPHANED LONG POSITION DETECTED! Re-applying Take Profit...`);
          try {
            const tpPriceRaw = Math.max(targetTp, currentPrice * 1.0005);
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
      }

      // SHORT Self-Healing
      if (shortPos && Math.abs(parseFloat(shortPos.contracts)) > 0 && shortTpOrders.length === 0) {
        const entryPrice = parseFloat(shortPos.info?.entryPrice || shortPos.entryPrice || 0);
        const qty = Math.abs(parseFloat(shortPos.contracts));
        const targetTp = entryPrice * (1 - effectiveGridPercent);

        // PROACTIVE PROFIT-TAKING: If price already dropped below TP, market close immediately!
        if (currentPrice <= targetTp && entryPrice > 0) {
          console.log(`🎯 SHORT Take-Profit target already met ($${currentPrice} <= $${targetTp.toFixed(5)})! Market closing to lock in profit...`);
          try {
            await binanceService.cancelOrdersBySide(symbol, 'SHORT');
            const closeOrder = await binanceService.placeHedgeOrder(symbol, 'BUY', 'SHORT', qty, 'MARKET');
            const exitPrice = closeOrder?.average || closeOrder?.price || currentPrice;
            const grossPnl = (entryPrice - exitPrice) * qty;
            const fees = (entryPrice * qty * 0.0005) + (exitPrice * qty * 0.0005);
            const netPnl = grossPnl - fees;

            const historyRecord = new TradeHistory({
              symbol: symbol,
              side: 'SHORT',
              entryPrice: entryPrice,
              exitPrice: exitPrice,
              quantity: qty,
              grossPnl: isFinite(grossPnl) ? grossPnl : 0,
              fees: isFinite(fees) ? fees : 0,
              netPnl: isFinite(netPnl) ? netPnl : 0
            });
            await historyRecord.save();
            dbRecord.shortLeg.status = 'closed';
            dbRecord.shortLeg.dcaCount = 0;
            dbRecord.shortLeg.lastDcaPrice = null;
            await dbRecord.save();
            shortPos = null;
            console.log(`✅ SHORT Profit locked via Market Close. Realized Net PnL: $${netPnl.toFixed(4)}`);
          } catch (closeErr) {
            console.error(`❌ Failed to market close in-profit SHORT position:`, closeErr.message);
          }
        } else if (entryPrice > 0) {
          console.warn(`🚨 ORPHANED SHORT POSITION DETECTED! Re-applying Take Profit...`);
          try {
            const tpPriceRaw = Math.min(targetTp, currentPrice * 0.9995);
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

        // Stop-Loss Cooldown Guard: Prevents immediate knife-catching re-entry
        const longCooldownRemaining = dbRecord.longLeg?.stoppedOutAt 
          ? Math.max(0, STOP_LOSS_COOLDOWN_MS - (Date.now() - new Date(dbRecord.longLeg.stoppedOutAt).getTime()))
          : 0;

        if (longCooldownRemaining > 0) {
          console.log(`⏳ LONG leg is in Stop-Loss Cooldown (${Math.ceil(longCooldownRemaining / 1000)}s left). Holding off re-entry.`);
        } else if (tradingEnabled && canOpenNewPosition) {
          const existingLongBuy = openOrders.find(o => o.info && o.info.positionSide === 'LONG' && o.info.side === 'BUY' && (o.type && o.type.toLowerCase() === 'limit'));
          const prevEntry = dbRecord.longLeg?.entryPrice;

          if (existingLongBuy) {
            // Trend Breakout Check: If price moved >= 1.5x grid spacing above reload price, advance grid
            if (prevEntry && currentPrice >= prevEntry * (1 + effectiveGridPercent * 1.5)) {
              console.log(`🚀 LONG Trend Breakout! Cancelling resting reload limit to advance grid...`);
              await binanceService.cancelOrdersBySide(symbol, 'LONG');
              await this.executeMarketEntry('LONG', symbol, quantityRaw, currentPrice, effectiveGridPercent, dbRecord);
            }
          } else if (prevEntry && currentPrice >= prevEntry * (1 + effectiveGridPercent * 1.5)) {
            console.log(`🚀 LONG Trend Breakout! Advancing grid immediately to current price...`);
            await this.executeMarketEntry('LONG', symbol, quantityRaw, currentPrice, effectiveGridPercent, dbRecord);
          } else if (prevEntry && currentPrice > prevEntry) {
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
        // ALWAYS self-heal entry price and quantity to exactly match the exchange!
        dbRecord.longLeg.entryPrice = parseFloat(longPos.info?.entryPrice || longPos.entryPrice);
        dbRecord.longLeg.quantity = Math.abs(parseFloat(longPos.contracts));
        
        if (dbRecord.longLeg.status !== 'open') {
           dbRecord.longLeg.status = 'open';
           const entryPrice = parseFloat(longPos.info?.entryPrice || longPos.entryPrice);
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
           // Dynamic Grid Updating
           const expectedTp = parseFloat(longPos.info?.entryPrice || longPos.entryPrice) * (1 + effectiveGridPercent);
           const lastGrid = this.lastAppliedLongGrid || effectiveGridPercent;
           const gridShift = Math.abs(effectiveGridPercent - lastGrid) / lastGrid;
           const threshold = (this.settings.useDynamicGrid !== false) ? 0.15 : 0.0001;
           const deviation = (this.settings.useDynamicGrid !== false) ? gridShift : Math.abs(dbRecord.longLeg.takeProfitPrice - expectedTp) / expectedTp;
           if (deviation > threshold && expectedTp > 0) {
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
        
        // --- POSITION STOP-LOSS GUARD ---
        const stopLossPercent = this.settings.stopLossPercentage ?? 0.05;
        const currentLongDca = dbRecord.longLeg.dcaCount || 0;
        let longSlTriggered = false;
        const longEntry = dbRecord.longLeg.entryPrice;
        const isLongSlBreached = stopLossPercent > 0 && longEntry > 0 && currentPrice <= longEntry * (1 - stopLossPercent);

        if (stopLossPercent > 0 && isLongSlBreached) {
          const longSlPrice = longEntry * (1 - stopLossPercent);
          longSlTriggered = true;
          console.warn(`🚨 STOP-LOSS TRIGGERED FOR LONG LEG! Current: $${currentPrice}, SL: $${longSlPrice.toFixed(4)} (-${(stopLossPercent * 100).toFixed(1)}%)`);
          try {
            await binanceService.cancelOrdersBySide(symbol, 'LONG');
            const closeOrder = await binanceService.placeHedgeOrder(symbol, 'SELL', 'LONG', Math.abs(parseFloat(longPos.contracts)), 'MARKET');
            const exitPrice = closeOrder?.average || closeOrder?.price || currentPrice;
            
            const qty = Math.abs(parseFloat(longPos.contracts));
            const grossPnl = (exitPrice - longEntry) * qty;
            const fees = (longEntry * qty * 0.0005) + (exitPrice * qty * 0.0005);
            const netPnl = grossPnl - fees;
            
            const historyRecord = new TradeHistory({
              symbol: symbol,
              side: 'LONG',
              entryPrice: longEntry,
              exitPrice: exitPrice,
              quantity: qty,
              grossPnl: isFinite(grossPnl) ? grossPnl : 0,
              fees: isFinite(fees) ? fees : 0,
              netPnl: isFinite(netPnl) ? netPnl : 0
            });
            await historyRecord.save();
            console.log(`🛡️ LONG Stop-Loss executed. Realized Net PnL: $${netPnl.toFixed(4)}. Opposing SHORT remains active.`);
            
            dbRecord.longLeg.status = 'closed';
            dbRecord.longLeg.entryPrice = null;
            dbRecord.longLeg.dcaCount = 0;
            dbRecord.longLeg.lastDcaPrice = null;
            dbRecord.longLeg.unrealizedPnl = 0;
            dbRecord.longLeg.realizedPnl = netPnl;
            dbRecord.longLeg.stoppedOutAt = new Date(); // Enforce cooldown
            await dbRecord.save();
            longPos = null;
          } catch (slErr) {
            console.error(`❌ Failed to execute LONG stop loss:`, slErr.message);
          }
        }

        // --- DCA LOGIC ---
        if (!longSlTriggered && longPos) {
          const longAnchorPrice = dbRecord.longLeg.lastDcaPrice || dbRecord.longLeg.entryPrice;
          const isLongDcaPriceMet = longAnchorPrice > 0 && currentPrice <= longAnchorPrice * (1 - effectiveGridPercent);

          if (tradingEnabled && canOpenNewPosition && currentLongDca < maxDcaLayers && isLongDcaPriceMet) {
            console.log(`📉 Price dropped below grid! DCA LONG leg (Layer ${currentLongDca + 1}/${maxDcaLayers})...`);
            try {
              const verifyPositions = await binanceService.fetchOpenPositions(symbol);
              const verifyLong = verifyPositions.find(p => (p.info?.positionSide === 'LONG') || (p.side === 'long'));
              if (verifyLong && Math.abs(parseFloat(verifyLong.contracts)) > 0) {
                const freeMargin = await binanceService.getBalance();
                const requiredMargin = (quantityRaw * currentPrice) / leverage;
                if (freeMargin < requiredMargin * 1.05) {
                  console.warn(`⚠️ DCA LONG skipped: Free margin ($${freeMargin.toFixed(2)}) is below required margin ($${requiredMargin.toFixed(2)}).`);
                } else {
                  const dcaOrder = await binanceService.placeHedgeOrder(symbol, 'BUY', 'LONG', quantityRaw, 'MARKET');
                  const fillPrice = dcaOrder?.average || dcaOrder?.price || currentPrice;
                  
                  // PERSIST DCA STATE IMMEDIATELY to prevent duplicate entries on network latency
                  dbRecord.longLeg.dcaCount = currentLongDca + 1;
                  dbRecord.longLeg.lastDcaPrice = fillPrice;
                  await dbRecord.save();
                  
                  // Replace old Take-Profit order
                  try {
                    await binanceService.cancelOrdersBySide(symbol, 'LONG');
                    const updatedPositions = await binanceService.fetchOpenPositions(symbol);
                    const updatedLong = updatedPositions.find(p => (p.info?.positionSide === 'LONG') || (p.side === 'long'));
                    if (updatedLong && Math.abs(parseFloat(updatedLong.contracts)) > 0) {
                      const newEntry = parseFloat(updatedLong.info?.entryPrice || updatedLong.entryPrice);
                      const newQty = Math.abs(parseFloat(updatedLong.contracts));
                      const newTpPrice = Math.max(newEntry * (1 + effectiveGridPercent), currentPrice * 1.0005);
                      dbRecord.longLeg.entryPrice = newEntry;
                      dbRecord.longLeg.quantity = newQty;
                      dbRecord.longLeg.takeProfitPrice = newTpPrice;
                      this.lastAppliedLongGrid = effectiveGridPercent;
                      await binanceService.placeHedgeOrder(symbol, 'SELL', 'LONG', newQty, 'LIMIT', newTpPrice);
                      await dbRecord.save();
                    }
                  } catch (tpErr) {
                    console.warn(`⚠️ DCA TP placement deferred to self-healing:`, tpErr.message);
                  }
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
          dbRecord.longLeg.unrealizedPnl = calculateNetPnl(longPos.info?.unRealizedProfit, parseFloat(longPos.info?.entryPrice || longPos.entryPrice), Math.abs(parseFloat(longPos.contracts)));
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

        // Stop-Loss Cooldown Guard: Prevents immediate knife-catching re-entry
        const shortCooldownRemaining = dbRecord.shortLeg?.stoppedOutAt 
          ? Math.max(0, STOP_LOSS_COOLDOWN_MS - (Date.now() - new Date(dbRecord.shortLeg.stoppedOutAt).getTime()))
          : 0;

        if (shortCooldownRemaining > 0) {
          console.log(`⏳ SHORT leg is in Stop-Loss Cooldown (${Math.ceil(shortCooldownRemaining / 1000)}s left). Holding off re-entry.`);
        } else if (tradingEnabled && canOpenNewPosition) {
          const existingShortSell = openOrders.find(o => o.info && o.info.positionSide === 'SHORT' && o.info.side === 'SELL' && (o.type && o.type.toLowerCase() === 'limit'));
          const prevEntry = dbRecord.shortLeg?.entryPrice;

          if (existingShortSell) {
            // Trend Breakout Check: If price dumped <= 1.5x grid spacing below reload price, advance grid
            if (prevEntry && currentPrice <= prevEntry * (1 - effectiveGridPercent * 1.5)) {
              console.log(`🚀 SHORT Trend Breakout! Cancelling resting reload limit to advance grid...`);
              await binanceService.cancelOrdersBySide(symbol, 'SHORT');
              await this.executeMarketEntry('SHORT', symbol, quantityRaw, currentPrice, effectiveGridPercent, dbRecord);
            }
          } else if (prevEntry && currentPrice <= prevEntry * (1 - effectiveGridPercent * 1.5)) {
            console.log(`🚀 SHORT Trend Breakout! Advancing grid immediately to current price...`);
            await this.executeMarketEntry('SHORT', symbol, quantityRaw, currentPrice, effectiveGridPercent, dbRecord);
          } else if (prevEntry && currentPrice < prevEntry) {
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
        // ALWAYS self-heal entry price and quantity to exactly match the exchange!
        dbRecord.shortLeg.entryPrice = parseFloat(shortPos.info?.entryPrice || shortPos.entryPrice);
        dbRecord.shortLeg.quantity = Math.abs(parseFloat(shortPos.contracts));
        
        if (dbRecord.shortLeg.status !== 'open') {
           dbRecord.shortLeg.status = 'open';
           const entryPrice = parseFloat(shortPos.info?.entryPrice || shortPos.entryPrice);
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
           // Dynamic Grid Updating
           const expectedTp = parseFloat(shortPos.info?.entryPrice || shortPos.entryPrice) * (1 - effectiveGridPercent);
           const lastGrid = this.lastAppliedShortGrid || effectiveGridPercent;
           const gridShift = Math.abs(effectiveGridPercent - lastGrid) / lastGrid;
           const threshold = (this.settings.useDynamicGrid !== false) ? 0.15 : 0.0001;
           const deviation = (this.settings.useDynamicGrid !== false) ? gridShift : Math.abs(dbRecord.shortLeg.takeProfitPrice - expectedTp) / expectedTp;
           if (deviation > threshold && expectedTp > 0) {
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
        
        // --- POSITION STOP-LOSS GUARD ---
        const stopLossPercent = this.settings.stopLossPercentage ?? 0.05;
        const currentShortDca = dbRecord.shortLeg.dcaCount || 0;
        let shortSlTriggered = false;
        const shortEntry = dbRecord.shortLeg.entryPrice;
        const isShortSlBreached = stopLossPercent > 0 && shortEntry > 0 && currentPrice >= shortEntry * (1 + stopLossPercent);

        if (stopLossPercent > 0 && isShortSlBreached) {
          const shortSlPrice = shortEntry * (1 + stopLossPercent);
          shortSlTriggered = true;
          console.warn(`🚨 STOP-LOSS TRIGGERED FOR SHORT LEG! Current: $${currentPrice}, SL: $${shortSlPrice.toFixed(4)} (+${(stopLossPercent * 100).toFixed(1)}%)`);
          try {
            await binanceService.cancelOrdersBySide(symbol, 'SHORT');
            const closeOrder = await binanceService.placeHedgeOrder(symbol, 'BUY', 'SHORT', Math.abs(parseFloat(shortPos.contracts)), 'MARKET');
            const exitPrice = closeOrder?.average || closeOrder?.price || currentPrice;
            
            const qty = Math.abs(parseFloat(shortPos.contracts));
            const grossPnl = (shortEntry - exitPrice) * qty;
            const fees = (shortEntry * qty * 0.0005) + (exitPrice * qty * 0.0005);
            const netPnl = grossPnl - fees;
            
            const historyRecord = new TradeHistory({
              symbol: symbol,
              side: 'SHORT',
              entryPrice: shortEntry,
              exitPrice: exitPrice,
              quantity: qty,
              grossPnl: isFinite(grossPnl) ? grossPnl : 0,
              fees: isFinite(fees) ? fees : 0,
              netPnl: isFinite(netPnl) ? netPnl : 0
            });
            await historyRecord.save();
            console.log(`🛡️ SHORT Stop-Loss executed. Realized Net PnL: $${netPnl.toFixed(4)}. Opposing LONG remains active.`);
            
            dbRecord.shortLeg.status = 'closed';
            dbRecord.shortLeg.entryPrice = null;
            dbRecord.shortLeg.dcaCount = 0;
            dbRecord.shortLeg.lastDcaPrice = null;
            dbRecord.shortLeg.unrealizedPnl = 0;
            dbRecord.shortLeg.realizedPnl = netPnl;
            dbRecord.shortLeg.stoppedOutAt = new Date(); // Enforce cooldown
            await dbRecord.save();
            shortPos = null;
          } catch (slErr) {
            console.error(`❌ Failed to execute SHORT stop loss:`, slErr.message);
          }
        }

        // --- DCA LOGIC ---
        if (!shortSlTriggered && shortPos) {
          const shortAnchorPrice = dbRecord.shortLeg.lastDcaPrice || dbRecord.shortLeg.entryPrice;
          const isShortDcaPriceMet = shortAnchorPrice > 0 && currentPrice >= shortAnchorPrice * (1 + effectiveGridPercent);

          if (tradingEnabled && canOpenNewPosition && currentShortDca < maxDcaLayers && isShortDcaPriceMet) {
            console.log(`📈 Price pumped above grid! DCA SHORT leg (Layer ${currentShortDca + 1}/${maxDcaLayers})...`);
            try {
              const verifyPositions = await binanceService.fetchOpenPositions(symbol);
              const verifyShort = verifyPositions.find(p => (p.info?.positionSide === 'SHORT') || (p.side === 'short'));
              if (verifyShort && Math.abs(parseFloat(verifyShort.contracts)) > 0) {
                const freeMargin = await binanceService.getBalance();
                const requiredMargin = (quantityRaw * currentPrice) / leverage;
                if (freeMargin < requiredMargin * 1.05) {
                  console.warn(`⚠️ DCA SHORT skipped: Free margin ($${freeMargin.toFixed(2)}) is below required margin ($${requiredMargin.toFixed(2)}).`);
                } else {
                  const dcaOrder = await binanceService.placeHedgeOrder(symbol, 'SELL', 'SHORT', quantityRaw, 'MARKET');
                  const fillPrice = dcaOrder?.average || dcaOrder?.price || currentPrice;
                  
                  // PERSIST DCA STATE IMMEDIATELY to prevent duplicate entries on network latency
                  dbRecord.shortLeg.dcaCount = currentShortDca + 1;
                  dbRecord.shortLeg.lastDcaPrice = fillPrice;
                  await dbRecord.save();
                  
                  // Replace old Take-Profit order
                  try {
                    await binanceService.cancelOrdersBySide(symbol, 'SHORT');
                    const updatedPositions = await binanceService.fetchOpenPositions(symbol);
                    const updatedShort = updatedPositions.find(p => (p.info?.positionSide === 'SHORT') || (p.side === 'short'));
                    if (updatedShort && Math.abs(parseFloat(updatedShort.contracts)) > 0) {
                      const newEntry = parseFloat(updatedShort.info?.entryPrice || updatedShort.entryPrice);
                      const newQty = Math.abs(parseFloat(updatedShort.contracts));
                      const newTpPrice = Math.min(newEntry * (1 - effectiveGridPercent), currentPrice * 0.9995);
                      dbRecord.shortLeg.entryPrice = newEntry;
                      dbRecord.shortLeg.quantity = newQty;
                      dbRecord.shortLeg.takeProfitPrice = newTpPrice;
                      this.lastAppliedShortGrid = effectiveGridPercent;
                      await binanceService.placeHedgeOrder(symbol, 'BUY', 'SHORT', newQty, 'LIMIT', newTpPrice);
                      await dbRecord.save();
                    }
                  } catch (tpErr) {
                    console.warn(`⚠️ DCA TP placement deferred to self-healing:`, tpErr.message);
                  }
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
          dbRecord.shortLeg.unrealizedPnl = calculateNetPnl(shortPos.info?.unRealizedProfit, parseFloat(shortPos.info?.entryPrice || shortPos.entryPrice), Math.abs(parseFloat(shortPos.contracts)));
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
