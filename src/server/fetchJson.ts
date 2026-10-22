/** JSON over HTTPS for the explorer (Tools → Convert) and DexScreener (pair search). A non-2xx answer is an error. */
export type FetchJson = (url: string) => Promise<unknown>;

export const fetchJson: FetchJson = async (url) => {
  const r = await fetch(url, { headers: { 'user-agent': 'GridBot' }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r.json();
};
