/**
 * Messages that depend on whose app this is. The host sets its key and chains in .env; a friend's copy gets its key
 * from the friend's Account page and everything else from the host (env.ts readCopy).
 */
import { readCopy } from './env';

/** `${what} needs …`: where the signing key is added. */
export function noKey(what = 'Live mode'): string {
  return readCopy() ? `${what} needs your key: add it under Account.` : `${what} needs PRIVATE_KEY in .env`;
}

/** A fix only the host can make (in .env, a restart): a friend's copy asks the host to make it. */
export function hostFix(fix: string): string {
  const c = readCopy();
  return c ? `Ask ${c.host} to: ${fix[0].toLowerCase()}${fix.slice(1)}` : fix;
}
