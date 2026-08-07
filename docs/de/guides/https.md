# HTTPS einrichten

::: tip Warum HTTPS verwenden?
HTTPS verschlüsselt die Verbindung zwischen deinem Browser und MySpeed und schützt deine Daten vor dem Abfangen.
Dies ist besonders wichtig, wenn du über ein Netzwerk oder das Internet auf MySpeed zugreifst.
:::

## Übersicht

MySpeed unterstützt HTTPS nativ ohne einen Reverse Proxy zu benötigen. Lege einfach deine SSL-Zertifikate im Verzeichnis `data/certs` ab, und MySpeed startet automatisch einen HTTPS-Server.

## Konfiguration

### Umgebungsvariablen

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `HTTPS_PORT` | `5217` | Der Port für den HTTPS-Server |

### Zertifikatsdateien

Lege deine SSL-Zertifikate im Verzeichnis `data/certs` ab:

- `cert.pem` - Dein SSL-Zertifikat
- `key.pem` - Dein privater Schlüssel

Die Ordnerstruktur sollte so aussehen:

```
MySpeed/
├── data/
│   ├── certs/
│   │   ├── cert.pem
│   │   └── key.pem
│   └── ...
└── ...
```

## Eigene Zertifikate verwenden

Wenn du bereits SSL-Zertifikate hast (z.B. von Let's Encrypt oder einer Zertifizierungsstelle), kopiere sie in das Verzeichnis `data/certs`:

```sh
cp /pfad/zu/deinem/zertifikat.pem /pfad/zu/myspeed/data/certs/cert.pem
cp /pfad/zu/deinem/privater-schluessel.pem /pfad/zu/myspeed/data/certs/key.pem
```

## Selbstsigniertes Zertifikat erstellen

Für Tests oder den internen Gebrauch kannst du ein selbstsigniertes Zertifikat erstellen:

```sh
openssl req -x509 -newkey rsa:4096 \
  -keyout data/certs/key.pem \
  -out data/certs/cert.pem \
  -sha256 -days 365 -nodes \
  -subj "/C=DE/ST=Bundesland/L=Stadt/O=Organisation/OU=Abteilung/CN=localhost"
```

::: warning Selbstsignierte Zertifikate
Selbstsignierte Zertifikate zeigen eine Sicherheitswarnung im Browser an. Das ist bei selbstsignierten Zertifikaten normal.
Für den Produktiveinsatz empfehlen wir Zertifikate von einer vertrauenswürdigen Zertifizierungsstelle wie Let's Encrypt.
:::

## Let's Encrypt Zertifikate verwenden

Wenn du Let's Encrypt mit certbot verwendest, werden deine Zertifikate normalerweise in `/etc/letsencrypt/live/deine-domain.de/` gespeichert. Du kannst sie entweder kopieren oder verlinken:

```sh
# Zertifikate kopieren
sudo cp /etc/letsencrypt/live/deine-domain.de/fullchain.pem /pfad/zu/myspeed/data/certs/cert.pem
sudo cp /etc/letsencrypt/live/deine-domain.de/privkey.pem /pfad/zu/myspeed/data/certs/key.pem

# Stelle sicher, dass MySpeed sie lesen kann
sudo chown $USER:$USER /pfad/zu/myspeed/data/certs/*.pem
```

::: tip Zertifikatserneuerung
Denke daran, deine Zertifikate im Verzeichnis `data/certs` zu aktualisieren, wenn sie erneuert werden.
Du kannst dies mit einem Post-Renewal-Hook in certbot automatisieren.
:::

## Überprüfen ob HTTPS funktioniert

Nachdem du deine Zertifikate abgelegt und MySpeed gestartet hast, solltest du in der Konsole sehen:

```
Server listening on port 5216
HTTPS server listening on port 5217
```

Du kannst dann auf MySpeed zugreifen über:
- HTTP: `http://localhost:5216`
- HTTPS: `https://localhost:5217`

## Docker-Konfiguration

Bei Verwendung von Docker mountest du das Zertifikatsverzeichnis:

```yaml
version: "3"
services:
  myspeed:
    image: i7gamer/myspeed
    ports:
      - "5216:5216"
      - "5217:5217"  # HTTPS-Port
    volumes:
      - /pfad/zu/myspeed:/myspeed/data
      # Zertifikate befinden sich in /pfad/zu/myspeed/certs/
    environment:
      - HTTPS_PORT=5217  # Optional, 5217 ist Standard
```

