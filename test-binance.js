import binanceService from './src/services/BinanceService.js';

async function testConnection() {
  console.log('Testing Binance Futures Connection...');
  try {
    const balance = await binanceService.getBalance();
    console.log(`✅ Connection Successful! Available USDT Balance: $${balance}`);
    
    console.log('\nConfiguring Hedge Mode...');
    await binanceService.initializeHedgeMode();
    
    console.log('\n🎉 Setup Complete! Binance is ready for Hedge Mode Trading.');
  } catch (err) {
    console.error('\n❌ Connection Failed. Please ensure your .env file has valid BINANCE_API_KEY and BINANCE_API_SECRET.');
    console.error('Make sure your API keys have "Enable Futures" permissions checked in Binance.');
  }
}

testConnection();
