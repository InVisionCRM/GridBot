/**
 * Mocked HTTP bodies shaped like the published Across, Relay, and Li.Fi responses.
 * Addresses are the ones pinned in src/live/chains.ts. Nothing here is a live capture,
 * and nothing in the suite calls those hosts.
 */
import { Interface, getAddress } from 'ethers';
import { chainById } from '../../src/live/chains';
import { ACROSS_SPOKE, LIFI_DIAMOND, lifiFeeAmount } from '../../src/server/bridge';
import type { BridgeQuoteRequest, BridgeToken } from '../../src/server/bridge';

export const NOW_MS = 1_800_000_000_000;
export const NOW_SEC = 1_800_000_000;

const eth = chainById(1)!;
const hood = chainById(4663)!;

export const WETH_ETH: BridgeToken = { chainId: 1, address: getAddress(eth.wrappedNative.address), decimals: 18, symbol: 'WETH' };
export const WETH_HOOD: BridgeToken = { chainId: 4663, address: getAddress(hood.wrappedNative.address), decimals: 18, symbol: 'WETH' };
export const USDC: BridgeToken = { chainId: 1, address: getAddress(eth.stables.find((s) => s.symbol === 'USDC')!.address), decimals: 6, symbol: 'USDC' };
export const USDG: BridgeToken = { chainId: 4663, address: getAddress(hood.stables[0].address), decimals: 6, symbol: 'USDG' };

export const SENDER = getAddress('0x1111111111111111111111111111111111111111');
export const RECIPIENT = getAddress('0x2222222222222222222222222222222222222222');
export const OTHER = getAddress('0x3333333333333333333333333333333333333333');
export const RELAYER = getAddress('0x394311a6aaa0d8e3411d8b62de4578d41322d1bd');
export const ZERO = getAddress('0x0000000000000000000000000000000000000000');
export const FILL_TX = `0x${'ab'.repeat(32)}`;
export const REQUEST_ID = `0x${'22'.repeat(32)}`;

export const ETH_IN = 10_000_000_000_000_000n;
export const ETH_LP = 1_000_000_000_000n;
export const ETH_CAPITAL = 2_000_000_000_000n;
export const ETH_DEST_GAS = 4_000_000_000_000n;
export const ETH_OUT = ETH_IN - ETH_LP - ETH_CAPITAL - ETH_DEST_GAS;

export const USDC_IN = 10_000_000n;
export const USDC_OUT = 9_970_000n;
export const USDC_MIN = 9_960_000n;
export const USDC_LP = 10_000n;
export const USDC_CAPITAL = 15_000n;
export const USDC_DEST_GAS = 5_000n;
export const ORIGIN_GAS = 21_000_000_000_000n;

const APPROVE = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);

export function approveData(tokenSpender: string, amount: bigint): string {
  return APPROVE.encodeFunctionData('approve', [tokenSpender, amount]);
}

export interface Leg { src: BridgeToken; dst: BridgeToken; sameAsset: boolean; amountIn: bigint }

export const LEGS: Leg[] = [
  { src: WETH_ETH, dst: WETH_HOOD, sameAsset: true, amountIn: ETH_IN },
  { src: WETH_HOOD, dst: WETH_ETH, sameAsset: true, amountIn: ETH_IN },
  { src: USDC, dst: USDG, sameAsset: false, amountIn: USDC_IN },
  { src: USDG, dst: USDC, sameAsset: false, amountIn: USDC_IN },
];

export function requestOf(leg: Leg): BridgeQuoteRequest {
  return {
    srcChain: leg.src.chainId,
    dstChain: leg.dst.chainId,
    tokenIn: leg.src,
    tokenOut: leg.dst,
    amountIn: leg.amountIn,
    recipient: RECIPIENT,
    sender: SENDER,
    sameAsset: leg.sameAsset,
  };
}

function apiToken(t: BridgeToken) {
  return { address: t.address, symbol: t.symbol, decimals: t.decimals, chainId: t.chainId };
}

export function acrossSuggested(leg: Leg): unknown {
  const ts = NOW_SEC - 30;
  const total = ETH_LP + ETH_CAPITAL + ETH_DEST_GAS;
  return {
    estimatedFillTimeSec: 8,
    timestamp: String(ts),
    isAmountTooLow: false,
    exclusiveRelayer: RELAYER,
    exclusivityDeadline: ts + 120,
    spokePoolAddress: ACROSS_SPOKE[leg.src.chainId],
    totalRelayFee: { pct: '1', total: total.toString() },
    relayerCapitalFee: { pct: '1', total: ETH_CAPITAL.toString() },
    relayerGasFee: { pct: '1', total: ETH_DEST_GAS.toString() },
    lpFee: { pct: '0', total: ETH_LP.toString() },
    fillDeadline: String(ts + 3_600),
    outputAmount: ETH_OUT.toString(),
    inputToken: apiToken(leg.src),
    outputToken: apiToken(leg.dst),
    id: `across-fees-${leg.src.chainId}-${leg.dst.chainId}`,
  };
}

export function acrossSwap(leg: Leg, patch: Record<string, unknown> = {}): unknown {
  const out = leg.sameAsset ? ETH_OUT : USDC_OUT;
  const min = leg.sameAsset ? ETH_OUT : USDC_MIN;
  const lp = leg.sameAsset ? ETH_LP : USDC_LP;
  const capital = leg.sameAsset ? ETH_CAPITAL : USDC_CAPITAL;
  const dest = leg.sameAsset ? ETH_DEST_GAS : USDC_DEST_GAS;
  return {
    id: `across-swap-${leg.src.chainId}-${leg.dst.chainId}`,
    recipient: RECIPIENT,
    expectedOutputAmount: out.toString(),
    minOutputAmount: min.toString(),
    expectedFillTime: 12,
    quoteExpiryTimestamp: NOW_SEC + 300,
    inputToken: apiToken(leg.src),
    outputToken: apiToken(leg.dst),
    swapTx: {
      simulationSuccess: true,
      chainId: leg.src.chainId,
      to: OTHER,
      data: `0x${'ee'.repeat(36)}`,
      value: '0',
      gas: '250000',
    },
    approvalTxns: [{
      chainId: leg.src.chainId,
      to: leg.src.address,
      data: approveData(OTHER, leg.amountIn),
    }],
    steps: {
      bridge: {
        fees: {
          details: {
            lp: { amount: lp.toString(), token: apiToken(leg.src) },
            relayerCapital: { amount: capital.toString(), token: apiToken(leg.src) },
            destinationGas: { amount: dest.toString(), token: apiToken(leg.src) },
          },
        },
      },
    },
    fees: {
      originGas: { amount: ORIGIN_GAS.toString(), token: { address: ZERO, decimals: 18, chainId: leg.src.chainId } },
    },
    ...patch,
  };
}

export function relayQuote(leg: Leg, patch: { amountOut?: bigint; minOut?: bigint } = {}): unknown {
  const amountOut = patch.amountOut ?? (leg.sameAsset ? ETH_OUT : USDC_OUT);
  const minOut = patch.minOut ?? (leg.sameAsset ? ETH_OUT : USDC_MIN);
  const bridge = 1_000n;
  const relayer = leg.sameAsset ? ETH_CAPITAL : USDC_CAPITAL;
  const dest = leg.sameAsset ? ETH_DEST_GAS : USDC_DEST_GAS;
  const money = (token: BridgeToken, amount: bigint) => ({
    amount: amount.toString(),
    currency: apiToken(token),
  });
  return {
    requestId: REQUEST_ID,
    steps: [{
      id: 'deposit',
      requestId: REQUEST_ID,
      kind: 'transaction',
      items: [
        {
          status: 'incomplete',
          data: {
            from: SENDER,
            to: leg.src.address,
            data: approveData(OTHER, leg.amountIn),
            value: '0',
            chainId: leg.src.chainId,
          },
        },
        {
          status: 'incomplete',
          data: {
            from: SENDER,
            to: OTHER,
            data: `0x${'ab'.repeat(20)}`,
            value: '0',
            chainId: leg.src.chainId,
          },
        },
      ],
    }],
    fees: {
      gas: { amount: ORIGIN_GAS.toString(), currency: { address: ZERO, decimals: 18, chainId: leg.src.chainId } },
      relayer: money(leg.src, relayer),
      relayerGas: money(leg.src, dest),
      app: money(leg.src, bridge),
    },
    details: {
      sender: SENDER,
      recipient: RECIPIENT,
      currencyIn: { currency: apiToken(leg.src), amount: leg.amountIn.toString(), minimumAmount: leg.amountIn.toString() },
      currencyOut: { currency: apiToken(leg.dst), amount: amountOut.toString(), minimumAmount: minOut.toString() },
      timeEstimate: 15,
    },
  };
}

export function lifiQuote(leg: Leg, opts: { omitLifiFee?: boolean; feeAmount?: bigint; percentage?: string; diamond?: string } = {}): unknown {
  const amountOut = leg.sameAsset ? ETH_OUT : USDC_OUT;
  const minOut = leg.sameAsset ? ETH_OUT : USDC_MIN;
  const fee = opts.feeAmount ?? lifiFeeAmount(leg.amountIn);
  const feeCosts = [
    ...(opts.omitLifiFee ? [] : [{
      name: 'LIFI Fixed Fee',
      description: 'Fixed LIFI fee',
      percentage: opts.percentage ?? '0.0025',
      amount: fee.toString(),
      included: true,
      token: apiToken(leg.src),
    }]),
    {
      name: 'Across bridge fee',
      percentage: '0.001',
      amount: (leg.sameAsset ? ETH_CAPITAL : USDC_CAPITAL).toString(),
      included: true,
      token: apiToken(leg.src),
    },
  ];
  return {
    id: `lifi-${leg.src.chainId}-${leg.dst.chainId}-${leg.src.symbol}`,
    type: 'lifi',
    tool: 'across',
    action: {
      fromChainId: leg.src.chainId,
      toChainId: leg.dst.chainId,
      fromToken: apiToken(leg.src),
      toToken: apiToken(leg.dst),
      fromAmount: leg.amountIn.toString(),
      fromAddress: SENDER,
      toAddress: RECIPIENT,
    },
    estimate: {
      fromAmount: leg.amountIn.toString(),
      toAmount: amountOut.toString(),
      toAmountMin: minOut.toString(),
      approvalAddress: LIFI_DIAMOND,
      executionDuration: 20,
      feeCosts,
      gasCosts: [{
        type: 'SEND',
        amount: ORIGIN_GAS.toString(),
        token: { address: ZERO, decimals: 18, chainId: leg.src.chainId, symbol: 'ETH' },
      }],
    },
    transactionRequest: {
      from: SENDER,
      to: opts.diamond ?? LIFI_DIAMOND,
      chainId: leg.src.chainId,
      data: `0x${'cd'.repeat(16)}`,
      value: '0',
      gasLimit: '250000',
    },
  };
}
