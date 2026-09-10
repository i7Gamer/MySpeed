import assert from 'node:assert/strict';
import dns from 'node:dns';
import shared from 'nodemailer/lib/shared/index.js';
import { createSmtpResolver } from '../../../../server/util/smtpResolver.js';
import { checkOutboundHost } from '../../../../server/util/safeUrl.js';
const HOST = 'smtp-compatible-fixture.invalid',
  SAFE = '127.0.0.1',
  SECOND = '127.0.0.2',
  BLOCKED = '169.254.169.254';
const TTL = 300_000,
  TIMEOUT = 30_000;
const interfaces = {
  fixture: [{
    family: 'IPv4',
    internal: false
  }, {
    family: 'IPv6',
    internal: false
  }]
};
const original = {
  Resolver: dns.Resolver,
  lookup: dns.lookup,
  now: Date.now,
  random: Math.random,
  interfaces: shared.networkInterfaces
};
export const resolverScenarios = [];
const err = code => Object.assign(new Error(code), {
  code
});
function harness() {
  const state = {
    now: 1_000_000,
    random: 0,
    a: [SAFE],
    aaaa: [],
    os: [{
      address: SECOND,
      family: 4
    }],
    aError: null,
    aaaaError: null,
    osError: null,
    calls: [],
    denied: new Set(),
    delays: [0, 0],
    queue: []
  };
  const call = (delay, fn) => delay ? state.queue.push({
    at: state.now + delay,
    fn
  }) : fn();
  const fake = {
    Resolver: class {
      constructor(options) {
        this.options = options;
      }
      resolve4(host, cb) {
        state.calls.push(['A', host, this.options.timeout]);
        call(state.delays[0], () => cb(state.aError, state.a));
      }
      resolve6(host, cb) {
        state.calls.push(['AAAA', host, this.options.timeout]);
        call(state.delays[1], () => cb(state.aaaaError, state.aaaa));
      }
    },
    lookup(host, options, cb) {
      state.calls.push(['OS', host, options.all]);
      cb(state.osError, state.os);
    }
  };
  dns.Resolver = fake.Resolver;
  dns.lookup = fake.lookup;
  Date.now = () => state.now;
  Math.random = () => state.random;
  shared.networkInterfaces = interfaces;
  shared.dnsCache.clear();
  shared._resetCacheCleanup();
  const cache = new Map();
  const resolver = {
    ...createSmtpResolver({
      cache,
      dnsApi: fake,
      networkInterfaces: interfaces,
      now: () => state.now,
      random: () => state.random,
      checkAddress: address => checkOutboundHost(address).safe && !state.denied.has(address)
    }),
    cache
  };
  const get = (adapter = true, host = HOST, options = {}) => {
    const out = {};
    const done = (error, value) => {
      out.error = error?.code || error?.message;
      if (!error) {
        out.addresses = adapter ? value.map(x => x.address) : [value.host, ...value._addresses.filter(x => x !== value.host)];
      }
    };
    if (adapter) resolver.lookup(host, {
      all: true,
      timeout: TIMEOUT,
      allowInternalNetworkInterfaces: true,
      ...options
    }, done);else shared.resolveHostname({
      host,
      timeout: TIMEOUT,
      allowInternalNetworkInterfaces: true,
      ...options
    }, done);
    return out;
  };
  const both = () => {
    const baseline = get(false);
    const candidate = get();
    assert.deepEqual(candidate, baseline);
    return candidate;
  };
  const advance = () => {
    while (state.queue.length) {
      state.queue.sort((a, b) => a.at - b.at);
      const item = state.queue.shift();
      state.now = item.at;
      item.fn();
    }
  };
  const outage = () => {
    state.aError = err('ETIMEOUT');
    state.aaaaError = err('ETIMEOUT');
    state.osError = err('EAI_AGAIN');
  };
  return {
    state,
    resolver,
    get,
    both,
    advance,
    outage
  };
}
function test(name, fn) {
  resolverScenarios.push({
    name,
    run: () => {
      try {
        fn(harness());
      } finally {
        dns.Resolver = original.Resolver;
        dns.lookup = original.lookup;
        Date.now = original.now;
        Math.random = original.random;
        shared.networkInterfaces = original.interfaces;
        shared.dnsCache.clear();
      }
    }
  });
}
test('permitted-literal-does-not-resolve', ({
  get,
  state
}) => {
  assert.deepEqual(get(true, SAFE).addresses, [SAFE]);
  assert.equal(state.calls.length, 0);
});
test('forbidden-literal-does-not-resolve', ({
  get,
  state
}) => {
  assert.ok(get(true, BLOCKED).error);
  assert.equal(state.calls.length, 0);
});
test('A-AAAA-precedence-and-random-fallback-order', ({
  state,
  both
}) => {
  state.a = [SAFE, SECOND];
  state.aaaa = ['::1'];
  state.random = 0.8;
  assert.deepEqual(both().addresses, ['::1', SAFE, SECOND]);
  assert.equal(state.calls.some(call => call[0] === 'OS'), false);
});
test('warm-cache-survives-DNS-error', ({
  state,
  both,
  outage
}) => {
  both();
  outage();
  state.calls = [];
  assert.deepEqual(both().addresses, [SAFE]);
  assert.equal(state.calls.length, 0);
});
test('expired-cache-survives-family-timeouts', ({
  state,
  both,
  outage
}) => {
  both();
  state.now += TTL + 1;
  outage();
  assert.deepEqual(both().addresses, [SAFE]);
});
test('expired-cache-survives-OS-error', ({
  state,
  both
}) => {
  both();
  state.now += TTL + 1;
  state.aError = err('ENODATA');
  state.aaaaError = err('ENODATA');
  state.osError = err('EAI_AGAIN');
  assert.deepEqual(both().addresses, [SAFE]);
});
test('OS-only-hosts-fallback', ({
  state,
  both
}) => {
  state.a = [];
  state.aaaa = [];
  state.os = [{
    address: SAFE,
    family: 4
  }];
  assert.deepEqual(both().addresses, [SAFE]);
});
test('split-DNS-keeps-DNS-precedence', ({
  state,
  both
}) => {
  state.os = [{
    address: SECOND,
    family: 4
  }];
  assert.deepEqual(both().addresses, [SAFE]);
});
test('fresh-answers-replace-expired-cache', ({
  state,
  both
}) => {
  both();
  state.now += TTL + 1;
  state.a = [SECOND];
  assert.deepEqual(both().addresses, [SECOND]);
});
test('warm-cache-keeps-existing-address-until-expiry', ({
  state,
  both
}) => {
  both();
  state.a = [SECOND];
  assert.deepEqual(both().addresses, [SAFE]);
});
test('fresh-mixed-answers-filtered-before-selection', ({
  state,
  get
}) => {
  state.a = [BLOCKED, SAFE];
  assert.deepEqual(get().addresses, [SAFE]);
});
test('fresh-blocked-answers-refused-without-OS-or-stale-fallback', ({
  state,
  get
}) => {
  get();
  state.now += TTL + 1;
  state.a = [BLOCKED];
  state.calls = [];
  assert.ok(get().error);
  assert.equal(state.calls.some(call => call[0] === 'OS'), false);
});
test('warm-cache-revalidated-against-current-policy', ({
  state,
  get
}) => {
  state.a = [SAFE, SECOND];
  assert.deepEqual(get().addresses, [SAFE, SECOND]);
  state.denied.add(SAFE);
  assert.deepEqual(get().addresses, [SECOND]);
  state.denied.add(SECOND);
  assert.ok(get().error);
});
test('stale-cache-revalidated-before-error-fallback', ({
  state,
  get,
  outage
}) => {
  get();
  state.now += TTL + 1;
  state.denied.add(SAFE);
  outage();
  assert.ok(get().error);
});
test('mixed-OS-answers-filtered', ({
  state,
  get
}) => {
  state.a = [];
  state.os = [{
    address: BLOCKED,
    family: 4
  }, {
    address: SAFE,
    family: 4
  }];
  assert.deepEqual(get().addresses, [SAFE]);
});
test('empty-OS-answers-never-return-unchecked-hostname', ({
  state,
  get
}) => {
  state.a = [];
  state.os = [];
  assert.ok(get().error);
});
test('OS-error-without-cache-propagated', ({
  state,
  get
}) => {
  state.a = [];
  state.osError = err('EAI_AGAIN');
  assert.equal(get().error, 'EAI_AGAIN');
});
test('single-address-callback-form', ({
  resolver
}) => {
  let result;
  resolver.lookup(HOST, {
    all: false,
    timeout: TIMEOUT,
    allowInternalNetworkInterfaces: true
  }, (error, address, family) => {
    result = {
      error,
      address,
      family
    };
  });
  assert.deepEqual(result, {
    error: null,
    address: SAFE,
    family: 4
  });
});
test('sequential-family-timeout-scope-preserved', ({
  state,
  get,
  advance
}) => {
  state.delays = [20_000, 20_000];
  const start = state.now;
  const baseline = get(false);
  advance();
  const baselineElapsed = state.now - start;
  const secondStart = state.now;
  const candidate = get();
  advance();
  assert.deepEqual(candidate, baseline);
  assert.equal(state.now - secondStart, 40_000);
  assert.equal(baselineElapsed, 40_000);
  return {
    elapsed: 40_000,
    qualification: 'virtual callback time; no new overall DNS cap'
  };
});
test('query-timeout-override-reaches-both-resolvers', ({
  state,
  get
}) => {
  const timeout = 777;
  get(true, HOST, {
    timeout
  });
  assert.deepEqual(state.calls.filter(call => call[0] !== 'OS').map(call => call[2]), [timeout, timeout]);
});
test('existing-cache-miss-retention-not-silently-tightened', ({
  get,
  resolver
}) => {
  const count = 1002;
  for (let index = 0; index < count; index++) get(true, `host-${index}.invalid`);
  assert.equal(resolver.cache.size, count);
  return {
    cacheSize: resolver.cache.size,
    qualification: 'Preserved existing miss-path weakness; bounded eviction would be a separate behavior decision.'
  };
});
test('existing-cache-hit-cleanup-threshold-preserved', ({
  state,
  get,
  resolver
}) => {
  const count = 1002;
  for (let index = 0; index < count; index++) get(true, `host-${index}.invalid`);
  state.now += 31_000;
  get(true, 'host-1001.invalid');
  assert.equal(resolver.cache.size, 902);
});
test('duplicate-selected-address-removal-matches-baseline', ({
  state,
  both
}) => {
  state.a = [SAFE, SAFE, SECOND];
  assert.deepEqual(both().addresses, [SAFE, SECOND]);
});
test('OS-only-safe-loopback-survives-internal-interface-filter', () => {
  const fake = {
    Resolver: class {
      resolve4(_host, cb) {
        cb(null, []);
      }
      resolve6(_host, cb) {
        cb(null, []);
      }
    },
    lookup(_host, _options, cb) {
      cb(null, [{
        address: SAFE,
        family: 4
      }]);
    }
  };
  const resolver = createSmtpResolver({
    dnsApi: fake,
    networkInterfaces: {
      lo: [{
        family: 'IPv4',
        internal: true
      }]
    }
  });
  let result;
  resolver.lookup(HOST, {
    all: true,
    allowInternalNetworkInterfaces: true
  }, (error, addresses) => {
    result = {
      error,
      addresses
    };
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.addresses, [{
    address: SAFE,
    family: 4
  }]);
});
test('large-cache-cleanup-evicts-fixed-baseline-count', ({
  state,
  get,
  resolver,
  outage
}) => {
  const count = 2000;
  for (let index = 0; index < count; index++) {
    get(false, `host-${index}.invalid`);
    get(true, `host-${index}.invalid`);
  }
  state.now += 31_000;
  get(false, 'host-1999.invalid');
  get(true, 'host-1999.invalid');
  assert.equal(shared.dnsCache.size, 1900);
  assert.equal(resolver.cache.size, shared.dnsCache.size);
  outage();
  assert.deepEqual(get(true, 'host-150.invalid'), get(false, 'host-150.invalid'));
});
test('same-host-cache-is-shared-across-ports-and-DNS-options', ({
  state,
  get
}) => {
  const first = {
    port: 465,
    timeout: 1000,
    dnsTtl: 10000
  };
  assert.deepEqual(get(true, HOST, first), get(false, HOST, first));
  state.a = [SECOND];
  state.calls = [];
  const next = {
    port: 587,
    timeout: 2000,
    dnsTtl: 1
  };
  const candidate = get(true, HOST, next),
    baseline = get(false, HOST, next);
  assert.deepEqual(candidate, baseline);
  assert.deepEqual(candidate.addresses, [SAFE]);
  assert.equal(state.calls.length, 0);
  state.now += 10001;
  assert.deepEqual(get(true, HOST, next), get(false, HOST, next));
});
