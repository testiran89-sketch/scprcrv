#!/usr/bin/env node

/**
 * CRV Arbitrage Potential Checker
 *
 * - Fetches CRV pair prices across DEXes via Dexscreener public API (no API key)
 * - Computes buy/sell spread per pair
 * - Estimates gross profit for a 100,000 USD flash loan notionally
 */

const CHAINS = {
  ethereum: {
    chainId: 'ethereum',
    tokens: {
      CRV: '0xD533a949740bb3306d119CC777fa900bA034cd52',
      WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      FRAX: '0x853d955aCEf822Db058eb8505911ED77F175b99e',
      cvxCRV: '0x62B9c7356A2Dc64a1969e19C23e4fE19D7D4dDc1',
    },
  },
  polygon: {
    chainId: 'polygon',
    tokens: {
      CRV: '0x172370d5Cd63279eFa6d502DAB29171933a610AF',
      WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
      USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
      FRAX: '0x45c32fA6DF82ead1e2EF74d17b76547EDdFaFF89',
    },
  },
  bsc: {
    chainId: 'bsc',
    tokens: {
      CRV: '0x1E4F97b9f9F913c46F1632781732927B9019C68b',
      WETH: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
      USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      USDT: '0x55d398326f99059fF775485246999027B3197955',
      DAI: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
      FRAX: '0x90C97F71E18723b0Cf0dfa30ee176Ab653E89F40',
    },
  },
};

const PAIRS = [
  ['CRV', 'WETH'],
  ['CRV', 'USDC'],
  ['CRV', 'USDT'],
  ['CRV', 'DAI'],
  ['CRV', 'FRAX'],
  ['CRV', 'cvxCRV'],
];

const DEX_ALIAS = {
  uniswap: 'Uniswap',
  sushiswap: 'SushiSwap',
  curve: 'Curve Finance',
  balancer: 'Balancer',
  pancakeswap: 'Pancake',
  fraxswap: 'Fraxswap',
  quickswap: 'QuickSwap',
};

const TARGET_DEX_IDS = new Set(Object.keys(DEX_ALIAS));
const FLASH_LOAN_NOTIONAL_USD = 100_000;

function lower(x) {
  return (x || '').toLowerCase();
}

function round(n, d = 6) {
  return Number.parseFloat(n).toFixed(d);
}

async function fetchTokenPairs(chainId, tokenAddress) {
  const url = `https://api.dexscreener.com/token-pairs/v1/${chainId}/${tokenAddress}`;
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'crv-arb-checker/1.1',
    },
  });

  if (!res.ok) {
    throw new Error(`Dexscreener request failed: ${res.status} ${res.statusText} (${url})`);
  }

  return res.json();
}

function extractPriceForPair(pool, baseSymbol, quoteSymbol, tokenMap) {
  const baseAddr = lower(pool.baseToken?.address);
  const quoteAddr = lower(pool.quoteToken?.address);

  const pairBaseAddr = lower(tokenMap[baseSymbol]);
  const pairQuoteAddr = lower(tokenMap[quoteSymbol]);

  const pn = Number.parseFloat(pool.priceNative);
  if (!Number.isFinite(pn) || pn <= 0) return null;

  if (baseAddr === pairBaseAddr && quoteAddr === pairQuoteAddr) {
    return pn;
  }

  if (baseAddr === pairQuoteAddr && quoteAddr === pairBaseAddr) {
    return 1 / pn;
  }

  return null;
}

async function getAllPoolsByChain() {
  const poolsByChain = {};

  for (const [chainName, chainData] of Object.entries(CHAINS)) {
    try {
      const pools = await fetchTokenPairs(chainData.chainId, chainData.tokens.CRV);
      poolsByChain[chainName] = pools;
    } catch (err) {
      console.error(`⚠️ Could not fetch ${chainName}: ${err.message}`);
      poolsByChain[chainName] = [];
    }
  }

  return poolsByChain;
}

function collectPricesForPair(pair, poolsByChain) {
  const [base, quote] = pair;
  const out = [];

  for (const [chainName, pools] of Object.entries(poolsByChain)) {
    const tokenMap = CHAINS[chainName].tokens;
    if (!tokenMap[base] || !tokenMap[quote]) continue;

    for (const pool of pools) {
      const dexId = lower(pool.dexId);
      if (!TARGET_DEX_IDS.has(dexId)) continue;

      const px = extractPriceForPair(pool, base, quote, tokenMap);
      if (!px) continue;

      out.push({
        pair: `${base}/${quote}`,
        chain: chainName,
        dexId,
        dex: DEX_ALIAS[dexId] || pool.dexId,
        price: px,
        crvPriceUsd: Number.parseFloat(pool.priceUsd || 0),
        liquidityUsd: Number.parseFloat(pool.liquidity?.usd || 0),
        pairAddress: pool.pairAddress,
        url: pool.url,
      });
    }
  }

  const bestByDexAndChain = new Map();
  for (const item of out) {
    const key = `${item.pair}|${item.chain}|${item.dexId}`;
    if (!bestByDexAndChain.has(key) || item.liquidityUsd > bestByDexAndChain.get(key).liquidityUsd) {
      bestByDexAndChain.set(key, item);
    }
  }

  return Array.from(bestByDexAndChain.values());
}

function buildOpportunities(pairPrices, options = {}) {
  const { sameChainOnly = false } = options;

  if (pairPrices.length < 2) return [];

  const opportunities = [];

  for (let i = 0; i < pairPrices.length; i++) {
    for (let j = 0; j < pairPrices.length; j++) {
      if (i === j) continue;

      const buy = pairPrices[i];
      const sell = pairPrices[j];
      if (buy.dexId === sell.dexId) continue;
      if (sameChainOnly && buy.chain !== sell.chain) continue;

      const spread = ((sell.price - buy.price) / buy.price) * 100;
      if (spread <= 0) continue;

      opportunities.push({
        pair: buy.pair,
        buyDexId: buy.dexId,
        sellDexId: sell.dexId,
        buyDex: `${buy.dex} (${buy.chain})`,
        sellDex: `${sell.dex} (${sell.chain})`,
        buyChain: buy.chain,
        sellChain: sell.chain,
        buyPrice: buy.price,
        sellPrice: sell.price,
        spread,
        estProfitUsd: (spread / 100) * FLASH_LOAN_NOTIONAL_USD,
        buyPool: buy,
        sellPool: sell,
      });
    }
  }

  opportunities.sort((a, b) => b.spread - a.spread);
  return opportunities;
}

function buildBestOpportunity(pairPrices, options = {}) {
  return buildOpportunities(pairPrices, options)[0] || null;
}

async function scanArbitrage(options = {}) {
  const poolsByChain = await getAllPoolsByChain();
  const allPairPrices = {};
  const bestByPair = [];
  const allOpportunities = [];

  for (const pair of PAIRS) {
    const pairName = `${pair[0]}/${pair[1]}`;
    const prices = collectPricesForPair(pair, poolsByChain);
    allPairPrices[pairName] = prices;

    const best = buildBestOpportunity(prices, options);
    if (best) bestByPair.push(best);

    const pairOpps = buildOpportunities(prices, options);
    allOpportunities.push(...pairOpps);
  }

  bestByPair.sort((a, b) => b.spread - a.spread);
  allOpportunities.sort((a, b) => b.spread - a.spread);

  return { poolsByChain, allPairPrices, bestByPair, allOpportunities };
}

function printResults(opps, allPairPrices, sameChainOnly = false) {
  console.log('\n=== CRV Arbitrage Scanner (Public APIs, no key) ===');
  console.log(`Flash-loan notional (assumed): $${FLASH_LOAN_NOTIONAL_USD.toLocaleString()}`);
  console.log(`Mode: ${sameChainOnly ? 'Same-chain only (flash-loan executable)' : 'Cross-chain allowed (informational)'}`);
  console.log('');

  for (const [pair, prices] of Object.entries(allPairPrices)) {
    if (!prices.length) {
      console.log(`PAIR: ${pair}`);
      console.log('  No matching pools found on selected DEXes.\n');
    }
  }

  if (!opps.length) {
    console.log('No positive spread found between selected DEXes for requested pairs.');
    return;
  }

  console.table(
    opps.map((o) => ({
      pair: o.pair,
      buy: o.buyDex,
      sell: o.sellDex,
      buyPrice: round(o.buyPrice, 8),
      sellPrice: round(o.sellPrice, 8),
      spreadPct: `${round(o.spread, 3)} %`,
      estProfit100kUsd: `$${round(o.estProfitUsd, 2)}`,
    }))
  );

  console.log('\n--- Sample style output ---');
  for (const o of opps) {
    console.log(`PAIR: ${o.pair}`);
    console.log(`buy : ${o.buyDex} ${round(o.buyPrice, 8)}`);
    console.log(`sell: ${o.sellDex} ${round(o.sellPrice, 8)}`);
    console.log(`spread: ${round(o.spread, 2)} %`);
    console.log(`est profit on $100k: $${round(o.estProfitUsd, 2)} (gross, before costs)\n`);
  }
}

async function main() {
  const sameChainOnly = process.argv.includes('--same-chain');
  const result = await scanArbitrage({ sameChainOnly });
  printResults(result.bestByPair, result.allPairPrices, sameChainOnly);

  console.log('Note: For production execution, add route simulation + gas/fees/slippage/MEV checks.');
  console.log('If you prefer Moralis, replace data source in fetchTokenPairs with Moralis DEX endpoints.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  CHAINS,
  PAIRS,
  DEX_ALIAS,
  FLASH_LOAN_NOTIONAL_USD,
  scanArbitrage,
  buildOpportunities,
};
