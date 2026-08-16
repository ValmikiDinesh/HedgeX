import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { Activity, Wallet, ShieldAlert, Bot, Settings, X } from 'lucide-react';
import GridLegCard from './components/GridLegCard';
import './index.css';

function App() {
  const [status, setStatus] = useState({ balance: 0, marginRatio: 0 });
  const [gridData, setGridData] = useState({ livePositions: { long: null, short: null }, livePrice: null });
  const [tradeHistory, setTradeHistory] = useState([]);
  const [settings, setSettings] = useState({ symbol: 'DOGEUSDT', gridPercentage: 0.015, positionPercentage: 0.20, leverage: 10, tradingEnabled: true });
  const [loading, setLoading] = useState(true);
  
  // Modal State
  const [showSettings, setShowSettings] = useState(false);
  const [formData, setFormData] = useState({ 
    ...settings,
    gridPercentage: settings.gridPercentage * 100,
    positionPercentage: settings.positionPercentage * 100
  });
  const [saving, setSaving] = useState(false);

  const fetchData = async () => {
    try {
      const [statusRes, gridRes, settingsRes, historyRes] = await Promise.all([
        axios.get('/api/status'),
        axios.get('/api/grid'),
        axios.get('/api/settings'),
        axios.get('/api/history')
      ]);
      setStatus(statusRes.data);
      // Only update grid positions from REST, leave livePrice to be handled by WebSocket or fallback
      setGridData(prev => ({
        ...gridRes.data,
        livePrice: prev.livePrice || gridRes.data.livePrice
      }));
      setTradeHistory(historyRes.data);
      
      // Only update local settings if modal is not open to avoid overwriting user input
      if (!showSettings) {
        setSettings(settingsRes.data);
        setFormData({
          ...settingsRes.data,
          gridPercentage: parseFloat((settingsRes.data.gridPercentage * 100).toFixed(4)),
          positionPercentage: parseFloat((settingsRes.data.positionPercentage * 100).toFixed(4))
        });
      }
      setLoading(false);
    } catch (error) {
      console.error("Error fetching dashboard data:", error);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, [showSettings]);

  useEffect(() => {
    const socket = io();
    socket.on('price_update', (price) => {
      setGridData(prev => ({ ...prev, livePrice: price }));
    });
    return () => socket.disconnect();
  }, []);

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...formData,
        gridPercentage: formData.gridPercentage / 100,
        positionPercentage: formData.positionPercentage / 100
      };
      await axios.post('/api/settings', payload);
      setShowSettings(false);
      fetchData(); // Refresh UI
    } catch (err) {
      console.error(err);
      alert('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const isMarginSafe = status.marginRatio < 80;

  return (
    <div className="app-container">
      <header className="dashboard-header">
        <div className="header-title">
          <Bot className="icon-spin" size={32} />
          AI Hedge Bot
        </div>
        
        <div className="stats-container">
          <div className="stat-pill">
            <span className="stat-label">Live Price:</span>
            <span className="stat-value" style={{color: "var(--text-primary)"}}>
              {gridData.livePrice ? `$${parseFloat(gridData.livePrice).toFixed(5)}` : 'Loading...'}
            </span>
          </div>

          <div className="stat-pill">
            <Wallet size={16} className="stat-label" />
            <span className="stat-label">Balance:</span>
            <span className="stat-value">${parseFloat(status.balance).toFixed(2)}</span>
          </div>
          
          <div className="stat-pill">
            <ShieldAlert size={16} className={isMarginSafe ? 'stat-value safe' : 'stat-value danger'} />
            <span className="stat-label">Margin:</span>
            <span className={isMarginSafe ? 'stat-value safe' : 'stat-value danger'}>
              {status.marginRatio}%
            </span>
          </div>

          <button className="settings-btn" onClick={() => setShowSettings(true)}>
            <Settings size={20} />
          </button>
        </div>
      </header>

      <main>
        {loading ? (
          <div className="empty-state">
            <Activity className="empty-icon icon-spin" size={48} />
            <p>Connecting to Exchange...</p>
          </div>
        ) : (
          <div className="grid-container">
            <GridLegCard 
              side="LONG" 
              position={gridData.livePositions.long} 
              symbol={settings.symbol}
            />
            <GridLegCard 
              side="SHORT" 
              position={gridData.livePositions.short} 
              symbol={settings.symbol}
            />
          </div>
        )}

        {/* Trade History Section */}
        {!loading && (
          <div className="history-section">
            <h3 className="history-title">Recent Completed Trades</h3>
            {tradeHistory.length === 0 ? (
              <div className="empty-history">No completed trades yet.</div>
            ) : (
              <div className="table-responsive">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Asset</th>
                      <th>Side</th>
                      <th>Entry</th>
                      <th>Exit</th>
                      <th>Gross PnL</th>
                      <th>Net PnL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tradeHistory.map((trade, idx) => (
                      <tr key={idx}>
                        <td>{new Date(trade.closedAt).toLocaleTimeString()}</td>
                        <td>{trade.symbol}</td>
                        <td className={trade.side === 'LONG' ? 'text-green' : 'text-red'}>{trade.side}</td>
                        <td>${trade.entryPrice.toFixed(5)}</td>
                        <td>${trade.exitPrice.toFixed(5)}</td>
                        <td className={trade.grossPnl >= 0 ? 'text-green' : 'text-red'}>
                          {trade.grossPnl >= 0 ? '+' : ''}{trade.grossPnl.toFixed(4)}
                        </td>
                        <td className={trade.netPnl >= 0 ? 'text-green' : 'text-red'} style={{fontWeight: 'bold'}}>
                          {trade.netPnl >= 0 ? '+' : ''}{trade.netPnl.toFixed(4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Settings Modal */}
      {showSettings && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h2>Bot Configuration</h2>
              <button className="close-btn" onClick={() => setShowSettings(false)}>
                <X size={24} />
              </button>
            </div>
            
            <form onSubmit={handleSaveSettings}>
              <div className="form-group">
                <label>Trading Pair Symbol</label>
                <input 
                  type="text" 
                  value={formData.symbol} 
                  onChange={(e) => setFormData({...formData, symbol: e.target.value.toUpperCase()})}
                  placeholder="e.g. DOGEUSDT"
                  required
                />
                <small>WARNING: Changing this will panic-close active grids on the old coin.</small>
              </div>

              <div className="form-group">
                <label>Grid Profit Target (%)</label>
                <input 
                  type="number" 
                  step="0.001"
                  value={formData.gridPercentage} 
                  onChange={(e) => setFormData({...formData, gridPercentage: parseFloat(e.target.value)})}
                  required
                />
              </div>

              <div className="form-group">
                <label>Position Size (% of Capital)</label>
                <input 
                  type="number" 
                  step="0.1"
                  max="50"
                  value={formData.positionPercentage} 
                  onChange={(e) => setFormData({...formData, positionPercentage: parseFloat(e.target.value)})}
                  required
                />
              </div>

              <div className="form-group">
                <label>Leverage (x)</label>
                <input 
                  type="number" 
                  step="1"
                  min="1"
                  max="125"
                  value={formData.leverage} 
                  onChange={(e) => setFormData({...formData, leverage: parseInt(e.target.value)})}
                  required
                />
              </div>

              <div className="form-group checkbox-group" style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '20px', marginBottom: '20px' }}>
                <input 
                  type="checkbox" 
                  id="tradingEnabled"
                  checked={formData.tradingEnabled} 
                  onChange={(e) => setFormData({...formData, tradingEnabled: e.target.checked})}
                  style={{ width: '20px', height: '20px', cursor: 'pointer' }}
                />
                <label htmlFor="tradingEnabled" style={{ margin: 0, cursor: 'pointer', fontWeight: 'bold' }}>
                  Trading Active (Global Killswitch)
                </label>
              </div>

              <button type="submit" className="save-btn" disabled={saving}>
                {saving ? 'Saving...' : 'Save Configuration'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
