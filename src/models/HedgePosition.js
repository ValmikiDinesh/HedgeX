import mongoose from 'mongoose';

const legSchema = new mongoose.Schema({
  exchangeOrderId: { type: String },
  status: { type: String, enum: ['pending', 'open', 'closed'], default: 'pending' },
  entryPrice: { type: Number },
  quantity: { type: Number },
  takeProfitPrice: { type: Number },
  stopLossPrice: { type: Number },
  dcaCount: { type: Number, default: 0 },
  lastDcaPrice: { type: Number },
  reloadPrice: { type: Number },
  unrealizedPnl: { type: Number, default: 0 },
  realizedPnl: { type: Number, default: 0 },
  stoppedOutAt: { type: Date }
});

const hedgePositionSchema = new mongoose.Schema({
  symbol: { type: String, required: true, index: true },
  status: { type: String, enum: ['active', 'closed'], default: 'active', index: true },
  gridLevel: { type: Number, default: 1 },
  
  // The two opposing legs of the hedge
  longLeg: { type: legSchema, default: () => ({}) },
  shortLeg: { type: legSchema, default: () => ({}) },

  totalRealizedPnl: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

export default mongoose.model('HedgePosition', hedgePositionSchema);
