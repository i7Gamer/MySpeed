import { spawn } from 'node:child_process';
import path from 'node:path';
const RPC_TIMEOUT_MS = 5000;
export async function remoteFixture(options) {
  const childFile = path.join(process.env.OUTBOUND_SMTP_FIXTURE_DIR || path.resolve('tests/fixtures/outbound-transport/smtp'), 'fixtureChild.mjs');
  const child = spawn('node', [childFile], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true
  });
  let id = 0;
  const requests = new Map();
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const fail = error => {
    for (const task of requests.values()) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    requests.clear();
  };
  child.on('error', fail);
  child.on('exit', code => {
    if (requests.size) fail(new Error('fixture child exited ' + code + ' ' + stderr));
  });
  child.on('message', message => {
    const task = requests.get(message.id);
    if (!task) return;
    clearTimeout(task.timer);
    requests.delete(message.id);
    message.error ? task.reject(Object.assign(new Error(message.error), {
      code: message.code
    })) : task.resolve(message.result);
  });
  const rpc = (command, params) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => {
      requests.delete(key);
      reject(new Error('fixture RPC deadline ' + command + ' ' + stderr));
      child.kill();
    }, RPC_TIMEOUT_MS);
    requests.set(key, {
      resolve,
      reject,
      timer
    });
    child.send({
      id: key,
      command,
      params
    });
  });
  let started;
  try {
    started = await rpc('start', options);
  } catch (error) {
    child.disconnect();
    child.kill();
    throw error;
  }
  let seen = started.seen;
  return {
    port: started.port,
    get seen() {
      return seen;
    },
    refresh: async () => {
      seen = await rpc('snapshot');
    },
    close: async () => {
      try {
        await rpc('close');
      } finally {
        child.disconnect();
        child.kill();
      }
    }
  };
}
