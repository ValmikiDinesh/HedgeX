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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());

async function startBot() {
  console.log('🤖 Initializing AI Hedge Bot...');
  
  try {
    // 1. Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // 2. Initialize Binance Hedge Mode
    await binanceService.initializeHedgeMode();

    console.log('✅ Bot Initialized successfully. Starting Grid Loop...');

    // 3. Connect Socket.io to MarketAgent price ticks (Throttled to save memory/CPU)
    let lastEmitTime = 0;
    marketAgent.on('price_tick', (price) => {
      const now = Date.now();
      if (now - lastEmitTime > 150) { // Max ~6 updates per second to the browser
        io.emit('price_update', price);
        lastEmitTime = now;
      }
    });

    // 4. Start the continuous Grid Loop
    setInterval(async () => {
      await gridStrategyAgent.runGridLoop();
    }, 10000);

    // 4. Start the Dashboard API Server
    app.get('/api/status', async (req, res) => {
      try {
        const balanceObj = await binanceService.exchange.fetchBalance();
        const balance = balanceObj?.USDT?.free || 0;
        const marginInfo = balanceObj?.info || {};
        const totalMarginBalance = parseFloat(marginInfo.totalMarginBalance || 0);
        const totalMaintMargin = parseFloat(marginInfo.totalMaintMargin || 0);
        const marginRatio = totalMarginBalance > 0 ? ((totalMaintMargin / totalMarginBalance) * 100) : 0;
        res.json({ balance, marginRatio: marginRatio.toFixed(2) });
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch status' });
      }
    });

    app.get('/api/grid', async (req, res) => {
      try {
        const settings = await BotSettings.findOne({ singletonId: 'default_settings' }) || new BotSettings();
        
        // Fetch active DB positions
        const activeGrids = await HedgePosition.find({ status: 'active' }).sort({ createdAt: -1 });
        
        // Fetch live exchange data using dynamic symbol
        const positions = await binanceService.fetchOpenPositions(settings.symbol);
        const longPos = positions.find(p => p.info.positionSide === 'LONG');
        const shortPos = positions.find(p => p.info.positionSide === 'SHORT');
        
        // Fetch current live price
        const livePrice = await marketAgent.getCurrentPrice(settings.symbol);
        
        const calculateBreakdown = (pos, currentPrice) => {
          if (!pos) return null;
          const entryPrice = parseFloat(pos.info.entryPrice);
          const safePrice = currentPrice || entryPrice; // Fix: Fallback to prevent NaN
          const qty = Math.abs(parseFloat(pos.contracts));
          const grossPnl = parseFloat(pos.info.unRealizedProfit || 0);
          
          // Taker fee on entry (0.05%) + Maker fee on limit exit (0.02%)
          const fees = qty * ((entryPrice * 0.0005) + (safePrice * 0.0002));
          const netPnl = grossPnl - fees;
          
          return {
            contracts: pos.contracts,
            grossPnl: grossPnl.toFixed(4),
            fees: fees.toFixed(4),
            netPnl: netPnl.toFixed(4)
          };
        };

        res.json({
          dbGrids: activeGrids,
          livePrice: livePrice,
          livePositions: {
            long: calculateBreakdown(longPos, livePrice),
            short: calculateBreakdown(shortPos, livePrice)
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

    let isUpdatingSettings = false; // Mutex Lock to prevent Double-Close Bug
    app.post('/api/settings', async (req, res) => {
      if (isUpdatingSettings) return res.status(429).json({ error: 'Settings update in progress. Please wait.' });
      isUpdatingSettings = true;
      try {
        const updates = req.body;
        delete updates.singletonId; // SECURITY FIX: Prevent singleton prototype pollution
        if (updates.symbol) updates.symbol = updates.symbol.toUpperCase(); // Prevent CCXT crash
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

        let settings = await BotSettings.findOne({ singletonId: 'default_settings' });
        if (!settings) {
          settings = new BotSettings(updates);
        } else {
          // Detect Symbol Swap: Panic Close old symbol before accepting new one
          if (updates.symbol && updates.symbol !== settings.symbol) {
             console.log(`⚠️ Symbol changing from ${settings.symbol} to ${updates.symbol}. Panic closing old positions...`);
             await riskManager.panicCloseAll(settings.symbol);
             // Flag old HedgePosition as closed so the bot abandons it safely
             try {
               await HedgePosition.updateMany({ symbol: settings.symbol, status: 'active' }, { $set: { status: 'closed' } });
             } catch (e) {
               console.error('Failed to mark old positions closed during symbol swap', e);
             }
          }
          settings.set(updates);
        }
        await settings.save();
        res.json(settings);
      } catch (err) {
        res.status(500).json({ error: 'Failed to update settings' });
      } finally {
        isUpdatingSettings = false; // Release Mutex
      }
    });

    app.get('/api/history', async (req, res) => {
      try {
        const history = await TradeHistory.find().sort({ closedAt: -1 }).limit(50);
        res.json(history);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch trade history' });
      }
    });

    // 5. Serve React Frontend Statically (Production)
    app.use(express.static(path.join(__dirname, 'client/dist')));
    
    // Fallback for React Router
    app.use((req, res) => {
      res.sendFile(path.join(__dirname, 'client/dist', 'index.html'));
    });

    const PORT = process.env.PORT || 4000;
    server.listen(PORT, () => {
      console.log(`✅ Server running on http://localhost:${PORT}`);
    });

  } catch (err) {
    console.error('❌ Fatal Bot Error:', err.message);
    process.exit(1);
  }
}

startBot();
