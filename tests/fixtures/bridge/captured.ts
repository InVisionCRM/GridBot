/**
 * Read-only quote and status bodies for Ethereum (1) and Robinhood Chain (4663).
 *
 * Captured 2026-10-27T23:53:36.000Z. Sender and recipient are the public placeholder
 * 0x1111111111111111111111111111111111111111. Amounts are 10 USDC or 10 USDG
 * (10000000 raw) and 0.01 WETH (10^16 raw), with 50 bps of slippage. No quote key
 * was sent. Nothing was signed and nothing was broadcast.
 *
 * across-weth-1-4663.json was recaptured later the same night after the first
 * request timed out. Its quote expiry is still after BRIDGE_CAPTURED_AT, so the
 * suite clocks every fixture at that timestamp.
 *
 * logoURI and metadata were removed. Calldata was kept. Relay's v2 depository
 * 0x4cD00E387622C35bDDB9b4c962C136462338BC31 is protocol.v2.depository on both
 * chains in live/relay-chains-1-4663.json. Chain 4663 has no USDC; the USDC legs
 * are Ethereum USDC and Robinhood USDG.
 */
export const BRIDGE_CAPTURED_AT = '2026-10-27T23:53:36.000Z';

export const BRIDGE_CAPTURED_AT_MS = Date.parse(BRIDGE_CAPTURED_AT);
