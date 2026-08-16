import binanceService from './src/services/BinanceService.js';
async function run() {
  try {
    const balance = await binanceService.exchange.fetchBalance();
    console.log("Keys available in balance.info:");
    console.log(Object.keys(balance.info));
    console.log("totalMaintMargin:", balance.info.totalMaintMargin);
    console.log("totalMarginBalance:", balance.info.totalMarginBalance);
  } catch (e) {
    console.error(e.message);
  }
}
run();
