import mongoose from 'mongoose';

const legSchema = new mongoose.Schema({
  exchangeOrderId: { type: String, default: null },
  status: { type: String, enum: ['pending', 'open', 'closed'], default: 'pending' },
  entryPrice: { type: Number, default: null },
  quantity: { type: Number, default: null },
  takeProfitPrice: { type: Number, default: null },
  stopLossPrice: { type: Number, default: null },
  dcaCount: { type: Number, default: 0 },
  lastDcaPrice: { type: Number, default: null },
  reloadPrice: { type: Number, default: null },
  unrealizedPnl: { type: Number, default: 0 },
  realizedPnl: { type: Number, default: 0 },
  stoppedOutAt: { type: Date, default: null }
}, { _id: false });

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

// Compound index for optimal active grid lookups and race prevention
hedgePositionSchema.index({ symbol: 1, status: 1 });
hedgePositionSchema.index({ createdAt: -1 });

export default mongoose.model('HedgePosition', hedgePositionSchema);
