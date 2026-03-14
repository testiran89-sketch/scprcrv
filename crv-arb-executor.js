#!/usr/bin/env node

/**
 * CRV Arbitrage Executor
 *
 * 1) Uses scan results from crv-arb-checker.js
 * 2) Filters same-chain opportunities only (required for atomic flash-loan arb)
 * 3) Builds startArbitrage params and submits tx to CrvFlashArb contract
 *
 * Required env vars:
 * - RPC_URL
 * - PRIVATE_KEY
 * - FLASH_ARB_CONTRACT
 *
 * Optional env vars:
 * - CHAIN=ethereum|polygon|bsc  (default: ethereum)
 * - MIN_SPREAD_PCT=0.3          (default: 0.3)
 * - LOAN_USD=100000             (default: 100000)
 * - MAX_OPPS=3                  (default: 3)
 * - DRY_RUN=true                (default: true)
 */

const { ethers } = require('ethers');
try {
  // Optional: auto-load .env for local runs
  // eslint-disable-next-line global-require
  require('dotenv').config();
} catch (_) {
  // dotenv is optional; env vars can still be provided by shell
}
const { scanArbitrage, CHAINS } = require('./crv-arb-checker');

const CHAIN = process.env.CHAIN || 'ethereum';
const MIN_SPREAD_PCT = Number(process.env.MIN_SPREAD_PCT || 0.3);
const LOAN_USD = Number(process.env.LOAN_USD || 100000);
const MAX_OPPS = Number(process.env.MAX_OPPS || 3);
const DRY_RUN = String(process.env.DRY_RUN || 'true').toLowerCase() === 'true';

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const FLASH_ARB_CONTRACT = process.env.FLASH_ARB_CONTRACT;

if (!RPC_URL || !PRIVATE_KEY || !FLASH_ARB_CONTRACT) {
  console.error('Missing required env vars: RPC_URL, PRIVATE_KEY, FLASH_ARB_CONTRACT');
  process.exit(1);
}

const ADDRESSES = {
  ethereum: {
    aavePool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fa4E2',
    routers: {
      uniswap: { kind: 1, addr: '0xE592427A0AEce92De3Edee1F18E0157C05861564', v3Fee: 3000 },
      sushiswap: { kind: 0, addr: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F' },
      curve: { kind: 3 },
      balancer: { kind: 2, addr: '0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
      pancakeswap: { kind: 0, addr: '0xEfF92A263d31888d860bD50809A8D171709b7b1c' },
      fraxswap: { kind: 0, addr: '0xC14d550632db8592D1243Edc8B95b0Ad06703867' },
      quickswap: { kind: 0, addr: ethers.ZeroAddress },
    },
  },
  polygon: {
    aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    routers: {
      uniswap: { kind: 1, addr: '0xE592427A0AEce92De3Edee1F18E0157C05861564', v3Fee: 3000 },
      sushiswap: { kind: 0, addr: '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506' },
      curve: { kind: 3 },
      balancer: { kind: 2, addr: '0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
      pancakeswap: { kind: 0, addr: '0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb' },
      fraxswap: { kind: 0, addr: ethers.ZeroAddress },
      quickswap: { kind: 0, addr: '0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff' },
    },
  },
  bsc: {
    aavePool: ethers.ZeroAddress,
    routers: {
      uniswap: { kind: 1, addr: ethers.ZeroAddress, v3Fee: 3000 },
      sushiswap: { kind: 0, addr: ethers.ZeroAddress },
      curve: { kind: 3, addr: ethers.ZeroAddress, curveI: 0, curveJ: 1 },
      balancer: { kind: 2, addr: ethers.ZeroAddress, poolId: ethers.ZeroHash },
      pancakeswap: { kind: 0, addr: '0x10ED43C718714eb63d5aA57B78B54704E256024E' },
      fraxswap: { kind: 0, addr: ethers.ZeroAddress },
      quickswap: { kind: 0, addr: ethers.ZeroAddress },
    },
  },
};

const ABI = [
  'function startArbitrage((address loanAsset,uint256 loanAmount,address crvToken,(uint8 dexKind,address routerOrPool,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOutMin,uint24 v3Fee,bytes32 balancerPoolId,int128 curveI,int128 curveJ) buyLeg,(uint8 dexKind,address routerOrPool,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOutMin,uint24 v3Fee,bytes32 balancerPoolId,int128 curveI,int128 curveJ) sellLeg,uint256 minProfit) p) external',
];

const BALANCER_POOL_ABI = ['function getPoolId() external view returns (bytes32)'];
const CURVE_POOL_ABI = ['function coins(uint256) external view returns (address)'];

function isAddress(value) {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isBytes32(value) {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value);
}

function toMinOut(amountIn, spreadPct, safetyBps = 5000) {
  // conservative: expect only 50% of theoretical spread
  const factor = 1 + (spreadPct / 100) * (safetyBps / 10000);
  return amountIn * factor;
}

function parsePair(pair) {
  const [base, quote] = pair.split('/');
  return { base, quote };
}

function routerConfig(chain, dexId) {
  return ADDRESSES[chain]?.routers?.[dexId];
}

function makeLeg(cfg, tokenIn, tokenOut, amountIn, amountOutMin) {
  return {
    dexKind: cfg.kind,
    routerOrPool: cfg.addr,
    tokenIn,
    tokenOut,
    amountIn,
    amountOutMin,
    v3Fee: cfg.v3Fee || 0,
    balancerPoolId: cfg.poolId || ethers.ZeroHash,
    curveI: cfg.curveI ?? 0,
    curveJ: cfg.curveJ ?? 0,
  };
}

async function resolveBalancerPoolId(provider, poolAddress) {
  const pool = new ethers.Contract(poolAddress, BALANCER_POOL_ABI, provider);
  return pool.getPoolId();
}

async function resolveCurveIndices(provider, poolAddress, tokenIn, tokenOut) {
  const pool = new ethers.Contract(poolAddress, CURVE_POOL_ABI, provider);
  let inIndex = -1;
  let outIndex = -1;

  for (let i = 0; i < 8; i++) {
    try {
      const coin = (await pool.coins(i)).toLowerCase();
      if (coin === tokenIn.toLowerCase()) inIndex = i;
      if (coin === tokenOut.toLowerCase()) outIndex = i;
    } catch (_) {
      break;
    }
  }

  if (inIndex < 0 || outIndex < 0) {
    throw new Error(`Curve indices not found for pool=${poolAddress} tokenIn=${tokenIn} tokenOut=${tokenOut}`);
  }

  return { curveI: inIndex, curveJ: outIndex };
}

async function buildLeg(provider, chain, dexId, poolAddress, tokenIn, tokenOut, amountIn, amountOutMin) {
  const cfg = routerConfig(chain, dexId);
  if (!cfg) return null;

  // Curve: use pool address directly + auto-resolved indices
  if (dexId === 'curve') {
    const { curveI, curveJ } = await resolveCurveIndices(provider, poolAddress, tokenIn, tokenOut);
    return makeLeg(
      {
        kind: 3,
        addr: poolAddress,
        curveI,
        curveJ,
      },
      tokenIn,
      tokenOut,
      amountIn,
      amountOutMin
    );
  }

  // Balancer: router is vault + poolId resolved from pool contract
  if (dexId === 'balancer') {
    let poolId;

    // Dexscreener may return Balancer poolId directly in pairAddress.
    if (isBytes32(poolAddress)) {
      poolId = poolAddress;
    } else if (isAddress(poolAddress)) {
      poolId = await resolveBalancerPoolId(provider, poolAddress);
    } else {
      throw new Error(`Invalid balancer pairAddress: ${poolAddress}`);
    }

    return makeLeg(
      {
        kind: 2,
        addr: cfg.addr,
        poolId,
      },
      tokenIn,
      tokenOut,
      amountIn,
      amountOutMin
    );
  }

  // v2/v3: fixed router config
  if (!cfg.addr || cfg.addr === ethers.ZeroAddress) return null;
  return makeLeg(cfg, tokenIn, tokenOut, amountIn, amountOutMin);
}

async function main() {
  if (!CHAINS[CHAIN]) throw new Error(`Unsupported CHAIN: ${CHAIN}`);

  console.log(`Executor chain: ${CHAIN}`);
  console.log(`Min spread: ${MIN_SPREAD_PCT}% | Loan USD: ${LOAN_USD} | Dry run: ${DRY_RUN}`);

  const { allOpportunities } = await scanArbitrage({ sameChainOnly: true });
  const candidates = allOpportunities
    .filter((o) => o.buyChain === CHAIN && o.sellChain === CHAIN)
    .filter((o) => o.spread >= MIN_SPREAD_PCT)
    .slice(0, MAX_OPPS);

  if (!candidates.length) {
    console.log(`No same-chain opportunities on ${CHAIN} above ${MIN_SPREAD_PCT}%`);
    return;
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(FLASH_ARB_CONTRACT, ABI, wallet);

  for (const opp of candidates) {
    try {
      const { quote } = parsePair(opp.pair);
      const chainTokens = CHAINS[CHAIN].tokens;
      const loanAsset = chainTokens[quote];
      const crv = chainTokens.CRV;
      if (!loanAsset || !crv) continue;

      // Use 100k quote notional with token decimals approximation = 18.
      // For production, query decimals() and normalize correctly.
      const loanAmount = ethers.parseUnits(String(LOAN_USD), 18);

      const buyLeg = await buildLeg(provider, CHAIN, opp.buyDexId, opp.buyPool.pairAddress, loanAsset, crv, loanAmount, 1n);
      if (!buyLeg) {
        console.log(`Skipping ${opp.pair}: missing buy leg config for dex=${opp.buyDexId}`);
        continue;
      }

      // Conservative lower-bound minOut to reduce reverts.
      const sellAmountOutMinFloat = toMinOut(LOAN_USD, opp.spread, 5000);
      const sellLeg = await buildLeg(
        provider,
        CHAIN,
        opp.sellDexId,
        opp.sellPool.pairAddress,
        crv,
        loanAsset,
        0n,
        ethers.parseUnits(String(Math.floor(sellAmountOutMinFloat)), 18)
      );
      if (!sellLeg) {
        console.log(`Skipping ${opp.pair}: missing sell leg config for dex=${opp.sellDexId}`);
        continue;
      }

      const minProfit = ethers.parseUnits('10', 18);

      const params = {
        loanAsset,
        loanAmount,
        crvToken: crv,
        buyLeg,
        sellLeg,
        minProfit,
      };

      console.log(`\nOpportunity: ${opp.pair}`);
      console.log(`buy=${opp.buyDex} sell=${opp.sellDex} spread=${opp.spread.toFixed(3)}%`);

      if (DRY_RUN) {
        console.log('DRY_RUN=true => tx not sent');
        continue;
      }

      const tx = await contract.startArbitrage(params, { gasLimit: 2_500_000 });
      console.log(`Sent tx: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`Mined in block ${receipt.blockNumber}`);
    } catch (err) {
      console.log(`Skipping ${opp.pair} due to leg-build/send error: ${err.shortMessage || err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
