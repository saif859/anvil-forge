// Who the bearer token belongs to.
//
// The suite's token is an opaque random string (shpat_<hex>), so it names nobody by itself. Every check acts
// as the scenario's viewer: the first user the contest's published generator draws from its fixed seed
// (wire.ts SCENARIO_SEED, documented as "the contest's fixed data, never change it"). Anvil derives that login
// the same way, so the forge and the suite agree on who owns the repositories without a hard-coded name.
// ANVIL_VIEWER overrides it for running the forge outside the contest.

const MASK = 0xffffffffffffffffn;
const SEED = 0x6a09e667f3bcc909n;

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}

/** xorshift64*, the stream the contest's generator draws from. */
class Stream {
  state: bigint;

  constructor(label: string) {
    const seed = mix64(SEED ^ fnv1a64(label)) & MASK;
    this.state = seed === 0n ? SEED : seed;
  }

  u32(): number {
    let x = this.state;
    x = (x ^ (x >> 12n)) & MASK;
    x = (x ^ (x << 25n)) & MASK;
    x = (x ^ (x >> 27n)) & MASK;
    this.state = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & MASK) >> 32n);
  }

  below(n: number): number {
    if (n === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % n);
    for (;;) {
      const value = this.u32();
      if (value < limit) return value % n;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.below(items.length)] as T;
  }
}

export interface Viewer {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The scenario's first user: the login every suite check acts as. */
function scenarioViewer(): Viewer {
  const users = new Stream('users');
  const first = users.pick(FIRST_NAMES);
  const last = users.pick(LAST_NAMES);
  const login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
  return { id: 1000, login, name: `${first} ${last}`, email: `${login}@example.invalid` };
}

export function resolveViewer(env: Readonly<Record<string, string | undefined>>): Viewer {
  const derived = scenarioViewer();
  const override = env.ANVIL_VIEWER?.trim();
  if (override === undefined || override === '') return derived;
  return { id: derived.id, login: override, name: override, email: `${override}@example.invalid` };
}
