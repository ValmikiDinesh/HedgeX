import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { 
  Bot, 
  Wallet, 
  ShieldAlert, 
  Settings, 
  X, 
  Check, 
  Activity, 
  Sliders, 
  Zap, 
  TrendingUp,
  AlertTriangle,
  Wifi,
  WifiOff
} from 'lucide-react';
import GridLegCard from './components/GridLegCard';
import './index.css';

const PRESET_SYMBOLS = ['DOGEUSDT', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

function App() {
  const [status, setStatus] = useState({ balance: 0, marginRatio: 0, totalRealizedPnl: 0 });
  const [gridData, setGridData] = useState({ livePositions: { long: null, short: null }, livePrice: null });
  const [tradeHistory, setTradeHistory] = useState([]);
  const [settings, setSettings] = useState({ 
    symbol: 'DOGEUSDT', 
    gridPercentage: 0.015, 
    positionPercentage: 0.20, 
    leverage: 10, 
    tradingEnabled: true, 
    maxDcaLayers: 3, 
    stopLossPercentage: 0.05,
    useDynamicGrid: true,
    minGridPercentage: 0.0035,
    maxGridPercentage: 0.035
  });
  const [loading, setLoading] = useState(true);
  const [priceFlash, setPriceFlash] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [isWsConnected, setIsWsConnected] = useState(false);
  
  // Modal State
  const [showSettings, setShowSettings] = useState(false);
  const [formData, setFormData] = useState({ 
    symbol: 'DOGEUSDT',
    gridPercentage: 1.5,
    positionPercentage: 20,
    leverage: 10,
    tradingEnabled: true,
    maxDcaLayers: 3,
    stopLossPercentage: 5.0,
    useDynamicGrid: true,
    minGridPercentage: 0.35,
    maxGridPercentage: 3.5
  });
  const [saving, setSaving] = useState(false);
  const currentSymbolRef = useRef(settings.symbol);
  const flashTimerRef = useRef(null);
  const saveTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  useEffect(() => {
    currentSymbolRef.current = settings.symbol;
  }, [settings.symbol]);

  // Helper to normalize crypto symbols for safe comparison
  const normalizeSymbol = (s) => (s || '').replace(/[/:]/g, '').replace(/USDTUSDT$/i, 'USDT').toUpperCase();

  const fetchData = async () => {
    try {
      const [statusRes, gridRes, settingsRes, historyRes] = await Promise.all([
        axios.get('/api/status'),
        axios.get('/api/grid'),
        axios.get('/api/settings'),
        axios.get('/api/history')
      ]);

      setStatus(statusRes.data || { balance: 0, marginRatio: 0, totalRealizedPnl: 0 });
      
      setGridData(prev => ({
        ...gridRes.data,
        livePrice: (gridRes.data?.livePrice !== null && gridRes.data?.livePrice !== undefined) 
          ? gridRes.data.livePrice 
          : prev.livePrice
      }));

      setTradeHistory(Array.isArray(historyRes.data) ? historyRes.data : []);
      
      if (!showSettings && settingsRes.data) {
        const s = settingsRes.data;
        setSettings(s);
        setFormData({
          symbol: s.symbol || 'DOGEUSDT',
          gridPercentage: parseFloat(((s.gridPercentage ?? 0.015) * 100).toFixed(4)),
          positionPercentage: parseFloat(((s.positionPercentage ?? 0.20) * 100).toFixed(4)),
          leverage: parseInt(s.leverage) || 1,
          tradingEnabled: s.tradingEnabled !== false,
          maxDcaLayers: parseInt(s.maxDcaLayers ?? 3),
          stopLossPercentage: parseFloat(((s.stopLossPercentage ?? 0.05) * 100).toFixed(2)),
          useDynamicGrid: s.useDynamicGrid !== false,
          minGridPercentage: parseFloat(((s.minGridPercentage ?? 0.0035) * 100).toFixed(2)),
          maxGridPercentage: parseFloat(((s.maxGridPercentage ?? 0.035) * 100).toFixed(2))
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

  // Real-time WebSocket Price Stream (Persistent connection)
  useEffect(() => {
    const socket = io();
    
    socket.on('connect', () => setIsWsConnected(true));
    socket.on('disconnect', () => setIsWsConnected(false));

    socket.on('price_update', (data) => {
      if (typeof data === 'object' && data !== null) {
        const updateSym = normalizeSymbol(data.symbol || data.unifiedSymbol);
        const currentSym = normalizeSymbol(currentSymbolRef.current);
        
        if (!updateSym || updateSym === currentSym) {
          setGridData(prev => ({ ...prev, livePrice: data.price }));
          setPriceFlash(true);
          if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
          flashTimerRef.current = setTimeout(() => setPriceFlash(false), 300);
        }
      } else if (typeof data === 'number') {
        setGridData(prev => ({ ...prev, livePrice: data }));
      }
    });

    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      socket.disconnect();
    };
  }, []);

  // Handle ESC key to dismiss modal
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && showSettings) {
        setShowSettings(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showSettings]);

  const handleOpenSettings = () => {
    setFormData({
      symbol: settings.symbol || 'DOGEUSDT',
      gridPercentage: parseFloat(((settings.gridPercentage ?? 0.015) * 100).toFixed(4)),
      positionPercentage: parseFloat(((settings.positionPercentage ?? 0.20) * 100).toFixed(4)),
      leverage: parseInt(settings.leverage) || 1,
      tradingEnabled: settings.tradingEnabled !== false,
      maxDcaLayers: parseInt(settings.maxDcaLayers ?? 3),
      stopLossPercentage: parseFloat(((settings.stopLossPercentage ?? 0.05) * 100).toFixed(2)),
      useDynamicGrid: settings.useDynamicGrid !== false,
      minGridPercentage: parseFloat(((settings.minGridPercentage ?? 0.0035) * 100).toFixed(2)),
      maxGridPercentage: parseFloat(((settings.maxGridPercentage ?? 0.035) * 100).toFixed(2))
    });
    setSaveSuccess(false);
    setSaveError(null);
    setShowSettings(true);
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSaveSuccess(false);
    setSaveError(null);

    // Client-side validation
    let cleanSym = normalizeSymbol(formData.symbol);
    if (!cleanSym || cleanSym.length < 2) {
      setSaveError('Please enter a valid coin pair symbol (e.g. DOGEUSDT)');
      setSaving(false);
      return;
    }
    if (!cleanSym.endsWith('USDT') && !cleanSym.endsWith('BUSD') && !cleanSym.endsWith('USDC')) {
      cleanSym += 'USDT';
    }

    const gridP = parseFloat(formData.gridPercentage);
    if (isNaN(gridP) || gridP < 0.1 || gridP > 50) {
      setSaveError('Grid profit target must be between 0.1% and 50%');
      setSaving(false);
      return;
    }

    const posP = parseFloat(formData.positionPercentage);
    if (isNaN(posP) || posP < 1 || posP > 50) {
      setSaveError('Position capital must be between 1% and 50%');
      setSaving(false);
      return;
    }

    if (formData.useDynamicGrid) {
      const minG = parseFloat(formData.minGridPercentage) || 0;
      const maxG = parseFloat(formData.maxGridPercentage) || 0;
      if (minG >= maxG) {
        setSaveError('Minimum grid spacing must be strictly less than maximum grid spacing');
        setSaving(false);
        return;
      }
    }

    try {
      const parsedStopLoss = parseFloat(formData.stopLossPercentage);
      const payload = {
        symbol: cleanSym,
        gridPercentage: parseFloat(formData.gridPercentage) / 100,
        positionPercentage: parseFloat(formData.positionPercentage) / 100,
        leverage: parseInt(formData.leverage) || 1,
        maxDcaLayers: parseInt(formData.maxDcaLayers) || 0,
        stopLossPercentage: !isNaN(parsedStopLoss) ? (parsedStopLoss / 100) : 0.05,
        tradingEnabled: Boolean(formData.tradingEnabled),
        useDynamicGrid: Boolean(formData.useDynamicGrid),
        minGridPercentage: (parseFloat(formData.minGridPercentage) || 0.35) / 100,
        maxGridPercentage: (parseFloat(formData.maxGridPercentage) || 3.5) / 100,
      };

      const res = await axios.post('/api/settings', payload);
      if (res.data) {
        setSettings(res.data);
      }
      setSaveSuccess(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        setShowSettings(false);
        setSaveSuccess(false);
      }, 600);
      fetchData();
    } catch (err) {
      console.error(err);
      setSaveError(err.response?.data?.error || err.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const isMarginSafe = (parseFloat(status.marginRatio) || 0) < 80;

  const formatPrice = (p, fallback = 'Loading...') => {
    if (p === null || p === undefined || isNaN(p) || parseFloat(p) <= 0) return fallback;
    const num = parseFloat(p);
    if (num >= 1000) return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (num >= 1) return `$${num.toFixed(4)}`;
    return `$${num.toFixed(5)}`;
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="dashboard-header">
        <div className="header-brand">
          <div className="brand-icon-wrap">
            <Bot size={26} className={settings.tradingEnabled ? "icon-spin" : ""} />
          </div>
          <div className="brand-info">
            <h1>HedgeX Bot</h1>
            <div className="brand-subtitle">
              <span className={`live-indicator ${settings.tradingEnabled ? '' : 'inactive'}`} />
              <span>{settings.symbol} &bull; {settings.tradingEnabled ? 'Trading Active' : 'Trading Paused'}</span>
              <span style={{ marginLeft: '4px', opacity: 0.8 }}>
                {isWsConnected ? '• WS Live' : '• WS Connecting'}
              </span>
            </div>
          </div>
        </div>
        
        <div className="stats-container">
          <div className="stat-pill">
            <span className="stat-label">Live Price:</span>
            <span className={`stat-value highlight ${priceFlash ? 'price-pulse' : ''}`}>
              {formatPrice(gridData.livePrice)}
            </span>
          </div>

          <div className="stat-pill">
            <Wallet size={15} className="stat-label" />
            <span className="stat-label">Balance:</span>
            <span className="stat-value">${parseFloat(status?.balance || 0).toFixed(2)}</span>
          </div>
          
          <div className="stat-pill">
            <ShieldAlert size={15} className={isMarginSafe ? 'stat-value safe' : 'stat-value danger'} />
            <span className="stat-label">Margin:</span>
            <span className={isMarginSafe ? 'stat-value safe' : 'stat-value danger'}>
              {status.marginRatio}%
            </span>
          </div>

          <div className="stat-pill">
            <span className="stat-label">Total PnL:</span>
            <span className={`stat-value ${(parseFloat(status.totalRealizedPnl) || 0) >= 0 ? 'safe' : 'danger'}`}>
              {(parseFloat(status.totalRealizedPnl) || 0) >= 0 ? '+' : ''}${parseFloat(status?.totalRealizedPnl || 0).toFixed(2)}
            </span>
          </div>

          <button 
            type="button" 
            className="settings-btn" 
            title="Configure Bot Settings"
            onClick={handleOpenSettings}
          >
            <Settings size={18} />
          </button>
        </div>
      </header>

      {/* Main Grid Section */}
      <main>
        {loading ? (
          <div className="empty-state">
            <Activity className="empty-icon icon-spin" size={44} />
            <p>Connecting to Exchange & Loading Grid State...</p>
          </div>
        ) : (
          <div className="grid-container">
            <GridLegCard 
              side="LONG" 
              position={gridData.livePositions?.long} 
              symbol={settings.symbol}
              maxDcaLayers={settings.maxDcaLayers ?? 3}
            />
            <GridLegCard 
              side="SHORT" 
              position={gridData.livePositions?.short} 
              symbol={settings.symbol}
              maxDcaLayers={settings.maxDcaLayers ?? 3}
            />
          </div>
        )}

        {/* Trade History Section */}
        {!loading && (
          <div className="history-section">
            <h3 className="history-title">
              <TrendingUp size={18} style={{ color: 'var(--primary)' }} />
              Recent Completed Trades
            </h3>
            {!Array.isArray(tradeHistory) || tradeHistory.length === 0 ? (
              <div className="empty-history">No completed trades yet. When legs hit take-profit or stop-loss, executions appear here.</div>
            ) : (
              <div className="table-responsive">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Asset</th>
                      <th>Side</th>
                      <th>Entry Price</th>
                      <th>Exit Price</th>
                      <th>Gross PnL</th>
                      <th>Net PnL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tradeHistory.map((trade, idx) => (
                      <tr key={trade._id || idx}>
                        <td>{trade.closedAt ? new Date(trade.closedAt).toLocaleTimeString() : 'N/A'}</td>
                        <td>{trade.symbol}</td>
                        <td>
                          <span className={`badge ${trade.side === 'LONG' ? 'safe' : 'warning'}`}>
                            {trade.side}
                          </span>
                        </td>
                        <td>{formatPrice(trade.entryPrice, '$0.00')}</td>
                        <td>{formatPrice(trade.exitPrice, '$0.00')}</td>
                        <td className={(parseFloat(trade.grossPnl) || 0) >= 0 ? 'text-green' : 'text-red'}>
                          {(parseFloat(trade.grossPnl) || 0) >= 0 ? '+' : ''}{Number(trade.grossPnl || 0).toFixed(4)} USDT
                        </td>
                        <td className={(parseFloat(trade.netPnl) || 0) >= 0 ? 'text-green' : 'text-red'} style={{ fontWeight: '700' }}>
                          {(parseFloat(trade.netPnl) || 0) >= 0 ? '+' : ''}{Number(trade.netPnl || 0).toFixed(4)} USDT
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

      {/* Settings Modal (Always scrollable, visible close & save buttons) */}
      {showSettings && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowSettings(false); }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            {/* Fixed Header */}
            <div className="modal-header">
              <div className="modal-title-wrap">
                <Sliders size={20} className="modal-title-icon" />
                <h2>Bot Configuration</h2>
              </div>
              <button 
                type="button" 
                className="close-btn" 
                title="Close (Esc)"
                onClick={() => setShowSettings(false)}
              >
                <X size={18} />
              </button>
            </div>
            
            {/* Scrollable Body Form */}
            <form onSubmit={handleSaveSettings} className="modal-form">
              <div className="modal-body">

                {saveError && (
                  <div style={{
                    padding: '10px 14px',
                    borderRadius: '8px',
                    background: 'var(--loss-red-bg)',
                    border: '1px solid var(--loss-red)',
                    color: 'var(--loss-red)',
                    fontSize: '0.85rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}>
                    <AlertTriangle size={16} />
                    <span>{saveError}</span>
                  </div>
                )}
                
                {/* 1. Global Killswitch */}
                <div 
                  className={`switch-card ${formData.tradingEnabled ? 'active' : ''}`}
                  onClick={() => setFormData({ ...formData, tradingEnabled: !formData.tradingEnabled })}
                >
                  <div className="switch-info">
                    <h4>Automated Trading Engine</h4>
                    <p>{formData.tradingEnabled ? 'Bot actively places & manages hedge grid orders' : 'Trading paused — existing positions remain protected'}</p>
                  </div>
                  <label className="toggle-switch" onClick={(e) => e.stopPropagation()}>
                    <input 
                      type="checkbox" 
                      checked={formData.tradingEnabled}
                      onChange={(e) => setFormData({ ...formData, tradingEnabled: e.target.checked })}
                    />
                    <span className="slider"></span>
                  </label>
                </div>

                {/* Section: Market & Pair */}
                <div className="form-section-title">
                  <Zap size={14} /> Market & Position Sizing
                </div>

                <div className="form-group">
                  <label>
                    Trading Pair Symbol
                    <span className="label-hint">USDⓈ-M Futures</span>
                  </label>
                  <input 
                    type="text" 
                    className="form-input"
                    value={formData.symbol} 
                    onChange={(e) => setFormData({...formData, symbol: e.target.value.toUpperCase()})}
                    placeholder="e.g. DOGEUSDT"
                    required
                  />
                  <div className="chips-row">
                    {PRESET_SYMBOLS.map(sym => (
                      <button 
                        key={sym} 
                        type="button" 
                        className={`chip ${formData.symbol === sym ? 'active' : ''}`}
                        onClick={() => setFormData({ ...formData, symbol: sym })}
                      >
                        {sym}
                      </button>
                    ))}
                  </div>
                  <small className="warning-text">⚠️ Changing coin symbol will automatically close active grids on the previous asset.</small>
                </div>

                <div className="two-col-grid">
                  <div className="form-group">
                    <label>Position Capital</label>
                    <div className="input-with-unit">
                      <input 
                        type="number" 
                        className="form-input has-unit"
                        step="0.1"
                        min="1"
                        max="50"
                        value={formData.positionPercentage} 
                        onChange={(e) => setFormData({...formData, positionPercentage: parseFloat(e.target.value) || 0})}
                        required
                      />
                      <span className="input-unit">%</span>
                    </div>
                    <small>Allocated per leg (1% - 50%)</small>
                  </div>

                  <div className="form-group">
                    <label>Leverage</label>
                    <div className="input-with-unit">
                      <input 
                        type="number" 
                        className="form-input has-unit"
                        step="1"
                        min="1"
                        max="125"
                        value={formData.leverage} 
                        onChange={(e) => setFormData({...formData, leverage: parseInt(e.target.value) || 1})}
                        required
                      />
                      <span className="input-unit">x</span>
                    </div>
                    <small>Isolated/Cross leverage (1x - 125x)</small>
                  </div>
                </div>

                {/* Section: Grid & Safety */}
                <div className="form-section-title">
                  <Sliders size={14} /> Grid & DCA Execution
                </div>

                <div className="two-col-grid">
                  <div className="form-group">
                    <label>Grid Profit Target</label>
                    <div className="input-with-unit">
                      <input 
                        type="number" 
                        className="form-input has-unit"
                        step="0.01"
                        min="0.1"
                        max="50"
                        value={formData.gridPercentage} 
                        onChange={(e) => setFormData({...formData, gridPercentage: parseFloat(e.target.value) || 0})}
                        required
                      />
                      <span className="input-unit">%</span>
                    </div>
                    <small>Profit spread per grid cycle</small>
                  </div>

                  <div className="form-group">
                    <label>Max DCA Layers</label>
                    <div className="input-with-unit">
                      <input 
                        type="number" 
                        className="form-input has-unit"
                        step="1"
                        min="0"
                        max="10"
                        value={formData.maxDcaLayers} 
                        onChange={(e) => setFormData({...formData, maxDcaLayers: parseInt(e.target.value) || 0})}
                        required
                      />
                      <span className="input-unit">lvls</span>
                    </div>
                    <small>Safety orders per side (0 - 10)</small>
                  </div>
                </div>

                <div className="form-group">
                  <label>
                    Position Stop-Loss
                    <span className="label-hint">Emergency Risk Guard</span>
                  </label>
                  <div className="input-with-unit">
                    <input 
                      type="number" 
                      className="form-input has-unit"
                      step="0.1"
                      min="0"
                      max="50"
                      value={formData.stopLossPercentage} 
                      onChange={(e) => setFormData({...formData, stopLossPercentage: e.target.value === '' ? '' : parseFloat(e.target.value)})}
                      placeholder="e.g. 5.0 (0 to disable)"
                      required
                    />
                    <span className="input-unit">%</span>
                  </div>
                  <small>Closes losing leg if price diverges beyond max DCA limits (set 0 to disable).</small>
                </div>

                {/* Section: Dynamic Volatility (ATR) */}
                <div className="form-section-title">
                  <TrendingUp size={14} /> Dynamic Volatility (ATR)
                </div>

                <div 
                  className={`switch-card ${formData.useDynamicGrid ? 'active' : ''}`}
                  onClick={() => setFormData({ ...formData, useDynamicGrid: !formData.useDynamicGrid })}
                >
                  <div className="switch-info">
                    <h4>Dynamic ATR Grid Spacing</h4>
                    <p>Auto-scales grid spacing dynamically with live 5m market volatility</p>
                  </div>
                  <label className="toggle-switch" onClick={(e) => e.stopPropagation()}>
                    <input 
                      type="checkbox" 
                      checked={formData.useDynamicGrid}
                      onChange={(e) => setFormData({ ...formData, useDynamicGrid: e.target.checked })}
                    />
                    <span className="slider"></span>
                  </label>
                </div>

                {formData.useDynamicGrid && (
                  <div className="two-col-grid">
                    <div className="form-group">
                      <label>Min Spacing Floor</label>
                      <div className="input-with-unit">
                        <input 
                          type="number" 
                          className="form-input has-unit"
                          step="0.05"
                          min="0.1"
                          max="10"
                          value={formData.minGridPercentage} 
                          onChange={(e) => setFormData({...formData, minGridPercentage: parseFloat(e.target.value) || 0})}
                        />
                        <span className="input-unit">%</span>
                      </div>
                      <small>Minimum fee-safe spacing floor</small>
                    </div>

                    <div className="form-group">
                      <label>Max Spacing Ceiling</label>
                      <div className="input-with-unit">
                        <input 
                          type="number" 
                          className="form-input has-unit"
                          step="0.1"
                          min="0.5"
                          max="50"
                          value={formData.maxGridPercentage} 
                          onChange={(e) => setFormData({...formData, maxGridPercentage: parseFloat(e.target.value) || 0})}
                        />
                        <span className="input-unit">%</span>
                      </div>
                      <small>Maximum spacing in volatile swings</small>
                    </div>
                  </div>
                )}

              </div>

              {/* Fixed Footer (Cancel & Save buttons always visible) */}
              <div className="modal-footer">
                <button 
                  type="button" 
                  className="btn-secondary"
                  onClick={() => setShowSettings(false)}
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  className="save-btn" 
                  disabled={saving}
                >
                  {saving ? (
                    <>
                      <Activity size={16} className="icon-spin" />
                      Saving...
                    </>
                  ) : saveSuccess ? (
                    <>
                      <Check size={16} />
                      Saved!
                    </>
                  ) : (
                    'Save Configuration'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
