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


## 🤔 Was ist MySpeed?

MySpeed ist eine Speedtest-Analyse-Software, welche die Geschwindigkeit deines Internets über einen frei konfigurierbaren Zeitraum speichert.

### ⭐ Features

- 📊 MySpeed generiert übersichtliche Statistiken über Geschwindigkeit, Ping und mehr
- ⏰ MySpeed automatisiert Speedtests und lässt dich mithilfe von Cron-Expressions die Zeit zwischen den Tests festlegen
- 🗄️ Füge mehrere Server direkt zu einer MySpeed-Instanz hinzu
- 🩺 Es lassen sich Healthchecks konfigurieren, welche dich bei Fehlern oder Ausfällen über E-Mail, Signal, WhatsApp oder Telegram benachrichtigen können
- 📆 Testergebnisse lassen sich beliebig lange speichern - die Aufbewahrungsdauer ist frei konfigurierbar
- 🔥 Unterstützung für Prometheus und Grafana
- 🗳️ Wähle zwischen Ookla, LibreSpeed und Cloudflare Speedtest-Servern
### ⬇️ Installation

#### 🐳 Docker (empfohlen)

```bash
docker run -d -p 5216:5216 -v myspeed:/myspeed/data --restart=unless-stopped --name MySpeed i7gamer/myspeed
```

Oder mit Compose:

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

##### ⚡ Die volle Leitungsgeschwindigkeit messen

Auf einem Linux-Host `--network host` ergänzen (Compose: `network_mode: host`) und
das Port-Mapping weglassen:

```bash
docker run -d --network host -v myspeed:/myspeed/data --restart=unless-stopped --name MySpeed i7gamer/myspeed
```

MySpeed bindet den Speedtest an ein bestimmtes Netzwerk-Interface. Im Standard-
Bridge-Netzwerk sieht ein Container nur sein eigenes `eth0`, sodass jeder Test durch
das NAT von Docker läuft und diesen Weg misst statt deiner Leitung - je schneller die
Verbindung, desto mehr kostet das. Mit Host-Networking bindet MySpeed an die echte
Netzwerkkarte, und die Interface-Auswahl in den Einstellungen zeigt die tatsächlich
vorhandenen Interfaces.

MySpeed lauscht weiterhin auf Port 5216, jetzt direkt auf dem Host. Unter Docker
Desktop für Windows und macOS bringt das nichts, dort läuft der Verkehr ohnehin durch
eine VM.

#### 🪟 Windows

Lade `MySpeed-windows-x64.exe` (oder den MSI-Installer, der MySpeed als
Windows-Dienst einrichtet) von der [Releases-Seite](https://github.com/i7Gamer/MySpeed/releases/latest)
herunter, lege die Datei in einen Ordner deiner Wahl und starte sie.

#### 🔧 Aus dem Quellcode

Benötigt [bun](https://bun.sh).

```bash
git clone https://github.com/i7Gamer/MySpeed.git
cd MySpeed
bun install
bun run build
bun run server/index.js
```

MySpeed ist danach unter **http://localhost:5216** erreichbar.

### 📸 Beispiel-Screenshots

#### Startseite (Listen-Ansicht)

<img src="https://i.imgur.com/XXDLXVX.png" alt="Startseite">

#### Startseite (Statistik-Ansicht)
<img src="https://i.imgur.com/nNaTJTe.png" alt="Statistik">

#### Serverauswahl

<img src="https://i.imgur.com/gZnGSJb.png" alt="Serverauswahl">

#### Auswahl-Menü

<img src="https://i.imgur.com/zCzTJ53.png" alt="Auswahl-Menü">

#### Seite während eines Speedtests

<img src="https://i.imgur.com/RccxiUb.png" alt="Seite während eines Speedtests">

## Überzeugt?

Cool, dann lass uns loslegen! Die Installationsanleitung für Linux (und Windows) findest du oben unter Installation.

## Lizenz

Verbreitet unter der MIT-Lizenz. Siehe `LICENSE` für weitere Informationen.

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
