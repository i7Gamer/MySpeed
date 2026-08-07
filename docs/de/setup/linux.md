# Einrichtung unter Linux

Hier wird die Einrichtung von MySpeed unter Linux beschrieben. MySpeed kann auf verschiedene Arten installiert werden.

## Installation mit Docker

::: tip Hilfe
Du weißt nicht, wie man Docker installiert? Schau dir [diese Anleitung](https://docs.docker.com/engine/install/#server) an.
:::

::: code-group

```sh [Stabile Version]
docker run -d -p 5216:5216 -v myspeed:/myspeed/data --restart=unless-stopped --name MySpeed i7gamer/myspeed
```

```sh [Entwicklerversion]
docker run -d -p 5216:5216 -v myspeed:/myspeed/data --restart=unless-stopped --name MySpeed i7gamer/myspeed:development
```

:::

## Automatische Installation

::: code-group

```sh [Stabile Version]
bash <(curl -sSL https://install.myspeed.dev)
```

```sh [Entwicklerversion]
curl -sSL https://raw.githubusercontent.com/i7Gamer/MySpeed/development/scripts/install.sh | bash -s -- --beta
```

:::

## Automatischer Deinstallationsprozess
Möchtest du MySpeed nicht mehr verwenden? Du kannst es leicht entfernen. Entscheide hier, ob du deine Daten behalten oder löschen möchtest.

::: warning Führe diese Befehle vorsichtig aus
Das Ausführen der Befehle führt zur Löschung / Deinstallation von MySpeed. Bitte sei dir dessen bewusst.
:::

::: code-group

```sh [Daten behalten]
curl -sSL https://raw.githubusercontent.com/i7Gamer/MySpeed/development/scripts/uninstall.sh | bash -s -- --keep-data
```

```sh [Daten löschen]
curl -sSL https://raw.githubusercontent.com/i7Gamer/MySpeed/development/scripts/uninstall.sh | bash
```

:::

## Manuelle Installation
```sh
sudo apt-get install wget curl -y #(1)

mkdir /opt/myspeed && cd /opt/myspeed #(2)

# Architektur erkennen und passende Binary herunterladen
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
  ARCH="x64"
elif [ "$ARCH" = "aarch64" ]; then
  ARCH="arm64"
fi

wget $(curl -s https://api.github.com/repos/i7Gamer/MySpeed/releases/latest \
  | grep "browser_download_url.*linux-${ARCH}" | cut -d '"' -f 4) \
  -O myspeed #(3)

chmod +x myspeed #(4)

./myspeed #(5)
```

1. Hier werden alle notwendigen Pakete für die Installation des Projekts installiert.
2. Erstelle nun den Ordner, in dem du MySpeed installieren möchtest. In diesem Fall ist es der Ordner `/opt/myspeed`.
3. Lade die vorkompilierte Binary für deine Architektur (x64 oder arm64) herunter.
4. Mache die Binary ausführbar.
5. Starte nun MySpeed. MySpeed ist jetzt auf Port 5216 verfügbar.
   Wenn du planst, MySpeed im Hintergrund laufen zu lassen, siehe die Anleitung unten.

## Installation von MySpeed aus dem Quellcode
::: warning Achtung
Dieser Prozess installiert die neuste Entwicklungsversion von MySpeed. Fehler können auftreten.
:::

```sh
sudo apt-get install git curl unzip -y #(1)

# Bun installieren
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH" #(2)

mkdir /opt/myspeed && cd /opt/myspeed #(3)

git clone https://github.com/i7Gamer/MySpeed.git . #(4)

bun install #(5)

cd client && npm install && npm run build && cd .. && mv client/build . #(6)

bun run server/index.js #(7)
```

1. Hier installierst du alle notwendigen Pakete, um das Projekt zu installieren.
2. Dieser Schritt installiert die Bun Runtime.
3. Erstelle nun den Ordner, in welchen du MySpeed installieren möchtest. In diesem Fall ist das der Ordner `/opt/myspeed`.
4. Klone nun das MySpeed Repository, um Zugriff auf den Code zu erhalten.
5. Installiere nun alle Abhängigkeiten des Servers.
6. Jetzt kompilierst du die Oberfläche von MySpeed und verschiebst sie in den Ordner wo MySpeed sie lesen kann.
7. Jetzt wird MySpeed gestartet. MySpeed ist nun unter dem Port 5216 erreichbar.
   Wenn du planst, MySpeed im Hintergrund laufen zu lassen, dann schau dir den Guide dafür unten an.


## MySpeed 24/7 installieren
::: warning Wichtig
Hast du das Installations-Script verwendet? Dann musst du diesen Schritt überhaupt nicht ausführen.
:::

Die Installation als Systemdienst ist nicht schwer. In diesem Fall verwenden wir `systemd`, da es in den meisten Linux-Distributionen direkt integriert ist.

1. Erstelle eine Datei namens `myspeed.service` unter `/etc/systemd/system`. Hier verwenden wir `nano`
   ```sh
   nano /etc/systemd/system/myspeed.service
   ```

2. Füge nun den Inhalt der Datei ein.
   ```ini
   [Unit]
   Description=MySpeed
   After=network.target

   [Service]
   Type=simple
   ExecStart=/opt/myspeed/myspeed
   Restart=always
   # \/ Es wird dringend empfohlen, hier deinen eigenen Benutzer zu erstellen
   User=root
   # \/ Gib hier deinen Installationsort an
   WorkingDirectory=/opt/myspeed 

   [Install]
   WantedBy=multi-user.target
   ```

3. Speichere die Datei. Dies variiert je nach Editor.

   ::: code-group
   ```sh [nano]
    Drücke `STRG` + `X`, dann drücke `Y` und drücke `Enter`, um die Datei zu speichern und den Editor zu verlassen.
    ```

    ```sh [vim]
    Drücke `ESC`, tippe dann `:wq` und drücke `Enter`, um die Datei zu speichern und den Editor zu verlassen.
    ```

4. Lade nun systemd neu.
   ```sh
   systemctl daemon-reload
   ```

5. Wenn du möchtest, dass MySpeed beim Start von systemd startet, gib diesen Befehl ein:
   ```sh
   systemctl enable myspeed
   ```

6. Fertig! Jetzt kannst du MySpeed starten.
   ```sh
   systemctl start myspeed
   ```

7. Überprüfe nun den Status von MySpeed.
   ```sh
   systemctl status myspeed
   ```
