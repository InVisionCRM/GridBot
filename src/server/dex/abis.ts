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
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
/** bytes32 symbol/name (MKR-style tokens) */
export const ERC20_B32 = new Interface(['function symbol() view returns (bytes32)', 'function name() view returns (bytes32)']);
export const WPLS_EVENTS = new Interface(['event Withdrawal(address indexed src, uint256 wad)']);

export const V3_FACTORY = new Interface(['function getPool(address, address, uint24) view returns (address)']);
export const V3_POOL = new Interface([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
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
