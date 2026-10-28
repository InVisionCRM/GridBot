/**
 * Placeholder aggregator. A later change can replace it with a real quoter.
 * Returning null means "no external route", so the app's own DEX adapters decide.
 */
import type { AggregatorRequest, SwapAggregator } from './types';

export class NullAggregator implements SwapAggregator {
  readonly id = 'none';
  async quote(_req: AggregatorRequest) { return null; }
}
