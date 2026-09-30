import React from 'react';
import { TrendingUp, TrendingDown, Clock, Layers, DollarSign } from 'lucide-react';

const GridLegCard = ({ side, position, symbol, maxDcaLayers = 3 }) => {
  const isLong = side === 'LONG';
  const isActive = position !== null && Math.abs(parseFloat(position.contracts || 0)) > 0;
  
  const Icon = isLong ? TrendingUp : TrendingDown;
  const pnl = isActive ? (parseFloat(position.netPnl) || 0) : 0;
  const isProfit = pnl >= 0;
  const dcaCount = position?.dcaCount || 0;
  const grossPnl = isActive ? (parseFloat(position.grossPnl) || 0) : 0;
  const fees = isActive ? Math.abs(parseFloat(position.fees) || 0) : 0;

  const formatPrice = (p) => {
    if (!p || isNaN(p) || parseFloat(p) <= 0) return '0.00';
    const num = parseFloat(p);
    if (num >= 1000) return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (num >= 1) return `$${num.toFixed(4)}`;
    if (num >= 0.01) return `$${num.toFixed(5)}`;
    return `$${num.toFixed(7)}`;
  };

  return (
    <div className={`leg-card ${isLong ? 'long' : 'short'}`}>
      <div className="card-header">
        <div className="card-title">
          <Icon size={22} color={isLong ? 'var(--profit-green)' : 'var(--loss-red)'} />
          <span>{side} LEG</span>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {isActive && (
            <span className={`badge ${dcaCount > 0 ? 'warning' : 'safe'}`}>
              DCA: {dcaCount}/{maxDcaLayers}
            </span>
          )}
          <span className={`badge ${isActive ? 'active' : 'inactive'}`}>
            {isActive ? 'ACTIVE' : 'WAITING'}
          </span>
        </div>
      </div>

      <div className="card-body">
        <div className="data-row">
          <span className="data-label">Asset Pair</span>
          <span className="data-value">{symbol}</span>
        </div>
        
        {isActive ? (
          <>
            <div className="data-row">
              <span className="data-label">Avg. Entry Price</span>
              <span className="data-value">{formatPrice(position.entryPrice)}</span>
            </div>

            {position.takeProfitPrice && (
              <div className="data-row">
                <span className="data-label">Take Profit Target</span>
                <span className="data-value" style={{ color: 'var(--profit-green)', fontWeight: '600' }}>
                  {formatPrice(position.takeProfitPrice)}
                </span>
              </div>
            )}

            {position.stopLossPrice && (
              <div className="data-row">
                <span className="data-label">Stop-Loss Guard</span>
                <span className="data-value" style={{ color: 'var(--loss-red)', fontWeight: '600' }}>
                  {formatPrice(position.stopLossPrice)}
                </span>
              </div>
            )}

            {position.lastDcaPrice && (
              <div className="data-row">
                <span className="data-label">Last DCA Price</span>
                <span className="data-value">{formatPrice(position.lastDcaPrice)}</span>
              </div>
            )}

            <div className="data-row">
              <span className="data-label">Position Size</span>
              <span className="data-value">{Math.abs(parseFloat(position.contracts || 0))} Contracts</span>
            </div>
            
            <div style={{ 
              marginTop: '1.25rem', 
              padding: '1rem', 
              background: 'rgba(15, 20, 31, 0.75)', 
              borderRadius: '12px',
              border: '1px solid var(--border-color)'
            }}>
              <div className="data-row" style={{ padding: '0.35rem 0' }}>
                <span className="data-label">Gross Unrealized PnL</span>
                <span className="data-value" style={{ color: grossPnl >= 0 ? 'var(--profit-green)' : 'var(--loss-red)' }}>
                  {grossPnl >= 0 ? '+' : ''}{grossPnl.toFixed(4)} USDT
                </span>
              </div>
              
              <div className="data-row" style={{ padding: '0.35rem 0' }}>
                <span className="data-label">Estimated Round-trip Fees</span>
                <span className="data-value" style={{ color: 'var(--loss-red)' }}>
                  -{fees.toFixed(4)} USDT
                </span>
              </div>
              
              <div className="data-row" style={{ marginTop: '0.5rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border-color)' }}>
                <span className="data-label" style={{ fontWeight: '700', color: 'var(--text-primary)' }}>Net PnL</span>
                <span className="data-value" style={{ fontWeight: '800', fontSize: '1.15rem', color: isProfit ? 'var(--profit-green)' : 'var(--loss-red)' }}>
                  {isProfit ? '+' : ''}{pnl.toFixed(4)} USDT
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state" style={{ padding: '2.5rem 1rem', marginTop: '1rem' }}>
            <Clock className="empty-icon" size={32} style={{ margin: '0 auto' }} />
            <p style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>Waiting for Market Entry Trigger...</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default GridLegCard;
