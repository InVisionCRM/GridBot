import { Interface } from 'ethers';

/** Uniswap-V2 Router02 (PulseX names WETH() as WPLS()). */
export const ROUTER = new Interface([
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  // Fee-on-transfer variants (UniswapV2Router02; present on PulseX V1/V2, 9mm V2, Uniswap V2): the router checks
  // the recipient's balance change against amountOutMin instead of the pool's computed output.
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
  'function factory() view returns (address)',
  'function WPLS() view returns (address)',
  'function WETH() view returns (address)',
]);
export const FACTORY = new Interface(['function getPair(address, address) view returns (address)']);
export const PAIR = new Interface([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 ts)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);
export const ERC20 = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
/** bytes32 symbol/name (MKR-style tokens) */
export const ERC20_B32 = new Interface(['function symbol() view returns (bytes32)', 'function name() view returns (bytes32)']);
export const WPLS_EVENTS = new Interface(['event Withdrawal(address indexed src, uint256 wad)']);
/** The wrapped native coin (WPLS / WETH9): withdraw burns it for the same amount of the chain's own coin. */
export const WRAPPED = new Interface(['function withdraw(uint256 wad)']);

export const V3_FACTORY = new Interface(['function getPool(address, address, uint24) view returns (address)']);
export const V3_POOL = new Interface([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
]);
/**
 * Full slot0 for the protocol-fee setting. Uniswap returns feeProtocol as uint8, PancakeSwap forks (9mm V3) as uint32;
 * both sit in the 6th 32-byte word, so one uint32 decode reads either (verified on Ethereum, Robinhood and 9mm pools).
 */
export const V3_POOL_FEES = new Interface([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
]);
/** Pool state a liquidity position needs: fee counters (Uniswap V3 and the PancakeSwap fork share this layout). */
export const V3_POOL_LP = new Interface([
  'function tickSpacing() view returns (int24)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
]);
/**
 * NonfungiblePositionManager (Uniswap V3 periphery; 9mm V3 is the PancakeSwap fork with the same calls). Verified
 * 2026-10-18 on-chain: factory() and WETH9() match chains.ts on Ethereum, Robinhood and PulseChain (9mm).
 */
export const V3_NPM = new Interface([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function refundETH() payable',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function sweepToken(address token, uint256 amountMinimum, address recipient) payable',
  'function factory() view returns (address)',
  'function WETH9() view returns (address)',
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);
/** ERC-721 enumerable: how a wallet's V3 position NFTs are listed (balanceOf + tokenOfOwnerByIndex). */
export const ERC721_ENUM = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
]);
export const V3_QUOTER = new Interface([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
  'function factory() view returns (address)',
  'function WETH9() view returns (address)',
]);
/** SwapRouter02 (Uniswap) / SmartRouter (PancakeSwap): same IV3SwapRouter + payments surface. */
export const V3_ROUTER = new Interface([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function factory() view returns (address)',
  'function WETH9() view returns (address)',
]);
export const ARB_NODE_INTERFACE = new Interface(['function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)']);
export const ARB_NODE_INTERFACE_ADDR = '0x00000000000000000000000000000000000000C8';
