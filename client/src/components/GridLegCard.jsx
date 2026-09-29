import React from 'react';
import { TrendingUp, TrendingDown, Clock } from 'lucide-react';

const GridLegCard = ({ side, position, symbol, maxDcaLayers = 3 }) => {
  const isLong = side === 'LONG';
  const isActive = position !== null && Math.abs(parseFloat(position.contracts || 0)) > 0;
  
  const Icon = isLong ? TrendingUp : TrendingDown;
  const pnl = isActive ? parseFloat(position.netPnl) : 0;
  const isProfit = pnl >= 0;
  const dcaCount = position?.dcaCount || 0;

  return (
    <div className={`leg-card ${isLong ? 'long' : 'short'}`}>
      <div className="card-header">
        <div className="card-title">
          <Icon size={24} color={isLong ? 'var(--profit-green)' : 'var(--loss-red)'} />
          {side} LEG
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {isActive && (
            <span className={`badge ${dcaCount > 0 ? 'warning' : 'safe'}`} style={{ fontSize: '0.75rem' }}>
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
          <span className="data-label">Asset</span>
          <span className="data-value">{symbol}</span>
        </div>
        
        {isActive ? (
          <>
            <div className="data-row">
              <span className="data-label">Avg. Entry Price</span>
              <span className="data-value">${parseFloat(position.entryPrice || 0).toFixed(5)}</span>
            </div>

            {position.lastDcaPrice && (
              <div className="data-row">
                <span className="data-label">Last DCA Price</span>
                <span className="data-value">${parseFloat(position.lastDcaPrice).toFixed(5)}</span>
              </div>
            )}

            <div className="data-row">
              <span className="data-label">Size (Contracts)</span>
              <span className="data-value">{Math.abs(parseFloat(position.contracts || 0))}</span>
            </div>
            
            <div className="pnl-breakdown" style={{ marginTop: '1rem', padding: '1rem', background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>
              <div className="data-row" style={{ marginBottom: '8px' }}>
                <span className="data-label">Gross PnL</span>
                <span className="data-value" style={{ color: position.grossPnl >= 0 ? 'var(--profit-green)' : 'var(--loss-red)' }}>
                  {position.grossPnl >= 0 ? '+' : ''}{position.grossPnl} USDT
                </span>
              </div>
              
              <div className="data-row" style={{ marginBottom: '8px' }}>
                <span className="data-label">Est. Fees</span>
                <span className="data-value" style={{ color: 'var(--loss-red)' }}>
                  -{position.fees} USDT
                </span>
              </div>
              
              <div className="data-row" style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                <span className="data-label" style={{ fontWeight: 'bold' }}>Net PnL</span>
                <span className="data-value" style={{ fontWeight: 'bold', fontSize: '1.2rem', color: isProfit ? 'var(--profit-green)' : 'var(--loss-red)' }}>
                  {isProfit ? '+' : ''}{pnl.toFixed(4)} USDT
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state" style={{ padding: '2rem 1rem', marginTop: '1rem' }}>
            <Clock className="empty-icon" size={32} style={{ margin: '0 auto' }} />
            <p style={{ marginTop: '0.5rem', fontSize: '0.875rem' }}>Waiting for Grid Replenishment...</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default GridLegCard;
