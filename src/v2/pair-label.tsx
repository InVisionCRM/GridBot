/** `ETH/USDC · Ethereum · Uniswap V3`. */
export function PairTitle({ pair, chainName, dex }: { pair: string; chainName?: string; dex?: string }) {
  const bits = [pair, chainName && chainName !== '—' ? chainName : '', dex && dex !== '—' ? dex : ''].filter(Boolean);
  return <span className="pair-title">{bits.join(' · ')}</span>;
}

/** Conventional pair plus a chain badge. The chain is not glued on with a dot. */
export function PairLabel({ pair, chain, className = '' }: { pair: string; chain?: string; className?: string }) {
  const mark = chain && chain !== '—' ? chain : '';
  return (
    <span className={`pair-label ${className}`.trim()}>
      <b>{pair}</b>
      {mark && <i className="chain-badge">{mark}</i>}
    </span>
  );
}
