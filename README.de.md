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

Die Exe legt ihre Daten im Ordner `data` neben dem Verzeichnis ab, aus dem du sie
startest - starte sie also aus dem Ordner, in dem die Daten liegen sollen. Der
MSI-Installer installiert nach `C:\Program Files\MySpeed` und legt die Daten
stattdessen unter `C:\ProgramData\MySpeed` ab. Beim Update einer MSI-Installation von
1.1.0 oder älter wandert das Programm aus `C:\Program Files (x86)` heraus und die
vorhandene Datenbank wird an den neuen Ort kopiert.

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

### 🔐 MySpeed im Internet betreiben

Im heimischen Netz kann MySpeed ohne weitere Schritte laufen. Für eine öffentlich
erreichbare Adresse sind ein paar bewusste Entscheidungen nötig.

#### Erster Start

Eine frische Installation hat kein Passwort. Anfragen von anderen Rechnern werden
abgelehnt, bis eines gesetzt ist – deshalb gibt MySpeed beim Start ein einmaliges
**Setup-Token** aus:

```
  Setup token: 5f3c1e...
```

Gib es ein, wenn die Oberfläche nach dem Passwort fragt, und lege anschließend im
Menü ein richtiges Passwort fest. Bei jedem Neustart wird ein neues Token erzeugt;
gespeichert wird es nie. In einem vertrauenswürdigen Netz lässt sich das mit
`ALLOW_NO_PASSWORD=true` überspringen – bei einer öffentlichen Adresse nicht.

#### Wenn das Passwort nicht mehr funktioniert

Das Setup-Token gilt nur für eine Instanz *ohne* Passwort und hilft deshalb nicht
weiter, sobald eines gesetzt ist – ebenso wenig wie der lokale Zugriff oder
`ALLOW_NO_PASSWORD`. Ein gesetztes, aber unbekanntes Passwort wird über die
Kommandozeile gelöscht:

```bash
MySpeed --reset-password
```

Unter Docker im Container ausführen: `docker exec <container> ./MySpeed
--reset-password`. Der Befehl muss im selben Verzeichnis laufen wie der Server –
er löst `data/storage.db` relativ zum Arbeitsverzeichnis auf und sagt es, wenn er
dort keine Konfiguration findet.

Danach ist die Instanz wieder im oben beschriebenen Zustand des ersten Starts:
offen für den Rechner, auf dem sie läuft, und für alle anderen mit Setup-Token,
das sie bei der nächsten abgelehnten Anfrage ins Log schreibt. Ein Neustart ist
nicht nötig; lege im Menü ein neues Passwort fest. Bereits angemeldete Sitzungen
bleiben bis zu ihrem Ablauf gültig – für ein sofortiges Ende den Server neu
starten.

Der Befehl sagt im Klartext, was passiert ist, und liefert einen Exit-Code für
den Fall, dass etwas anderes mitliest:

| Code | Bedeutung | Was zu tun ist |
| --- | --- | --- |
| `0` | Das Passwort wurde gelöscht, oder es war keines gesetzt. | Im Interface ein neues festlegen. |
| `111` | Die Datenbank ließ sich überhaupt nicht öffnen. | Prüfen, ob das Datenverzeichnis existiert und für den Benutzer des Servers beschreibbar ist. |
| `113` | Die Datenbank wurde geöffnet und enthält keine MySpeed-Konfiguration. | Es wurde nichts geändert. Die Daten liegen woanders – den Befehl im Verzeichnis des Servers ausführen. |
| `114` | Die Konfiguration ist da, der Schreibvorgang ging nicht durch. | **Das Passwort ist unverändert, der Zugang bleibt gesperrt.** Der Pfad stimmt; prüfen, ob die Datenbank von einem anderen Prozess gesperrt und das Verzeichnis beschreibbar ist. |

`113` und `114` sind das Paar, das ein Skript auseinanderhalten sollte: Der erste
sagt, der Pfad ist falsch und den Daten fehlt nichts, der zweite sagt, der Pfad
stimmt und die Datenbank braucht Aufmerksamkeit.

#### Einen Reverse Proxy davorsetzen

Das ist der unterstützte Weg. Der Proxy übernimmt TLS und idealerweise auch die
Authentifizierung, bevor MySpeed überhaupt erreicht wird:

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

Anschließend muss MySpeed vom Proxy wissen, sonst sieht es alle Clients unter
derselben Adresse und ein einzelner Angreifer sperrt alle anderen aus:

```bash
docker run -d -p 127.0.0.1:5216:5216 -e TRUST_PROXY=1 \
  -v myspeed:/myspeed/data --restart=unless-stopped --name MySpeed i7gamer/myspeed
```

Die Bindung des Ports an `127.0.0.1` sorgt dafür, dass der Container ausschließlich
über den Proxy erreichbar ist.

#### Umgebungsvariablen

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `TRUST_PROXY` | nicht gesetzt | Anzahl vorgelagerter Proxys (`1`) oder ein Preset wie `loopback`. Hinter einem Reverse Proxy nötig, damit die Ratenbegrenzung echte Client-Adressen sieht. `true` wird als `1` gelesen: Express würde die Adresse sonst einem Header entnehmen, den der Aufrufer selbst schreibt. |
| `ALLOW_NO_PASSWORD` | `false` | Eine Instanz ohne Passwort für alle erreichbar machen. Nur im lokalen Netz. |
| `FRAME_ANCESTORS` | `'none'` | CSP-Ursprünge, die MySpeed in einem iframe einbetten dürfen – etwa Dashboards wie Homepage oder Heimdall. |
| `HTTPS_REDIRECT` | `true` | Netzwerk-Anfragen auf den HTTPS-Listener umleiten, wenn in `data/certs` ein Zertifikat liegt. Auf `false` setzen, wenn ein Proxy TLS übernimmt und `TRUST_PROXY` nicht gesetzt ist. |
| `ALLOW_LOCAL_NODES` | `false` | Erlaubt Nodes auf Loopback- und Link-Local-Adressen. Standardmäßig aus, damit eine Node-URL den Host nicht abtasten kann. |
| `ALLOWED_NODE_HOSTS` | nicht gesetzt | Beschränkt Nodes auf diese Hosts, kommagetrennt, jeweils mit optionalem Port — `192.168.1.50,myspeed.example.net:5216,[fd00::1]`. Nicht gesetzt erlaubt jeden Host außerhalb der gesperrten Bereiche. Bei einer aus dem Internet erreichbaren Instanz sinnvoll. |

#### Was geschützt ist – und was nicht

Enthalten: Anmeldedrosselung und Ratenbegrenzung pro Endpunkt, ein Limit von 100 KB
für Anfragen außerhalb der beiden Import-Endpunkte, CSP- und Anti-Framing-Header,
Node-URLs ohne Zugriff auf Loopback- und Cloud-Metadaten-Adressen sowie ein
Konfigurations-Export, der Zugangsdaten entfernt, solange nicht `?includeSecrets=true`
angehängt wird.

Trotzdem wissenswert: Das Passwort liegt im `localStorage` des Browsers und wird bei
jeder Anfrage mitgeschickt – wer Zugriff auf das Browserprofil hat, hat es auch. Es
gibt ein gemeinsames Passwort statt einzelner Benutzerkonten. Zugangsdaten liegen
unverschlüsselt in `data/storage.db`; sichere diese Datei so sorgfältig wie einen
Passwort-Manager-Export.

### ⬆️ Update auf 1.1.1

Bei Docker genügt weiterhin `docker pull` und den Container neu erstellen – das
vorhandene Daten-Volume wird beim ersten Start übernommen, da der Server jetzt
als unprivilegierter Benutzer statt als root läuft.

Zwei Änderungen erfordern eine Entscheidung:

- **Eine Instanz ohne Passwort antwortet dem Netzwerk nicht mehr.** Anfragen von
  anderen Rechnern werden abgelehnt, bis ein Passwort gesetzt oder das einmalige
  Setup-Token aus dem Server-Log eingegeben wurde. Lokale Anfragen bleiben
  unberührt, eine reine LAN-Installation läuft also weiter – mit
  `ALLOW_NO_PASSWORD=true` lässt sich das alte Verhalten bewusst beibehalten.
- **Du wirst abgemeldet.** Der Browser speichert das Passwort nicht mehr, sondern
  hält ein Session-Cookie. Die bestehende Anmeldung wird einmalig übernommen,
  danach bedeutet ein Server-Neustart eine erneute Anmeldung.

Alles andere – Datenbank, exportierte Konfigurationen, Integrationen, Nodes –
bleibt unverändert. Ein Migrationsschritt ist nicht nötig.

### 📸 Beispiel-Screenshots

#### Startseite (Listen-Ansicht)

<img src=".github/screenshots/homepage-list.png" alt="Startseite">

#### Startseite (Statistik-Ansicht)

<img src=".github/screenshots/homepage-statistics.png" alt="Statistik">

#### Serverauswahl

<img src=".github/screenshots/server-selection.png" alt="Serverauswahl">

#### Seite während eines Speedtests

<img src=".github/screenshots/speed-test.gif" alt="Seite während eines Speedtests">

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
