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

// IMPORTANT: Fill these real addresses before live trading.
const ADDRESSES = {
  ethereum: {
    aavePool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fa4E2',
    routers: {
      uniswap: { kind: 1, addr: '0xE592427A0AEce92De3Edee1F18E0157C05861564', v3Fee: 3000 },
      sushiswap: { kind: 0, addr: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F' },
      curve: { kind: 3, addr: ethers.ZeroAddress, curveI: 0, curveJ: 1 },
      balancer: { kind: 2, addr: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', poolId: ethers.ZeroHash },
      pancakeswap: { kind: 0, addr: ethers.ZeroAddress },
      fraxswap: { kind: 0, addr: ethers.ZeroAddress },
      quickswap: { kind: 0, addr: ethers.ZeroAddress },
    },
  },
  polygon: {
    aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    routers: {
      uniswap: { kind: 1, addr: '0xE592427A0AEce92De3Edee1F18E0157C05861564', v3Fee: 3000 },
      sushiswap: { kind: 0, addr: '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506' },
      curve: { kind: 3, addr: ethers.ZeroAddress, curveI: 0, curveJ: 1 },
      balancer: { kind: 2, addr: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', poolId: ethers.ZeroHash },
      pancakeswap: { kind: 0, addr: ethers.ZeroAddress },
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

async function main() {
  if (!CHAINS[CHAIN]) throw new Error(`Unsupported CHAIN: ${CHAIN}`);

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
    const { quote } = parsePair(opp.pair);
    const chainTokens = CHAINS[CHAIN].tokens;
    const loanAsset = chainTokens[quote];
    const crv = chainTokens.CRV;
    if (!loanAsset || !crv) continue;

    const buyCfg = routerConfig(CHAIN, opp.buyDexId);
    const sellCfg = routerConfig(CHAIN, opp.sellDexId);
    if (!buyCfg || !sellCfg) continue;
    if (buyCfg.addr === ethers.ZeroAddress || sellCfg.addr === ethers.ZeroAddress) {
      console.log(`Skipping ${opp.pair}: router/pool address missing (${opp.buyDexId} or ${opp.sellDexId})`);
      continue;
    }

    // Use 100k quote notional with token decimals approximation = 18.
    // For production, query decimals() and normalize correctly.
    const loanAmount = ethers.parseUnits(String(LOAN_USD), 18);

    const buyLeg = makeLeg(buyCfg, loanAsset, crv, loanAmount, 1n);

    // Conservative lower-bound minOut to reduce reverts.
    const sellAmountOutMinFloat = toMinOut(LOAN_USD, opp.spread, 5000);
    const sellLeg = makeLeg(sellCfg, crv, loanAsset, 0n, ethers.parseUnits(String(Math.floor(sellAmountOutMinFloat)), 18));

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
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
