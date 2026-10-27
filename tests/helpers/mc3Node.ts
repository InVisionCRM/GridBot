/** A node in front of a mock chain that also runs Multicall3 (aggregate3 / getEthBalance), counting RPC requests. */
import { MC3, MULTICALL3 } from '../../src/server/chains/multicall';

type Inner = { call(tx: { to: string; data: string; from?: string }): Promise<string>; getBalance(a: string): Promise<bigint>; getCode?(a: string): Promise<string> };

export function mc3Node<T extends Inner>(inner: T, o: { deployed?: boolean; failAggregate?: () => boolean } = {}) {
  const counts = { requests: 0, byMethod: {} as Record<string, number> };
  const hit = (m: string) => { counts.requests++; counts.byMethod[m] = (counts.byMethod[m] ?? 0) + 1; };
  const node = new Proxy(inner, {
    get(t, p) {
      if (p === 'counts') return counts;
      if (p === 'call') return async (tx: { to: string; data: string; from?: string }) => {
        hit('eth_call');
        if (tx.to.toLowerCase() !== MULTICALL3.toLowerCase()) return t.call(tx);
        if (o.deployed === false) return '0x';
        if (o.failAggregate?.()) throw new Error('mock: aggregate3 failed (rate limited)');
        const [calls] = MC3.decodeFunctionData('aggregate3', tx.data) as unknown as [[string, boolean, string][]];
        const out: [boolean, string][] = [];
        for (const [target, , data] of calls) {
          try {
            if (target.toLowerCase() === MULTICALL3.toLowerCase()) {
              const [addr] = MC3.decodeFunctionData('getEthBalance', data);
              out.push([true, MC3.encodeFunctionResult('getEthBalance', [await t.getBalance(addr as string)])]);
            } else out.push([true, await t.call({ to: target, data })]);
          } catch { out.push([false, '0x']); }
        }
        return MC3.encodeFunctionResult('aggregate3', [out]);
      };
      if (p === 'getBalance') return (a: string) => { hit('eth_getBalance'); return t.getBalance(a); };
      if (p === 'getCode') return async (a: string) => {
        hit('eth_getCode');
        if (a.toLowerCase() === MULTICALL3.toLowerCase()) return o.deployed === false ? '0x' : '0x6080604052';
        return t.getCode ? t.getCode(a) : '0x';
      };
      const v = Reflect.get(t, p);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => { hit(String(p)); return (v as (...a: unknown[]) => unknown).apply(t, args); };
    },
  });
  return node as T & { counts: typeof counts };
}
