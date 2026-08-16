import ccxt from 'ccxt';
const exchange = new ccxt.binance({ options: { defaultType: 'future' } });
async function run() {
  await exchange.loadMarkets();
  try {
    const market = exchange.market('DOGEUSDT');
    console.log("Market found:", market.symbol);
  } catch (e) {
    console.error("Error finding market:", e.message);
  }
}
run();
