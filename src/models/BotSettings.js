import mongoose from 'mongoose';

const botSettingsSchema = new mongoose.Schema({
  // Use a singleton pattern by hardcoding an ID
  singletonId: { type: String, default: 'default_settings', unique: true },
  
  symbol: { type: String, default: 'DOGEUSDT' },
  gridPercentage: { type: Number, default: 0.015 }, // 1.5%
  positionPercentage: { type: Number, default: 0.20 }, // 20%
  leverage: { type: Number, default: 10 },
  tradingEnabled: { type: Boolean, default: true }, // UI Killswitch
  
  // Round 6: Dynamic Grid Settings
  useDynamicGrid: { type: Boolean, default: true },
  minGridPercentage: { type: Number, default: 0.0035 }, // 0.35% (above fee floor)
  maxGridPercentage: { type: Number, default: 0.035 }, // 3.5%
  maxDcaLayers: { type: Number, default: 3 }, // Max DCA entries per side
  
  // Round 7: Position Stop Loss
  stopLossPercentage: { type: Number, default: 0.05 }, // 5.0% Stop Loss per leg (0 to disable)
  
  updatedAt: { type: Date, default: Date.now }
});

export default mongoose.model('BotSettings', botSettingsSchema);
