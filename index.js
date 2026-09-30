import mongoose from 'mongoose';
import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import binanceService from './src/services/BinanceService.js';
import gridStrategyAgent from './src/agents/GridStrategyAgent.js';
import marketAgent from './src/agents/MarketAgent.js';
import riskManager from './src/agents/RiskManager.js';
import HedgePosition from './src/models/HedgePosition.js';
import BotSettings from './src/models/BotSettings.js';
import TradeHistory from './src/models/TradeHistory.js';

dotenv.config();

// Process Exception Handlers to prevent abrupt server crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err.message, err.stack);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());

// 1. Dashboard API Routes
app.get('/api/status', async (req, res) => {
  try {
    let balance = 0;
    let marginRatio = 0;
    try {
      const balanceObj = await binanceService.exchange.fetchBalance();
      balance = parseFloat(balanceObj?.USDT?.free || 0);
      const marginInfo = balanceObj?.info || {};
      const totalMarginBalance = parseFloat(marginInfo.totalMarginBalance || balanceObj?.USDT?.total || 0);
      const totalMaintMargin = parseFloat(marginInfo.totalMaintMargin || 0);
      if (totalMarginBalance > 0) {
        marginRatio = (totalMaintMargin / totalMarginBalance) * 100;
      } else if (totalMaintMargin > 0) {
        marginRatio = 100.0;
      }
    } catch (apiErr) {
      // Binance API might be disconnected, IP restricted, or unconfigured
    }

    let totalRealizedPnl = 0;
    try {
      const totalPnlAgg = await TradeHistory.aggregate([
        { $group: { _id: null, totalNetPnl: { $sum: '$netPnl' } } }
      ]);
      totalRealizedPnl = totalPnlAgg[0]?.totalNetPnl || 0;
    } catch (dbErr) {}

    const safeMarginRatio = isFinite(marginRatio) ? parseFloat(marginRatio.toFixed(2)) : 0;
    const safeRealizedPnl = isFinite(totalRealizedPnl) ? parseFloat(parseFloat(totalRealizedPnl).toFixed(4)) : 0;

    res.json({ 
      balance: isFinite(balance) ? parseFloat(balance.toFixed(2)) : 0, 
      marginRatio: safeMarginRatio,
      totalRealizedPnl: safeRealizedPnl
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

app.get('/api/grid', async (req, res) => {
  try {
    const settings = await BotSettings.findOne({ singletonId: 'default_settings' }) || new BotSettings();
    const rawSymbol = binanceService.toRawSymbol(settings.symbol);
    const activeGrids = await HedgePosition.find({ status: 'active' }).sort({ createdAt: -1 });
    
    let positions = [];
    let livePrice = null;
    try {
      positions = await binanceService.fetchOpenPositions(rawSymbol);
      livePrice = await marketAgent.getCurrentPrice(rawSymbol);
    } catch (apiErr) {}

    const longPos = positions.find(p => (p.info?.positionSide === 'LONG') || (p.side === 'long'));
    const shortPos = positions.find(p => (p.info?.positionSide === 'SHORT') || (p.side === 'short'));
    const activeGrid = activeGrids.find(g => binanceService.toRawSymbol(g.symbol) === rawSymbol);

    const calculateBreakdown = (pos, currentPrice, legDb) => {
      if (!pos) return null;
      const entryPrice = parseFloat(pos.info?.entryPrice || pos.entryPrice || 0);
      const safePrice = (currentPrice && currentPrice > 0) ? currentPrice : entryPrice;
      const qty = Math.abs(parseFloat(pos.contracts || 0));
      const rawGrossPnl = parseFloat(pos.info?.unRealizedProfit || pos.unrealizedPnl || 0);
      const grossPnl = Math.abs(rawGrossPnl) < 0.00001 ? 0 : rawGrossPnl;
      
      const fees = qty * ((entryPrice * 0.0005) + (safePrice * 0.0002));
      const rawNetPnl = grossPnl - fees;
      const netPnl = Math.abs(rawNetPnl) < 0.00001 ? 0 : rawNetPnl;
      
      return {
        contracts: qty,
        entryPrice: entryPrice,
        dcaCount: legDb?.dcaCount || 0,
        lastDcaPrice: legDb?.lastDcaPrice || null,
        grossPnl: isFinite(grossPnl) ? grossPnl.toFixed(4) : "0.0000",
        fees: isFinite(fees) ? fees.toFixed(4) : "0.0000",
        netPnl: isFinite(netPnl) ? netPnl.toFixed(4) : "0.0000"
      };
    };

    res.json({
      dbGrids: activeGrids,
      livePrice: livePrice,
      livePositions: {
        long: calculateBreakdown(longPos, livePrice, activeGrid?.longLeg),
        short: calculateBreakdown(shortPos, livePrice, activeGrid?.shortLeg)
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch grid data' });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const settings = await BotSettings.findOne({ singletonId: 'default_settings' }) || new BotSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

let isUpdatingSettings = false;
app.post('/api/settings', async (req, res) => {
  if (isUpdatingSettings) return res.status(429).json({ error: 'Settings update in progress. Please wait.' });
  isUpdatingSettings = true;
  try {
    const updates = req.body;
    delete updates.singletonId;
    if (updates.symbol) {
      updates.symbol = binanceService.toRawSymbol(updates.symbol);
    }
    if (updates.gridPercentage !== undefined) {
      updates.gridPercentage = parseFloat(updates.gridPercentage);
      if (isNaN(updates.gridPercentage) || updates.gridPercentage < 0.001 || updates.gridPercentage > 0.50) return res.status(400).json({ error: 'Grid profit target must be between 0.1% and 50%' });
    }
    if (updates.positionPercentage !== undefined) {
      updates.positionPercentage = parseFloat(updates.positionPercentage);
      if (isNaN(updates.positionPercentage) || updates.positionPercentage < 0.01 || updates.positionPercentage > 0.50) return res.status(400).json({ error: 'Position size must be between 1% and 50%' });
    }
    if (updates.leverage !== undefined) {
      updates.leverage = parseInt(updates.leverage);
      if (isNaN(updates.leverage) || updates.leverage < 1 || updates.leverage > 125) return res.status(400).json({ error: 'Leverage must be between 1x and 125x' });
    }
    if (updates.tradingEnabled !== undefined) {
      updates.tradingEnabled = Boolean(updates.tradingEnabled);
    }
    if (updates.useDynamicGrid !== undefined) {
      updates.useDynamicGrid = Boolean(updates.useDynamicGrid);
    }
    if (updates.minGridPercentage !== undefined) {
      updates.minGridPercentage = parseFloat(updates.minGridPercentage);
      if (isNaN(updates.minGridPercentage) || updates.minGridPercentage < 0.001 || updates.minGridPercentage > 0.10) return res.status(400).json({ error: 'Min grid must be between 0.1% and 10%' });
    }
    if (updates.maxGridPercentage !== undefined) {
      updates.maxGridPercentage = parseFloat(updates.maxGridPercentage);
      if (isNaN(updates.maxGridPercentage) || updates.maxGridPercentage < 0.005 || updates.maxGridPercentage > 0.50) return res.status(400).json({ error: 'Max grid must be between 0.5% and 50%' });
    }
    if (updates.maxDcaLayers !== undefined) {
      updates.maxDcaLayers = parseInt(updates.maxDcaLayers);
      if (isNaN(updates.maxDcaLayers) || updates.maxDcaLayers < 0 || updates.maxDcaLayers > 10) return res.status(400).json({ error: 'Max DCA layers must be between 0 and 10' });
    }
    if (updates.stopLossPercentage !== undefined) {
      updates.stopLossPercentage = parseFloat(updates.stopLossPercentage);
      if (isNaN(updates.stopLossPercentage) || updates.stopLossPercentage < 0 || updates.stopLossPercentage > 0.50) {
        return res.status(400).json({ error: 'Stop loss percentage must be between 0 (disabled) and 50%' });
      }
    }

    let settings = await BotSettings.findOne({ singletonId: 'default_settings' });
    if (!settings) {
      settings = new BotSettings(updates);
    } else {
      if (updates.symbol && updates.symbol !== settings.symbol) {
        console.log(`⚠️ Symbol changing from ${settings.symbol} to ${updates.symbol}. Panic closing old positions...`);
        try {
          await riskManager.panicCloseAll(settings.symbol);
        } catch (e) {
          console.error('Error closing positions during symbol swap:', e.message);
        }
        try {
          await HedgePosition.updateMany(
            { symbol: settings.symbol, status: 'active' }, 
            { $set: { status: 'closed', 'longLeg.status': 'closed', 'shortLeg.status': 'closed' } }
          );
        } catch (e) {
          console.error('Failed to mark old positions closed during symbol swap', e);
        }
        gridStrategyAgent.currentSymbol = updates.symbol;
        gridStrategyAgent.lastAppliedLongGrid = null;
        gridStrategyAgent.lastAppliedShortGrid = null;
        marketAgent.startWatching(updates.symbol);
      }
      settings.set(updates);
    }
    await settings.save();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings' });
  } finally {
    isUpdatingSettings = false;
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const history = await TradeHistory.find().sort({ closedAt: -1 }).limit(50);
    res.json(Array.isArray(history) ? history : []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch trade history' });
  }
});

// 2. Serve React Frontend Statically (Production)
app.use(express.static(path.join(__dirname, 'client/dist')));

// Fallback for React Router
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'client/dist', 'index.html'));
});

// 3. Start the Dashboard HTTP Server immediately
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});

// 4. Initialize Bot Services (MongoDB, Binance, Strategy Loop)
async function startBot() {
  console.log('🤖 Initializing AI Hedge Bot...');
  
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');
  } catch (mongoErr) {
    console.error('❌ MongoDB Connection Error:', mongoErr.message);
    console.log('🔄 Will retry MongoDB connection in 5s...');
    setTimeout(startBot, 5000);
    return;
  }

  // Setup live price emitter
  let lastEmitTime = 0;
  marketAgent.on('price_tick', (price) => {
    const now = Date.now();
    if (now - lastEmitTime > 150) {
      io.emit('price_update', { symbol: marketAgent.currentSymbol, price });
      lastEmitTime = now;
    }
  });

  // Load settings to start watching symbol immediately
  try {
    const settings = await BotSettings.findOne({ singletonId: 'default_settings' }) || new BotSettings();
    if (!settings.isNew) {
      marketAgent.startWatching(settings.symbol);
    }
  } catch (_) {}

  // Initialize Binance Hedge Mode
  try {
    await binanceService.initializeHedgeMode();
    console.log('✅ Bot Initialized successfully with Binance Futures.');
  } catch (binanceErr) {
    console.error('⚠️ Binance Initialization Warning:', binanceErr.message);
    console.log('⚠️ Automated trading will run in monitoring/self-healing mode until Binance credentials/IP are verified.');
  }

  // Always start the Grid Loop interval regardless of initial transient errors
  gridStrategyAgent.runGridLoop().catch(err => console.error('Initial grid loop error:', err.message));
  setInterval(async () => {
    try {
      await gridStrategyAgent.runGridLoop();
    } catch (err) {
      console.error('Grid loop error:', err.message);
    }
  }, 10000);
}

startBot();

