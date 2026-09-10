import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSmtpSocket } from '../../../../server/util/smtpSocket.js';
const HOST = 'lifecycle-fixture.invalid',
  FIRST = '127.0.0.2',
  SECOND = '127.0.0.1',
  PORT = 12345,
  ATTEMPT_MS = 25,
  WATCHDOG_MS = 1000;
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyCount = 0;
    this.keepalive = [];
  }
  destroy() {
    this.destroyCount++;
    return this;
  }
  setKeepAlive(value) {
    this.keepalive.push(value);
    return this;
  }
}
const answers = [{
  address: FIRST,
  family: 4
}, {
  address: SECOND,
  family: 4
}];
export const lifecycleScenarios = [];
const lookup = (_host, _opts, callback) => callback(null, answers);
const run = (name, fn) => lifecycleScenarios.push({
  name,
  run: async () => {
    let watchdog;
    try {
      await Promise.race([fn(), new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('test safety watchdog')), WATCHDOG_MS);
      })]);
    } finally {
      clearTimeout(watchdog);
    }
  }
});
const start = ({
  dial,
  signal,
  options = {},
  customLookup = lookup
} = {}) => {
  const observed = {
      attempts: [],
      callbacks: 0
    },
    outcomes = [];
  let finish;
  const complete = new Promise(resolve => {
    finish = resolve;
  });
  createSmtpSocket({
    lookup: customLookup,
    dial: options => {
      observed.attempts.push(options.host);
      return dial(options);
    },
    signal
  })({
    host: HOST,
    port: PORT,
    connectionTimeout: ATTEMPT_MS,
    ...options
  }, (error, value) => {
    observed.callbacks++;
    outcomes.push({
      error,
      value
    });
    finish({
      error,
      value
    });
  });
  return {
    observed,
    outcomes,
    complete
  };
};
run('synchronous-first-dial-throw-falls-back', async () => {
  const socket = new FakeSocket();
  let attempts = 0;
  const run = start({
    dial: () => {
      if (++attempts === 1) throw new Error('first failed');
      return socket;
    }
  });
  socket.emit('connect');
  const result = await run.complete;
  assert.equal(result.error, null);
  assert.equal(result.value.connection, socket);
  assert.deepEqual(run.observed.attempts, [FIRST, SECOND]);
  assert.equal(run.observed.callbacks, 1);
  assert.equal(socket.destroyCount, 0);
});
run('all-synchronous-dials-exhausted-once', async () => {
  const run = start({
    dial: () => {
      throw new Error('dial failure');
    }
  });
  assert.match((await run.complete).error.message, /dial failure/);
  assert.equal(run.observed.callbacks, 1);
  assert.deepEqual(run.observed.attempts, [FIRST, SECOND]);
});
run('first-error-destroys-before-second-attempt', async () => {
  const first = new FakeSocket(),
    second = new FakeSocket();
  let count = 0;
  const run = start({
    dial: () => {
      if (++count === 1) return first;
      assert.equal(first.destroyCount, 1);
      return second;
    }
  });
  first.emit('error', new Error('refused'));
  second.emit('connect');
  assert.equal((await run.complete).value.connection, second);
  assert.equal(run.observed.callbacks, 1);
});
run('close-before-ready-falls-back', async () => {
  const first = new FakeSocket(),
    second = new FakeSocket();
  let count = 0;
  const run = start({
    dial: () => ++count === 1 ? first : second
  });
  first.emit('close');
  second.emit('connect');
  assert.equal((await run.complete).value.connection, second);
  assert.equal(first.destroyCount, 1);
});
run('timeout-stale-callbacks-cannot-destroy-new-attempt', async () => {
  const first = new FakeSocket(),
    second = new FakeSocket();
  let count = 0;
  let readySecond;
  const enteredSecond = new Promise(resolve => {
    readySecond = resolve;
  });
  const run = start({
    dial: () => {
      if (++count === 1) return first;
      readySecond();
      return second;
    }
  });
  const oldReady = first.listeners('connect')[0],
    oldError = first.listeners('error')[0],
    oldClose = first.listeners('close')[0];
  await enteredSecond;
  assert.equal(first.destroyCount, 1);
  oldReady();
  oldError(new Error('late error'));
  oldClose();
  first.emit('error', new Error('teardown error'));
  first.emit('connect');
  first.emit('close');
  assert.equal(second.destroyCount, 0);
  assert.equal(run.observed.callbacks, 0);
  second.emit('connect');
  assert.equal((await run.complete).value.connection, second);
  assert.equal(run.observed.callbacks, 1);
  assert.deepEqual(second.keepalive, [true]);
});
run('exhausted-timeouts-settle-and-destroy-once', async () => {
  const sockets = [];
  const run = start({
    dial: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }
  });
  const failure=(await run.complete).error;
  assert.equal(failure.code,'ETIMEDOUT');
  assert.equal(failure.message,'Connection timeout');
  assert.equal(sockets.length, 2);
  assert.deepEqual(sockets.map(socket => socket.destroyCount), [1, 1]);
  assert.equal(run.observed.callbacks, 1);
  for (const socket of sockets) {
    socket.emit('error', new Error('late'));
    socket.emit('close');
    socket.emit('connect');
  }
  assert.equal(run.observed.callbacks, 1);
});
run('abort-active-socket-stops-fallback-and-late-events', async () => {
  const socket = new FakeSocket(),
    controller = new AbortController();
  const run = start({
    dial: () => socket,
    signal: controller.signal
  });
  const oldReady = socket.listeners('connect')[0];
  controller.abort();
  assert.match((await run.complete).error.message, /cancelled/);
  oldReady();
  socket.emit('error', new Error('late'));
  assert.equal(socket.destroyCount, 1);
  assert.equal(run.observed.callbacks, 1);
  assert.deepEqual(run.observed.attempts, [FIRST]);
});
run('abort-after-handoff-does-not-destroy-owned-socket', async () => {
  const socket = new FakeSocket(),
    controller = new AbortController();
  const run = start({
    dial: () => socket,
    signal: controller.signal
  });
  socket.emit('connect');
  await run.complete;
  controller.abort();
  assert.equal(socket.destroyCount, 0);
  assert.equal(run.observed.callbacks, 1);
});
run('abort-during-DNS-suppresses-late-result', async () => {
  let done;
  const controller = new AbortController();
  const run = start({
    dial: () => {
      throw new Error('must not dial');
    },
    signal: controller.signal,
    customLookup: (_host, _opts, callback) => {
      done = callback;
    }
  });
  controller.abort();
  await run.complete;
  done(null, answers);
  assert.equal(run.observed.callbacks, 1);
  assert.deepEqual(run.observed.attempts, []);
});
run('implicit-TLS-waits-for-secureConnect', async () => {
  const socket = new FakeSocket();
  const run = start({
    dial: () => socket,
    options: {
      secure: true
    }
  });
  socket.emit('connect');
  assert.equal(run.observed.callbacks, 0);
  socket.emit('secureConnect');
  const result = await run.complete;
  assert.equal(result.value.secured, true);
  assert.equal(run.observed.callbacks, 1);
});
