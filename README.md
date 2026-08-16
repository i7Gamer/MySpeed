[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![MIT License][license-shield]][license-url]
[![Release][release-shield]][release-url]

<br />
<div align="center">
  <a href="https://github.com/i7Gamer/MySpeed">
    <img src="https://i.imgur.com/aCmA6rH.png" alt="Logo" width="80" height="80">
  </a>
  <h3>MySpeed <a href="README.de.md">🇩🇪</a> <a href="README.md">🇺🇸</a></h3>
</div>


## 🤔 What is MySpeed?

MySpeed is a speed test analysis software that records your internet speed over a fully configurable retention period.

### ⭐ Features

- 📊 MySpeed generates clear statistics on speed, ping, and more
- ⏰ MySpeed automates speed tests and allows you to set the time between tests using Cron expressions
- 🗄️ Add multiple servers directly to a MySpeed instance
- 🩺 Configure health checks to notify you via email, Signal, WhatsApp, or Telegram in case of errors or downtime
- 📆 Test results can be stored for any retention period you configure - from a few days to forever
- 🔥 Support for Prometheus and Grafana
- 🗳️ Choose between Ookla, LibreSpeed and Cloudflare speed test servers
### ⬇️ Installation

#### 🐳 Docker (recommended)

```bash
docker run -d -p 5216:5216 -v myspeed:/myspeed/data --restart=unless-stopped --name MySpeed i7gamer/myspeed
```

Or with Compose:

```yaml
services:
  myspeed:
    image: i7gamer/myspeed
    container_name: MySpeed
    restart: unless-stopped
    ports:
      - "5216:5216"
    volumes:
      - myspeed:/myspeed/data

volumes:
  myspeed:
```

##### ⚡ Getting the full line speed

On a Linux host, add `--network host` (Compose: `network_mode: host`) and drop the
port mapping:

```bash
docker run -d --network host -v myspeed:/myspeed/data --restart=unless-stopped --name MySpeed i7gamer/myspeed
```

MySpeed binds the speed test to a specific network interface. On the default bridge
network the only interface a container can see is its own `eth0`, so every test is
forced through Docker's NAT and measures that path rather than your line - the faster
your connection, the more it costs you. Host networking lets MySpeed bind to the real
NIC, and the interface picker in the settings starts listing your actual interfaces.

MySpeed still listens on port 5216, now directly on the host. This has no effect on
Docker Desktop for Windows and macOS, where the traffic goes through a VM either way.

#### 🐧 Linux (binary)

Download a Linux binary from the [releases page](https://github.com/i7Gamer/MySpeed/releases/latest):

- `MySpeed-linux-x64` — default Bun target (needs **AVX2**)
- `MySpeed-linux-x64-baseline` — older x86_64 CPUs without AVX2 (SSE4.2 / Nehalem+)
- `MySpeed-linux-arm64` — aarch64

If the default binary exits immediately with `Illegal instruction` / `SIGILL`, use the
baseline build. The install script picks baseline automatically when `/proc/cpuinfo`
has no `avx2` flag.

```bash
curl -sSL -o /tmp/myspeed-install.sh \
  https://raw.githubusercontent.com/i7Gamer/MySpeed/development/scripts/install.sh
sudo bash /tmp/myspeed-install.sh
```

Building a Linux binary yourself (`bun run build:binary:baseline`) has to happen *on*
Linux — a container is fine. Cross-compiling from macOS or Windows embeds the host's
native addons (e.g. `@resvg/resvg-js`), producing a binary that starts and then fails
at runtime.

#### 🪟 Windows

Download from the [releases page](https://github.com/i7Gamer/MySpeed/releases/latest):

- `MySpeed-windows-x64.exe` — default Bun target (needs **AVX2**)
- `MySpeed-windows-x64-baseline.exe` — older x86_64 CPUs without AVX2 (SSE4.2 / Nehalem+)
- `MySpeed-installer.msi` and `MySpeed-installer-baseline.msi` — the same two as an
  installer, which registers MySpeed as a Windows service

Nothing picks the right one for you here, so go by the symptom: the exe exits
immediately with `Illegal instruction`, and the MSI installs cleanly but leaves a
service that never starts. Either one means the baseline build. To check before
downloading, PowerShell 7 answers it with
`[System.Runtime.Intrinsics.X86.Avx2]::IsSupported`.

The two installers are one product, so running the other one switches the build and
keeps your database.

The exe keeps its data in a `data` folder next to the directory you start it from, so
run it from the folder you want that data to live in. The MSI installs to
`C:\Program Files\MySpeed` and keeps its data in `C:\ProgramData\MySpeed` instead.
Upgrading an MSI install from 1.1.0 or earlier moves the program out of
`C:\Program Files (x86)` and copies the existing database over to the new location.

#### 🔧 From source

Requires [bun](https://bun.sh).

```bash
git clone https://github.com/i7Gamer/MySpeed.git
cd MySpeed
bun install
bun run build
bun run server/index.js
```

MySpeed then listens on **http://localhost:5216**.

### 🔐 Exposing MySpeed to the internet

MySpeed is safe to run on a trusted LAN out of the box. Putting it on a public
address takes a few deliberate steps.

#### First run

A fresh instance has no password. Requests from other machines are refused until
one is set, so the first thing MySpeed prints on startup is a one-time **setup
token**:

```
  Setup token: 5f3c1e...
```

Enter it when the interface asks for a password, then set a real password from
the dropdown menu. A new token is issued on every restart and is never written to
disk. On a network you fully trust you can skip this with `ALLOW_NO_PASSWORD=true`
— on a public address, don't.

#### If the password no longer works

The setup token only applies to an instance that has *no* password, so it is no
help once one is set — and neither is loopback access nor `ALLOW_NO_PASSWORD`.
A password that is set but not known is cleared from the command line:

```bash
MySpeed --reset-password
```

The Docker image ships the runtime and the server sources rather than a compiled
binary, so run the entry point there instead:

```bash
docker exec <container> bun server/index.js --reset-password
```

Run it from the same directory the server runs in — it resolves
`data/storage.db` relative to the working directory, and will say so if it finds
no configuration there. In the container that is already the working directory.

The instance is then back to the first-run state above: open on the machine it
runs on, asking every other machine for a setup token, which it prints to its log
as it turns the next request away. Nothing needs restarting; set a new password
from the dropdown menu. Sessions already signed in stay valid until they expire —
restart the server to end them.

The command says what happened in words, and exits with a code for when something
else is reading:

| Code | Meaning | What to do |
| --- | --- | --- |
| `0` | The password was cleared, or there was none to clear. | Set a new one from the interface. |
| `111` | The database could not be opened at all. | Check that the data directory exists and is writable by the user the server runs as. |
| `113` | The database opened and holds no MySpeed configuration. | Nothing was changed. The data is elsewhere — run the command from the directory the server runs in. |
| `114` | The configuration is there and the write did not go through. | **The password is unchanged and you are still locked out.** The path is right; check that the database is not locked by another process and that the directory is writable. |

`113` and `114` are the pair worth keeping apart in a script: the first says the
path is wrong and the data is fine, the second says the path is fine and the
database needs attention.

#### Put a reverse proxy in front

This is the supported way to expose MySpeed. The proxy terminates TLS and, ideally,
authenticates before MySpeed is reached at all:

```nginx
server {
    listen 443 ssl;
    server_name speed.example.com;

    ssl_certificate     /etc/letsencrypt/live/speed.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/speed.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:5216;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then tell MySpeed the proxy is there, or every client will look like one address
and a single attacker can lock everybody out of the login throttle:

```bash
docker run -d -p 127.0.0.1:5216:5216 -e TRUST_PROXY=1 \
  -v myspeed:/myspeed/data --restart=unless-stopped --name MySpeed i7gamer/myspeed
```

Binding the published port to `127.0.0.1` keeps the container reachable only
through the proxy.

#### Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `TRUST_PROXY` | unset | Number of proxies in front (`1`) or a preset such as `loopback`. Required behind a reverse proxy so rate limiting sees real client addresses. `true` is read as `1`: Express would otherwise take the address from a header the caller writes. |
| `ALLOW_NO_PASSWORD` | `false` | Serve an instance that has no password to anyone who can reach it. LAN only. |
| `FRAME_ANCESTORS` | `'none'` | CSP origins allowed to embed MySpeed in an iframe, for dashboards like Homepage or Heimdall. |
| `HTTPS_REDIRECT` | `true` | Send network callers to the HTTPS listener when `data/certs` holds a certificate. Set `false` if a proxy terminates TLS and `TRUST_PROXY` is not set. |
| `ALLOW_LOCAL_NODES` | `false` | Permit remote nodes on loopback or link-local addresses. Off by default so a node URL cannot be used to probe the host. |
| `ALLOWED_NODE_HOSTS` | unset | Restrict remote nodes to these hosts, comma-separated, each with an optional port — `192.168.1.50,myspeed.example.net:5216,[fd00::1]`. Unset permits any host outside the blocked ranges. Worth setting on an instance reachable from the internet. |

#### What is protected, and what is not

Built in: the login throttle and per-endpoint rate limits, a 100 KB request body
cap outside the two import endpoints, CSP and anti-framing headers, node URLs
blocked from reaching loopback and cloud metadata addresses, and a config export
that redacts credentials unless you add `?includeSecrets=true`.

Still worth knowing: the password is held in the browser's `localStorage` and sent
on every request, so anyone with access to the browser profile has it. There is a
single shared password rather than per-user accounts. Secrets are stored
unencrypted in `data/storage.db` — back that file up as carefully as you would a
password manager export.

### ⬆️ Upgrading to 1.1.1

Docker upgrades are still `docker pull` and recreate — the container takes
ownership of an existing data volume on first start, because the server now runs
as an unprivileged user rather than as root.

Two changes need a decision rather than just an upgrade:

- **An instance with no password no longer answers the network.** Requests from
  other machines are refused until a password is set or the one-time setup token
  printed in the server log is presented. Local requests are unaffected, so a
  LAN-only install can carry on as before — set `ALLOW_NO_PASSWORD=true` to keep
  the old behaviour deliberately.
- **You are signed out.** The browser no longer stores your password; it holds a
  session cookie instead. Your existing login is carried over once, and after
  that a server restart means signing in again.

Everything else — the database, exported configs, integrations, nodes — carries
over untouched. No migration step is needed.

### 📸 Example Screenshots

#### Homepage (List View)

<img src=".github/screenshots/homepage-list.png" alt="Homepage">

#### Homepage (Statistics View)

<img src=".github/screenshots/homepage-statistics.png" alt="Statistics">

#### Server Selection

<img src=".github/screenshots/server-selection.png" alt="Server Selection">

#### Page During a Speed Test

<img src=".github/screenshots/speed-test.gif" alt="Page During a Speed Test">

## Convinced?

Great, let's get started! You can find the installation instructions for Linux (and Windows) at the top under Installation.

## License

Distributed under the MIT license. See `LICENSE` for more information.

[contributors-shield]: https://img.shields.io/github/contributors/i7Gamer/MySpeed.svg?style=for-the-badge

[contributors-url]: https://github.com/i7Gamer/MySpeed/graphs/contributors

[forks-shield]: https://img.shields.io/github/forks/i7Gamer/MySpeed.svg?style=for-the-badge

[forks-url]: https://github.com/i7Gamer/MySpeed/network/members

[stars-shield]: https://img.shields.io/github/stars/i7Gamer/MySpeed.svg?style=for-the-badge

[stars-url]: https://github.com/i7Gamer/MySpeed/stargazers

[issues-shield]: https://img.shields.io/github/issues/i7Gamer/MySpeed.svg?style=for-the-badge

[issues-url]: https://github.com/i7Gamer/MySpeed/issues

[license-shield]: https://img.shields.io/github/license/i7Gamer/MySpeed.svg?style=for-the-badge

[license-url]: https://github.com/i7Gamer/MySpeed/blob/master/LICENSE

[release-shield]: https://img.shields.io/github/v/release/i7Gamer/MySpeed.svg?style=for-the-badge

[release-url]: https://github.com/i7Gamer/MySpeed/releases/latest
