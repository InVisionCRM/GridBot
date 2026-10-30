import { getAddress, id, keccak256, toUtf8Bytes } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEAD_ADDRESS, EIP1967_ADMIN, EIP1967_BEACON, EIP1967_IMPLEMENTATION, POWER_SIGS, ZERO_ADDRESS,
  assessOwnerPowers, decodeAddressWord, decodeSlot, isRenouncedOwner, powersInBytecode,
  type OwnerFacts,
} from '../src/market/ownerPowers';
import { clearOwnerCache, readOwnerPowers, type OwnerReader } from '../src/server/market/ownerRead';

const LIVE = getAddress(`0x${'ab'.repeat(20)}`);
const ADMIN = getAddress(`0x${'cd'.repeat(20)}`);
const IMPL = getAddress(`0x${'11'.repeat(20)}`);
const BEACON = getAddress(`0x${'22'.repeat(20)}`);
const TOKEN = getAddress(`0x${'44'.repeat(20)}`);
const ZERO_WORD = `0x${'0'.repeat(64)}`;

const word = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, '0')}`;
const code = (...sigs: string[]) => `0x${sigs.map((s) => id(s).slice(2, 10)).join('aaaa')}63`;
const ownerData = id('owner()').slice(0, 10);
const getOwnerData = id('getOwner()').slice(0, 10);
const implData = id('implementation()').slice(0, 10);

function facts(o: Partial<OwnerFacts> = {}): OwnerFacts {
  return {
    tokenCode: code(),
    impl: { state: 'empty' },
    admin: { state: 'empty' },
    beacon: { state: 'empty' },
    owner: { state: 'address', address: LIVE },
    ...o,
  };
}

describe('owner power scan', () => {
  it('matches the EIP-1967 slots and treats zero and dead as renounced', () => {
    const slot = (name: string) => `0x${(BigInt(keccak256(toUtf8Bytes(name))) - 1n).toString(16).padStart(64, '0')}`;
    expect(slot('eip1967.proxy.implementation')).toBe(EIP1967_IMPLEMENTATION);
    expect(slot('eip1967.proxy.admin')).toBe(EIP1967_ADMIN);
    expect(slot('eip1967.proxy.beacon')).toBe(EIP1967_BEACON);
    expect(new Set(POWER_SIGS.map((p) => p.selector)).size).toBe(POWER_SIGS.length);
    expect(isRenouncedOwner(ZERO_ADDRESS)).toBe(true);
    expect(isRenouncedOwner(getAddress(DEAD_ADDRESS))).toBe(true);
    expect(isRenouncedOwner(LIVE)).toBe(false);
    expect(decodeAddressWord(ZERO_WORD)).toEqual({ ok: true, address: getAddress(ZERO_ADDRESS) });
    expect(decodeAddressWord(word(DEAD_ADDRESS)).ok && isRenouncedOwner(decodeAddressWord(word(DEAD_ADDRESS)).ok ? (decodeAddressWord(word(DEAD_ADDRESS)) as { address: string }).address : '')).toBe(true);
    expect(decodeSlot(ZERO_WORD)).toEqual({ state: 'empty' });
    expect(decodeSlot('0x')).toEqual({ state: 'fail' });
    expect(decodeAddressWord('0x1234')).toEqual({ ok: false });
  });

  it('finds mint, blacklist, pause, tax, limit, trading, fee-exempt and upgrade selectors', () => {
    const sigs = [
      'mint(uint256)', 'setBlacklist(address,bool)', 'pause()', 'setTax(uint256)', 'setMaxWallet(uint256)',
      'enableTrading()', 'excludeFromFee(address,bool)', 'upgradeTo(address)',
    ];
    const found = powersInBytecode(code(...sigs));
    expect(found?.map((p) => p.sig)).toEqual(sigs);
    expect(powersInBytecode('0x')).toBeNull();
    expect(powersInBytecode(null)).toBeNull();
    expect(powersInBytecode(code('mint(uint256)'))?.some((p) => p.sig === 'mint(address,uint256)')).toBe(false);
  });

  it('a live owner holding setTax(uint256) blocks; a renounced owner with the same power does not; a mint never blocks (2026-10-30)', () => {
    const live = assessOwnerPowers(facts({ tokenCode: code('setTax(uint256)') }));
    expect(live.unverified).toBe(false);
    expect(live.why).toMatch(/holds setTax\(uint256\)/);
    expect(live.renounced).toBe(false);
    const mint = assessOwnerPowers(facts({ tokenCode: code('mint(uint256)') }));
    expect(mint.why).toBeNull();
    expect(mint.note).toMatch(/mint\(uint256\)/);

    for (const owner of [getAddress(ZERO_ADDRESS), getAddress(DEAD_ADDRESS)]) {
      const gone = assessOwnerPowers(facts({ tokenCode: code('mint(address,uint256)'), owner: { state: 'address', address: owner } }));
      expect(gone.why).toBeNull();
      expect(gone.note).toMatch(/owner renounced/);
      expect(gone.note).toMatch(/mint\(address,uint256\)/);
      expect(gone.note).toMatch(/not upgradeable/);
    }
  });

  it('reports trading and fee-exempt setters and does not block on them', () => {
    const r = assessOwnerPowers(facts({ tokenCode: code('enableTrading()', 'setFeeExempt(address,bool)') }));
    expect(r.why).toBeNull();
    expect(r.note).toMatch(/enableTrading\(\)/);
    expect(r.note).toMatch(/setFeeExempt\(address,bool\)/);
    expect(r.note).toMatch(/no mint, blacklist, pause, or tax\/limit powers/);
    expect(r.note).toMatch(/not upgradeable/);
  });

  it('blocks blacklist, pause, tax and limit setters held by a live owner', () => {
    for (const sig of ['setBot(address,bool)', 'setPaused(bool)', 'setBuyTax(uint256)', 'setMaxTxAmount(uint256)']) {
      const r = assessOwnerPowers(facts({ tokenCode: code(sig) }));
      expect(r.why).toMatch(new RegExp(sig.replace(/[()]/g, '\\$&')));
    }
  });

  it('a live proxy admin blocks even when the token owner is renounced; a renounced admin does not', () => {
    const live = assessOwnerPowers(facts({
      owner: { state: 'address', address: getAddress(ZERO_ADDRESS) },
      admin: { state: 'address', address: ADMIN },
      adminOwner: { state: 'fail' },
    }));
    expect(live.why).toMatch(/upgradeable by live admin/);
    expect(live.liveAdmin).toBe(ADMIN);

    const owned = assessOwnerPowers(facts({
      owner: { state: 'address', address: getAddress(ZERO_ADDRESS) },
      admin: { state: 'address', address: ADMIN },
      adminOwner: { state: 'address', address: LIVE },
    }));
    expect(owned.liveAdmin).toBe(LIVE);

    const gone = assessOwnerPowers(facts({
      admin: { state: 'address', address: ADMIN },
      adminOwner: { state: 'address', address: getAddress(DEAD_ADDRESS) },
    }));
    expect(gone.why).toBeNull();
    expect(gone.liveAdmin).toBeNull();

    const deadSlot = assessOwnerPowers(facts({ admin: { state: 'address', address: getAddress(DEAD_ADDRESS) } }));
    expect(deadSlot.why).toBeNull();
  });

  it('a beacon with a live owner blocks; a failed beacon read is unverified', () => {
    const live = assessOwnerPowers(facts({
      owner: { state: 'address', address: getAddress(ZERO_ADDRESS) },
      beacon: { state: 'address', address: BEACON },
      beaconOwner: { state: 'address', address: LIVE },
    }));
    expect(live.why).toMatch(/upgradeable by live admin/);

    const unread = assessOwnerPowers(facts({
      beacon: { state: 'address', address: BEACON },
      beaconOwner: { state: 'fail' },
    }));
    expect(unread.unverified).toBe(true);
    expect(unread.why).toMatch(/beacon admin unread/);

    const noImpl = assessOwnerPowers(facts({
      beacon: { state: 'address', address: BEACON },
      beaconOwner: { state: 'address', address: getAddress(ZERO_ADDRESS) },
      beaconImplFailed: true,
    }));
    expect(noImpl.unverified).toBe(true);
    expect(noImpl.why).toMatch(/beacon implementation unread/);
  });

  it('UUPS with a live implementation owner blocks; a renounced or unread one does not pass as clean', () => {
    const live = assessOwnerPowers(facts({
      tokenCode: code(),
      impl: { state: 'address', address: IMPL },
      implCode: code('upgradeTo(address)', 'setTax(uint256)'),
      implOwner: { state: 'address', address: LIVE },
    }));
    expect(live.why).toMatch(/holds setTax\(uint256\)/);
    expect(live.why).toMatch(/upgradeable by live admin/);

    const renouncedImpl = assessOwnerPowers(facts({
      owner: { state: 'address', address: getAddress(ZERO_ADDRESS) },
      impl: { state: 'address', address: IMPL },
      implCode: code('upgradeToAndCall(address,bytes)'),
      implOwner: { state: 'address', address: getAddress(ZERO_ADDRESS) },
    }));
    expect(renouncedImpl.why).toBeNull();
    expect(renouncedImpl.note).toMatch(/not upgradeable/);

    const unread = assessOwnerPowers(facts({
      impl: { state: 'address', address: IMPL },
      implCode: code('upgradeTo(address)'),
      implOwner: { state: 'fail' },
    }));
    expect(unread.unverified).toBe(true);
    expect(unread.why).toMatch(/implementation owner unread/);
  });

  it('missing bytecode, a failed slot, or an unread owner who might hold a power is unverified', () => {
    expect(assessOwnerPowers(facts({ tokenCode: null })).why).toMatch(/bytecode unread/);
    expect(assessOwnerPowers(facts({ impl: { state: 'fail' } })).why).toMatch(/proxy slots unread/);
    const unread = assessOwnerPowers(facts({ tokenCode: code('setTax(uint256)'), owner: { state: 'fail' } }));
    expect(unread.unverified).toBe(true);
    expect(unread.why).toMatch(/owner unread/);
    expect(unread.why).toMatch(/setTax\(uint256\)/);
    const noPower = assessOwnerPowers(facts({ owner: { state: 'fail' } }));
    expect(noPower.unverified).toBe(false);
    expect(noPower.why).toBeNull();
    expect(noPower.note).toMatch(/owner unread/);
    expect(assessOwnerPowers(facts({ impl: { state: 'address', address: IMPL }, implCode: null })).why).toMatch(/implementation bytecode unread/);
  });

  it('a clean token reports no blocking powers', () => {
    const r = assessOwnerPowers(facts());
    expect(r.why).toBeNull();
    expect(r.unverified).toBe(false);
    expect(r.note).toMatch(/no mint, blacklist, pause, or tax\/limit powers/);
    expect(r.note).toMatch(/not upgradeable/);
  });
});

describe('owner power reads', () => {
  beforeEach(() => clearOwnerCache());

  function scripted(o: {
    code?: Record<string, string>;
    throwCode?: boolean;
    storage?: Record<string, string>;
    throwStorage?: boolean;
    calls?: Record<string, string>;
    noCode?: boolean;
    noStorage?: boolean;
  }) {
    const seen: string[] = [];
    const reader: OwnerReader = {
      async call({ to, data }) {
        seen.push(`call ${data}`);
        const v = o.calls?.[`${to.toLowerCase()} ${data}`];
        if (v == null) throw new Error('revert');
        return v;
      },
    };
    if (!o.noCode) reader.getCode = async (a) => {
      seen.push(`code ${a.toLowerCase()}`);
      if (o.throwCode) throw new Error('code');
      const v = o.code?.[a.toLowerCase()];
      if (v == null) throw new Error('code');
      return v;
    };
    if (!o.noStorage) reader.getStorage = async (_a, slot) => {
      seen.push(`slot ${slot}`);
      if (o.throwStorage) throw new Error('slot');
      const v = o.storage?.[slot.toLowerCase()];
      if (v == null) throw new Error('slot');
      return v;
    };
    return { reader, seen };
  }

  const emptySlots = {
    [EIP1967_IMPLEMENTATION]: ZERO_WORD,
    [EIP1967_ADMIN]: ZERO_WORD,
    [EIP1967_BEACON]: ZERO_WORD,
  };

  it('reads a live tax setter, then serves the cached report without another call', async () => {
    const { reader, seen } = scripted({
      code: { [TOKEN.toLowerCase()]: code('setTax(uint256)') },
      storage: emptySlots,
      calls: { [`${TOKEN.toLowerCase()} ${ownerData}`]: word(LIVE) },
    });
    const r = await readOwnerPowers(reader, 4663, TOKEN, { paceMs: 0 });
    expect(r.why).toMatch(/holds setTax\(uint256\)/);
    const n = seen.length;
    expect(n).toBeGreaterThan(0);
    const again = await readOwnerPowers(reader, 4663, TOKEN, { paceMs: 0 });
    expect(again.why).toBe(r.why);
    expect(seen.length).toBe(n);
  });

  it('uses getOwner when owner() reverts, and treats a zero owner as renounced', async () => {
    const { reader } = scripted({
      code: { [TOKEN.toLowerCase()]: code('mint(address,uint256)') },
      storage: emptySlots,
      calls: { [`${TOKEN.toLowerCase()} ${getOwnerData}`]: word(ZERO_ADDRESS) },
    });
    const r = await readOwnerPowers(reader, 4663, TOKEN, { paceMs: 0 });
    expect(r.why).toBeNull();
    expect(r.renounced).toBe(true);
    expect(r.note).toMatch(/mint\(address,uint256\)/);
  });

  it('an admin whose owner() reverts is a live admin', async () => {
    const { reader } = scripted({
      code: { [TOKEN.toLowerCase()]: code() },
      storage: { ...emptySlots, [EIP1967_ADMIN]: word(ADMIN) },
      calls: { [`${TOKEN.toLowerCase()} ${ownerData}`]: word(ZERO_ADDRESS) },
    });
    const r = await readOwnerPowers(reader, 4663, TOKEN, { paceMs: 0 });
    expect(r.why).toMatch(new RegExp(`upgradeable by live admin ${ADMIN.slice(0, 6)}`));
  });

  it('a beacon owner and a UUPS implementation owner are live admins', async () => {
    const beacon = scripted({
      code: { [TOKEN.toLowerCase()]: code(), [IMPL.toLowerCase()]: code() },
      storage: { ...emptySlots, [EIP1967_BEACON]: word(BEACON) },
      calls: {
        [`${TOKEN.toLowerCase()} ${ownerData}`]: word(ZERO_ADDRESS),
        [`${BEACON.toLowerCase()} ${ownerData}`]: word(LIVE),
        [`${BEACON.toLowerCase()} ${implData}`]: word(IMPL),
      },
    });
    const b = await readOwnerPowers(beacon.reader, 4663, TOKEN, { paceMs: 0 });
    expect(b.why).toMatch(/upgradeable by live admin/);
    clearOwnerCache();

    const uups = scripted({
      code: { [TOKEN.toLowerCase()]: code(), [IMPL.toLowerCase()]: code('upgradeTo(address)') },
      storage: { ...emptySlots, [EIP1967_IMPLEMENTATION]: word(IMPL) },
      calls: {
        [`${TOKEN.toLowerCase()} ${ownerData}`]: word(ZERO_ADDRESS),
        [`${IMPL.toLowerCase()} ${ownerData}`]: word(LIVE),
      },
    });
    const u = await readOwnerPowers(uups.reader, 4663, TOKEN, { paceMs: 0 });
    expect(u.why).toMatch(/upgradeable by live admin/);
    expect(u.why).not.toMatch(/holds /);
  });

  it('a thrown read or a reader without storage is unverified and does not throw', async () => {
    const blown = scripted({ throwCode: true, throwStorage: true, code: {}, storage: {} });
    const failed = await readOwnerPowers(blown.reader, 4663, TOKEN, { paceMs: 0 });
    expect(failed.unverified).toBe(true);
    expect(failed.why).toMatch(/could not be verified/);

    clearOwnerCache();
    const bare = scripted({ noCode: true, noStorage: true });
    const missing = await readOwnerPowers(bare.reader, 4663, TOKEN, { paceMs: 0 });
    expect(missing.unverified).toBe(true);
    expect(bare.seen).toEqual([]);
  });
});
