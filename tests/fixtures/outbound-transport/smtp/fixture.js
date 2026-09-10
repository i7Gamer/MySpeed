import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { remoteFixture } from './remoteFixture.js';
const certificateDir = process.env.OUTBOUND_TLS_FIXTURE_DIR || path.resolve('tests/fixtures/outbound-tls');
export const cert = fs.readFileSync(path.join(certificateDir, 'cert.pem'));
const key = fs.readFileSync(path.join(certificateDir, 'key.pem'));
export const HOST = 'outbound-fixture.invalid';
export async function smtpFixture({
  mode = 'plain',
  auth = true,
  refuseAuth = false,
  stallGreeting = false,
  stallData = false,
  delayMs = 0,
  host = '127.0.0.1',
  port = 0
} = {}) {
  if (process.versions.bun) return remoteFixture({
    mode,
    auth,
    refuseAuth,
    stallGreeting,
    stallData,
    delayMs,
    host,
    port
  });
  const sockets = new Set(),
    timers = new Set();
  const seen = {
    connections: 0,
    commands: [],
    messages: [],
    auth: 0,
    sni: [],
    tls: 0
  };
  Object.defineProperty(seen, 'openSockets', {
    enumerable: true,
    get: () => [...sockets].filter(socket => !socket.destroyed).length
  });
  const later = fn => {
    if (!delayMs) return fn();
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, delayMs);
    timers.add(timer);
  };
  const track = s => {
    sockets.add(s);
    s.on('error', () => {});
    s.once('close', () => sockets.delete(s));
  };
  const attach = (socket, encrypted = false, greet = true) => {
    track(socket);
    if (encrypted) {
      seen.tls++;
      seen.sni.push(socket.servername);
    }
    let pending = '',
      dataMode = false,
      message = [],
      authStep = false;
    const reply = line => later(() => {
      if (!socket.destroyed) socket.write(line + '\r\n');
    });
    const onData = chunk => {
      pending += chunk.toString('utf8');
      while (pending.includes('\r\n')) {
        const end = pending.indexOf('\r\n'),
          line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (dataMode) {
          if (line === '.') {
            dataMode = false;
            seen.messages.push(message.join('\n'));
            message = [];
            reply('250 2.0.0 accepted');
          } else message.push(line);
          continue;
        }
        if (authStep) {
          authStep = false;
          seen.auth++;
          reply(refuseAuth ? '535 5.7.8 refused' : '235 2.7.0 authenticated');
          continue;
        }
        const command = line.split(' ')[0].toUpperCase();
        seen.commands.push(command);
        if (command === 'EHLO' || command === 'HELO') {
          const features = ['250-fixture'];
          if (mode === 'starttls' && !encrypted) features.push('250-STARTTLS');
          if (auth) features.push('250-AUTH PLAIN');
          features.push('250 OK');
          reply(features.join('\r\n'));
        } else if (command === 'STARTTLS') {
          socket.removeListener('data', onData);
          socket.write('220 2.0.0 ready\r\n', () => {
            const wrapped = new tls.TLSSocket(socket, {
              isServer: true,
              secureContext: tls.createSecureContext({
                key,
                cert
              })
            });
            track(wrapped);
            wrapped.once('secure', () => attach(wrapped, true, false));
          });
          return;
        } else if (command === 'AUTH') {
          if (line.split(' ').length > 2) {
            seen.auth++;
            reply(refuseAuth ? '535 5.7.8 refused' : '235 2.7.0 authenticated');
          } else {
            authStep = true;
            reply('334 ');
          }
        } else if (command === 'DATA') {
          if (!stallData) {
            dataMode = true;
            reply('354 end with dot');
          }
        } else if (command === 'QUIT') {
          socket.end('221 bye\r\n');
        } else reply('250 OK');
      }
    };
    socket.on('data', onData);
    if (greet && !stallGreeting) reply('220 fixture ESMTP');
  };
  const accepted = s => {
    seen.connections++;
    attach(s, mode === 'tls');
  };
  const server = mode === 'tls' ? tls.createServer({
    key,
    cert
  }, accepted) : net.createServer(accepted);
  server.on('tlsClientError', () => {});
  server.on('connection', track);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    port: server.address().port,
    seen,
    close: async () => {
      for (const t of timers) clearTimeout(t);
      for (const s of sockets) s.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
