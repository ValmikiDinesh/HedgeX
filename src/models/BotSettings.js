import mongoose from 'mongoose';

const botSettingsSchema = new mongoose.Schema({
  // Use a singleton pattern by hardcoding an ID
  singletonId: { type: String, default: 'default_settings', unique: true },
  
  symbol: { type: String, default: 'DOGEUSDT' },
  gridPercentage: { type: Number, default: 0.015 }, // 1.5%
  positionPercentage: { type: Number, default: 0.20 }, // 20%
  leverage: { type: Number, default: 10 },
  tradingEnabled: { type: Boolean, default: true }, // UI Killswitch
  
  updatedAt: { type: Date, default: Date.now }
});

export default mongoose.model('BotSettings', botSettingsSchema);
