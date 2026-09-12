import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import {nodemailer, shared, setInterfaces, fixtureInterfaces} from './nodemailerHarness.js';
import { smtpFixture, cert, HOST } from './fixture.js';
import { createSmtpSocket } from '../../../../server/util/smtpSocket.js';
import { checkOutboundHost } from '../../../../server/util/safeUrl.js';
import { createSmtpResolver } from '../../../../server/util/smtpResolver.js';
import { transportOptions } from '../../../../server/util/smtpOptions.js';
const STAGE_MS = 400,
  DEADLINE_MS = 5000,
  DELAY_MS = 90;
const mail = {
  from: 'sender@fixture.invalid',
  to: 'receiver@fixture.invalid',
  subject: 'synthetic fixture',
  text: 'synthetic payload only'
};
const original = {
  Resolver: dns.Resolver,
  lookup: dns.lookup,
  random: Math.random,
  netConnect: net.connect,
  tlsConnect: tls.connect,
  interfaces: {...fixtureInterfaces}
};
let answers = [{
    address: '127.0.0.1',
    family: 4
  }],
  dnsError = null,
  osAnswers = null,
  lookupCalls = 0;
let smtpResolver;
function installDNS() {
  const guarded = connect => (opts, ...args) => {
    if (opts?.host && !opts.socket) {
      const destinations = net.isIP(opts.host) ? [{
        address: opts.host
      }] : osAnswers ?? answers;
      for (const item of destinations) assert.ok(checkOutboundHost(item.address).safe, 'fixture refuses a forbidden dial');
    }
    return connect(opts, ...args);
  };
  net.connect = guarded(original.netConnect);
  tls.connect = guarded(original.tlsConnect);
  dns.Resolver = class {
    resolve4(_host, cb) {
      setImmediate(() => cb(dnsError, answers.filter(a => a.family === 4).map(a => a.address)));
    }
    resolve6(_host, cb) {
      setImmediate(() => cb(dnsError, answers.filter(a => a.family === 6).map(a => a.address)));
    }
  };
  dns.lookup = (_host, options, cb) => {
    if (net.isIP(_host)) return original.lookup(_host, options, cb);
    lookupCalls++;
    setImmediate(() => dnsError ? cb(dnsError) : options.all ? cb(null, osAnswers ?? answers) : cb(null, (osAnswers ?? answers)[0]?.address, (osAnswers ?? answers)[0]?.family));
  };
  Math.random = () => 0;
}
function options(fixture, mode, extra = {}) {
  return {
    _smtpFixture: fixture,
    ...transportOptions({
      host: HOST,
      port: fixture.port,
      secure: mode === 'tls',
      username: 'synthetic',
      password: 'synthetic'
    }),
    getSocket: undefined,
    connectionTimeout: STAGE_MS,
    greetingTimeout: STAGE_MS,
    socketTimeout: STAGE_MS,
    tls: {
      ca: cert,
      servername: HOST
    },
    ...extra
  };
}
async function send(opts) {
  const transport = nodemailer.createTransport(opts);
  let timer;
  try {
    return await Promise.race([transport.sendMail(mail), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture safety deadline')), DEADLINE_MS);
    })]);
  } finally {
    clearTimeout(timer);
    transport.close();
    await opts._smtpFixture?.refresh?.();
  }
}
async function assertClosedBeforeTeardown(fixture) {
  const CLEANUP_LIMIT_MS = 1500,
    POLL_MS = 20;
  const deadline = Date.now() + CLEANUP_LIMIT_MS;
  do {
    await fixture.refresh?.();
    if (fixture.seen.openSockets === 0) return;
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  } while (Date.now() < deadline);
  assert.equal(fixture.seen.openSockets, 0, 'socket retained before fixture teardown');
}
// Observation and a safety-only DNS abort belong to the fixture, never the
// production connector. Each test gets an isolated cache; baseline comparisons
// explicitly omit the integration's new default hook.
function createGuardedSocket({
  lookup,
  signal,
  observed = {
    attempts: [],
    callbacks: 0
  },
  dial
} = {}) {
  return (options, callback) => createSmtpSocket({
    lookup: lookup ?? smtpResolver.lookup,
    signal,
    dial: opts => {
      observed.attempts.push(opts.host);
      assert.ok(checkOutboundHost(opts.host).safe, 'fixture refuses forbidden dial');
      return (dial ?? (options.secure ? tls.connect : net.connect))(opts);
    }
  })(options, (...args) => {
    observed.callbacks++;
    callback(...args);
  });
}
export const smtpScenarios = [];
const check = (name, run) => smtpScenarios.push({
  name: `smtp ${name}`,
  run: async () => {
    installDNS();
    shared.dnsCache.clear();
    const cache = new Map();
    smtpResolver = {
      ...createSmtpResolver({
        cache, networkInterfaces: fixtureInterfaces
      }),
      cache
    };
    answers = [{
      address: '127.0.0.1',
      family: 4
    }];
    dnsError = null;
    osAnswers = null;
    lookupCalls = 0;
    try {
      return await run();
    } finally {
      dns.Resolver = original.Resolver;
      dns.lookup = original.lookup;
      Math.random = original.random;
      net.connect = original.netConnect;
      tls.connect = original.tlsConnect;
      setInterfaces(original.interfaces);
      shared.dnsCache.clear();
    }
  }
});
for (const adapter of [false, true]) for (const mode of ['plain', 'tls', 'starttls']) check(`${adapter ? 'adapter' : 'baseline'}-${mode}`, async () => {
  const fixture = await smtpFixture({
    mode
  });
  const observed = {
    attempts: [],
    callbacks: 0
  };
  try {
    await send(options(fixture, mode, adapter ? {
      getSocket: createGuardedSocket({
        observed
      })
    } : {}));
    assert.equal(fixture.seen.messages.length, 1);
    assert.equal(fixture.seen.auth, 1);
    if (mode !== 'plain') {
      assert.equal(fixture.seen.tls, 1);
      assert.equal(fixture.seen.sni[0], HOST);
    }
    return {
      commands: fixture.seen.commands,
      attempts: observed.attempts
    };
  } finally {
    await fixture.close();
  }
});
for (const adapter of [false, true]) check(`${adapter ? 'adapter' : 'baseline'}-anonymous`, async () => {
  const fixture = await smtpFixture({
    auth: false
  });
  try {
    await send(options(fixture, 'plain', {
      auth: undefined,
      ...(adapter ? {
        getSocket: createGuardedSocket()
      } : {})
    }));
    assert.equal(fixture.seen.auth, 0);
    assert.equal(fixture.seen.messages.length, 1);
  } finally {
    await fixture.close();
  }
});
for (const adapter of [false, true]) for (const mode of ['plain', 'tls']) check(`${adapter ? 'adapter' : 'baseline'}-${mode}-fallback`, async () => {
  answers = [{
    address: '127.0.0.2',
    family: 4
  }, {
    address: '127.0.0.1',
    family: 4
  }];
  const fixture = await smtpFixture({
    mode
  });
  const observed = {
    attempts: [],
    callbacks: 0
  };
  try {
    await send(options(fixture, mode, adapter ? {
      getSocket: createGuardedSocket({
        observed
      })
    } : {}));
    assert.equal(fixture.seen.messages.length, 1);
    if (adapter) assert.deepEqual(observed.attempts, ['127.0.0.2', '127.0.0.1']);
    return {
      attempts: observed.attempts
    };
  } finally {
    await fixture.close();
  }
});
for (const adapter of [false, true]) for (const mode of ['tls', 'starttls']) check(`${adapter ? 'adapter' : 'baseline'}-${mode}-wrong-identity`, async () => {
  const fixture = await smtpFixture({
    mode
  });
  try {
    await assert.rejects(send(options(fixture, mode, {
      tls: {
        ca: cert,
        servername: 'wrong.invalid'
      },
      ...(adapter ? {
        getSocket: createGuardedSocket()
      } : {})
    })), error => error.message !== 'fixture safety deadline' && /cert|tls|ssl|hostname|self.signed/i.test(error.message));
    assert.equal(fixture.seen.auth, 0);
    assert.equal(fixture.seen.messages.length, 0);
  } finally {
    await fixture.close();
  }
});
for (const adapter of [false, true]) for (const failure of ['auth', 'greeting', 'data']) check(`${adapter ? 'adapter' : 'baseline'}-${failure}-failure`, async () => {
  const fixture = await smtpFixture({
    refuseAuth: failure === 'auth',
    stallGreeting: failure === 'greeting',
    stallData: failure === 'data'
  });
  try {
    const start = Date.now();
    await assert.rejects(send(options(fixture, 'plain', adapter ? {
      getSocket: createGuardedSocket()
    } : {})), error => error.message !== 'fixture safety deadline' && error.code === (failure === 'auth' ? 'EAUTH' : 'ETIMEDOUT'));
    const elapsed = Date.now() - start;
    assert.ok(elapsed < DEADLINE_MS - STAGE_MS, 'safety deadline must not produce this failure');
    assert.equal(fixture.seen.messages.length, 0);
    assert.equal(fixture.seen.connections, 1);
    await assertClosedBeforeTeardown(fixture);
    return {
      elapsed,
      closedBeforeTeardown: true
    };
  } finally {
    await fixture.close();
  }
});
for (const adapter of [false, true]) check(`${adapter ? 'adapter' : 'baseline'}-slow-progress`, async () => {
  const fixture = await smtpFixture({
    delayMs: DELAY_MS
  });
  try {
    const start = Date.now();
    await send(options(fixture, 'plain', adapter ? {
      getSocket: createGuardedSocket()
    } : {}));
    const elapsed = Date.now() - start;
    assert.ok(elapsed > STAGE_MS);
    assert.equal(fixture.seen.messages.length, 1);
    return {
      elapsed
    };
  } finally {
    await fixture.close();
  }
});
check('adapter-blocked-and-mixed', async () => {
  const fixture = await smtpFixture();
  const observed = {
    attempts: [],
    callbacks: 0
  };
  try {
    answers = [{
      address: '169.254.169.254',
      family: 4
    }];
    await assert.rejects(send(options(fixture, 'plain', {
      getSocket: createGuardedSocket({
        observed
      })
    })));
    assert.equal(observed.attempts.length, 0);
    answers.push({
      address: '127.0.0.1',
      family: 4
    });
    await send(options(fixture, 'plain', {
      getSocket: createGuardedSocket({
        observed
      })
    }));
    assert.deepEqual(observed.attempts, ['127.0.0.1']);
    assert.equal(fixture.seen.messages.length, 1);
  } finally {
    await fixture.close();
  }
});
for (const adapter of [false, true]) check(`${adapter ? 'adapter' : 'baseline'}-tls-handshake-fallback`, async () => {
  const fixture = await smtpFixture({
    mode: 'tls'
  });
  const bad = await smtpFixture({
    host: '127.0.0.2',
    port: fixture.port
  });
  answers = [{
    address: '127.0.0.2',
    family: 4
  }, {
    address: '127.0.0.1',
    family: 4
  }];
  const observed = {
    attempts: [],
    callbacks: 0
  };
  try {
    await send(options(fixture, 'tls', adapter ? {
      getSocket: createGuardedSocket({
        observed
      })
    } : {}));
    assert.equal(fixture.seen.messages.length, 1);
    await bad.refresh?.();
    assert.equal(bad.seen.auth, 0);
    if (adapter) assert.deepEqual(observed.attempts, ['127.0.0.2', '127.0.0.1']);
  } finally {
    await bad.close();
    await fixture.close();
  }
});
check('adapter-literals-never-looked-up', async () => {
  const fixture = await smtpFixture({
    auth: false
  });
  const observed = {
    attempts: [],
    callbacks: 0
  };
  const noLookup = () => {
    throw new Error('literal must not resolve');
  };
  try {
    await send(options(fixture, 'plain', {
      host: '127.0.0.1',
      auth: undefined,
      getSocket: createGuardedSocket({
        lookup: noLookup,
        observed
      })
    }));
    await assert.rejects(send(options(fixture, 'plain', {
      host: '169.254.169.254',
      getSocket: createGuardedSocket({
        lookup: noLookup,
        observed
      })
    })));
    assert.deepEqual(observed.attempts, ['127.0.0.1']);
    assert.equal(fixture.seen.messages.length, 1);
  } finally {
    await fixture.close();
  }
});
check('adapter-late-dns-error-and-abort', async () => {
  const WAIT_MS = 60;
  for (const abort of [false, true]) {
    let callbackDNS;
    const observed = {
      attempts: [],
      callbacks: 0
    };
    const controller = new AbortController();
    const connector = createGuardedSocket({
      lookup: (_host, _opts, cb) => {
        callbackDNS = cb;
      },
      signal: controller.signal,
      observed,
      dial: () => {
        throw new Error('late dial');
      }
    });
    const complete = new Promise(resolve => connector({
      host: HOST,
      port: 12345
    }, error => resolve(error)));
    if (abort) controller.abort();else callbackDNS(new Error("DNS query failed"));
    assert.ok(await complete);
    callbackDNS(null, [{
      address: '127.0.0.1',
      family: 4
    }]);
    await new Promise(resolve => setTimeout(resolve, WAIT_MS));
    assert.equal(observed.callbacks, 1);
    assert.equal(observed.attempts.length, 0);
  }
});
for (const adapter of [false, true]) check(`${adapter ? 'adapter' : 'baseline'}-untrusted-certificate`, async () => {
  const fixture = await smtpFixture({
    mode: 'tls'
  });
  try {
    await assert.rejects(send(options(fixture, 'tls', {
      tls: {
        servername: HOST
      },
      ...(adapter ? {
        getSocket: createGuardedSocket()
      } : {})
    })), error => error.message !== 'fixture safety deadline' && /cert|tls|ssl|hostname|self.signed/i.test(error.message));
    assert.equal(fixture.seen.auth, 0);
    assert.equal(fixture.seen.messages.length, 0);
  } finally {
    await fixture.close();
  }
});
for (const adapter of [false, true]) for (const mode of ['tls', 'starttls']) check(`${adapter ? 'adapter' : 'baseline'}-${mode}-default-host-identity`, async () => {
  const fixture = await smtpFixture({
    mode
  });
  try {
    await send(options(fixture, mode, {
      tls: {
        ca: cert
      },
      ...(adapter ? {
        getSocket: createGuardedSocket()
      } : {})
    }));
    assert.equal(fixture.seen.messages.length, 1);
    assert.equal(fixture.seen.tls, 1);
    assert.equal(fixture.seen.sni[0], HOST);
  } finally {
    await fixture.close();
  }
});
check('warm-cache-compatible-delivery', async () => {
  const fixture = await smtpFixture();
  try {
    await send(options(fixture, 'plain'));
    await send(options(fixture, 'plain', {
      getSocket: createGuardedSocket()
    }));
    dnsError = Object.assign(new Error('synthetic DNS outage'), {
      code: 'ETIMEOUT'
    });
    await send(options(fixture, 'plain'));
    await send(options(fixture, 'plain', {
      getSocket: createGuardedSocket()
    }));
    assert.equal(fixture.seen.messages.length, 4);
    return {
      baselineWarmCache: 'delivered',
      adapterWarmCache: 'delivered',
      gate: 'PASS_FOR_THIS_CASE'
    };
  } finally {
    await fixture.close();
  }
});
check('expired-safe-cache-compatible-delivery', async () => {
  const fixture = await smtpFixture();
  try {
    await send(options(fixture, 'plain'));
    await send(options(fixture, 'plain', {
      getSocket: createGuardedSocket()
    }));
    shared.dnsCache.get(HOST).expires = Date.now() - 1;
    smtpResolver.cache.get(HOST).expires = Date.now() - 1;
    dnsError = Object.assign(new Error('synthetic DNS outage'), {
      code: 'ETIMEOUT'
    });
    await send(options(fixture, 'plain'));
    await send(options(fixture, 'plain', {
      getSocket: createGuardedSocket()
    }));
    assert.equal(fixture.seen.messages.length, 4);
    return {
      baselineExpiredCache: 'delivered',
      adapterExpiredCache: 'delivered'
    };
  } finally {
    await fixture.close();
  }
});
for (const adapter of [false, true]) check(`${adapter ? 'adapter' : 'baseline'}-DNS-precedence-delivery`, async () => {
  const fixture = await smtpFixture();
  osAnswers = [{
    address: '127.0.0.2',
    family: 4
  }];
  try {
    await send(options(fixture, 'plain', adapter ? {
      getSocket: createGuardedSocket()
    } : {}));
    assert.equal(fixture.seen.messages.length, 1);
    assert.equal(lookupCalls, 0);
    return {
      selected: '127.0.0.1',
      ignoredOsAnswer: '127.0.0.2'
    };
  } finally {
    await fixture.close();
  }
});
for (const adapter of [false, true]) check(`${adapter ? 'adapter' : 'baseline'}-OS-only-delivery`, async () => {
  const fixture = await smtpFixture();
  answers = [];
  osAnswers = [{
    address: '127.0.0.1',
    family: 4
  }];
  try {
    await send(options(fixture, 'plain', adapter ? {
      getSocket: createGuardedSocket()
    } : {}));
    assert.equal(fixture.seen.messages.length, 1);
    assert.ok(lookupCalls > 0);
  } finally {
    await fixture.close();
  }
});
for (const adapter of [false, true]) check(`${adapter ? 'adapter' : 'baseline'}-internal-interface-OS-delivery`, async () => {
  const fixture = await smtpFixture();
  answers = [];
  osAnswers = [{
    address: '127.0.0.1',
    family: 4
  }];
  const previous = {...fixtureInterfaces},
    onlyLoopback = {
      lo: [{
        family: 'IPv4',
        internal: true
      }]
    };
  setInterfaces(onlyLoopback);
  const resolver = createSmtpResolver({
    networkInterfaces: onlyLoopback
  });
  try {
    await send(options(fixture, 'plain', adapter ? {
      getSocket: createGuardedSocket({
        lookup: resolver.lookup
      })
    } : {}));
    assert.equal(fixture.seen.messages.length, 1);
    return {
      lookupCalls
    };
  } finally {
    setInterfaces(previous);
    await fixture.close();
  }
});
for (const adapter of [false, true]) for (const mode of ['plain', 'tls']) check(`${adapter ? 'adapter' : 'baseline'}-${mode}-keepalive`, async () => {
  const fixture = await smtpFixture({
    mode
  });
  const socketModule = mode === 'tls' ? tls : net;
  const originalConnect = socketModule.connect;
  const keepalive = [];
  socketModule.connect = (opts, ...args) => {
    const socket = originalConnect.call(socketModule, opts, ...args);
    if (opts?.port === fixture.port) {
      const originalKeepalive = socket.setKeepAlive.bind(socket);
      socket.setKeepAlive = (...values) => {
        keepalive.push(values);
        return originalKeepalive(...values);
      };
    }
    return socket;
  };
  try {
    await send(options(fixture, mode, adapter ? {
      getSocket: createGuardedSocket()
    } : {}));
    assert.equal(fixture.seen.messages.length, 1);
    assert.deepEqual(keepalive, [[true]]);
    return {
      keepalive
    };
  } finally {
    socketModule.connect = originalConnect;
    await fixture.close();
  }
});
for (const adapter of [false, true]) for (const mode of ['plain', 'tls']) check(`${adapter ? 'adapter' : 'baseline'}-${mode}-IPv6-delivery`, async () => {
  let fixture;
  try {
    fixture = await smtpFixture({
      host: '::1',
      mode
    });
  } catch (error) {
    if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) return {
      skip: error.code
    };
    throw error;
  }
  answers = [{
    address: '::1',
    family: 6
  }];
  const observed = {
    attempts: [],
    callbacks: 0
  };
  try {
    await send(options(fixture, mode, adapter ? {
      getSocket: createGuardedSocket({
        observed
      })
    } : {}));
    assert.equal(fixture.seen.messages.length, 1);
    if (adapter) assert.deepEqual(observed.attempts, ['::1']);
    return {
      attempts: observed.attempts
    };
  } finally {
    await fixture.close();
  }
});
for (const adapter of [false, true]) for (const mode of ['plain', 'tls']) check(`${adapter ? 'adapter' : 'baseline'}-${mode}-cross-family-fallback`, async () => {
  // Test fallback rather than this host's resolver interface snapshot. Even
  // when IPv6 cannot connect, its failure must leave the IPv4 candidate usable.
  const networkInterfaces = {fixture: [{family: 'IPv4', internal: false}, {family: 'IPv6', internal: false}]};
  setInterfaces(networkInterfaces);
  const cache = new Map();
  smtpResolver = {...createSmtpResolver({cache, networkInterfaces}), cache};
  const fixture = await smtpFixture({
    mode
  });
  answers = [{
    address: '127.0.0.1',
    family: 4
  }, {
    address: '::1',
    family: 6
  }];
  Math.random = () => 0.99;
  const socketModule = mode === 'tls' ? tls : net,
    originalConnect = socketModule.connect,
    attempts = [];
  socketModule.connect = (opts, ...args) => {
    if (opts?.port === fixture.port) attempts.push(opts.host);
    return originalConnect.call(socketModule, opts, ...args);
  };
  try {
    await send(options(fixture, mode, adapter ? {
      getSocket: createGuardedSocket()
    } : {}));
    assert.equal(fixture.seen.messages.length, 1);
    assert.deepEqual(attempts, ['::1', '127.0.0.1']);
    return {
      attempts
    };
  } finally {
    socketModule.connect = originalConnect;
    Math.random = () => 0;
    await fixture.close();
  }
});
check('integration-default-hook-filters-DNS', async () => {
  const fixture = await smtpFixture({
    auth: false
  });
  const config = {
    host: 'smtp-wiring-fixture.invalid',
    port: fixture.port,
    secure: false
  };
  try {
    const opts = {
      ...options(fixture, 'plain', {
        auth: undefined
      }),
      ...transportOptions(config)
    };
    assert.equal(typeof opts.getSocket, 'function');
    answers = [{
      address: '169.254.169.254',
      family: 4
    }];
    await assert.rejects(send(opts), error => error.code === 'ESMTPDESTINATION');
    assert.equal(fixture.seen.connections, 0);
    answers.push({
      address: '127.0.0.1',
      family: 4
    });
    await send(opts);
    assert.equal(fixture.seen.messages.length, 1);
  } finally {
    await fixture.close();
  }
});
