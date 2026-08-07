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

#### 🪟 Windows

Download `MySpeed-windows-x64.exe` (or the MSI installer, which registers MySpeed as a
Windows service) from the [releases page](https://github.com/i7Gamer/MySpeed/releases/latest),
place it in a folder of your choice and run it.

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

### 📸 Example Screenshots

#### Homepage (List View)

<img src="https://i.imgur.com/NHX7Ba9.png" alt="Homepage">

#### Homepage (Statistics View)
<img src="https://i.imgur.com/5JAFgrk.png" alt="Statistics">

#### Server Selection

<img src="https://i.imgur.com/hgOR93G.png" alt="Server Selection">

#### Dropdown Menu

<img src="https://i.imgur.com/alKEMrg.png" alt="Dropdown Menu">

#### Page During a Speed Test

<img src="https://i.imgur.com/kxsrjIe.png" alt="Page During a Speed Test">

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
