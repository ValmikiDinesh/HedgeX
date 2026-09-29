import mongoose from 'mongoose';

const tradeHistorySchema = new mongoose.Schema({
  symbol: { type: String, required: true },
  side: { type: String, required: true, enum: ['LONG', 'SHORT'] },
  entryPrice: { type: Number, required: true },
  exitPrice: { type: Number, required: true },
  quantity: { type: Number, required: true },
  grossPnl: { type: Number, required: true },
  fees: { type: Number, required: true },
  netPnl: { type: Number, required: true },
  closedAt: { type: Date, default: Date.now, index: true }
});

tradeHistorySchema.index({ closedAt: -1 });

const TradeHistory = mongoose.model('TradeHistory', tradeHistorySchema);

export default TradeHistory;
