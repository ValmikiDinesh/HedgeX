import ccxt from 'ccxt';
const exchange = new ccxt.binance({ options: { defaultType: 'future' } });
async function run() {
  await exchange.loadMarkets();
  try {
    const market = exchange.market('DOGEUSDT');
    const req = exchange.createOrderRequest('DOGEUSDT', 'market', 'buy', 10);
    console.log("Create order request works for DOGEUSDT:", req);
  } catch (e) {
    console.error("Error creating order:", e.message);
  }
}
run();
