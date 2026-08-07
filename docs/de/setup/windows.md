# Windows Setup
Hier beschreiben wir die Einrichtung für Windows.

## Installation von MySpeed

1. MySpeed herunterladen  
   Lade die neueste Version von MySpeed von der [Releases-Seite](https://github.com/i7Gamer/MySpeed/releases/latest) herunter. Lade die Datei `myspeed-windows-x64.exe` herunter.

2. Datei platzieren  
   Verschiebe die heruntergeladene Datei in einen Ordner deiner Wahl (z.B. `C:\MySpeed`). Benenne sie der Einfachheit halber in `myspeed.exe` um.

3. Installation testen  
   Öffne PowerShell oder die Eingabeaufforderung im Ordner, in dem du die Datei platziert hast (Shift + Rechtsklick > "PowerShell-Fenster hier öffnen").  
   Führe die ausführbare Datei aus:
   ```powershell
   .\myspeed.exe
   ```

   Wenn alles erfolgreich durchläuft, hast du alles richtig gemacht! Herzlichen Glückwunsch. :)  
   MySpeed ist jetzt auf Port 5216 verfügbar. Öffne http://localhost:5216 in deinem Browser.

## Automatischer Start mit dem Autostart-Ordner in Windows

1. Autostart-Ordner in Windows öffnen  
   Drücke gleichzeitig die Tasten (`Windows` + `R`) auf deiner Tastatur, bis ein Ausführen-Dialog erscheint. Gib dann `%USERPROFILE%\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup` ein und drücke `Enter`.

2. Verknüpfung erstellen  
   Klicke mit der rechten Maustaste in den Ordner und wähle `Neu` > `Verknüpfung`. Navigiere zu deiner `myspeed.exe`-Datei und erstelle die Verknüpfung.

3. Wenn alles funktioniert hat, sollte MySpeed jetzt automatisch starten, wenn das System hochfährt.

## Alternative: Installation aus dem Quellcode
::: warning Achtung
Dieser Prozess installiert die neueste Entwicklungsversion von MySpeed. Fehler können auftreten.
:::

1. Bun herunterladen  
   Um MySpeed aus dem Quellcode zu bauen, benötigst du **Bun**. Öffne PowerShell und führe aus:
   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

2. MySpeed-Quellcode herunterladen  
   Klone das Repository oder lade den Quellcode von [GitHub](https://github.com/i7Gamer/MySpeed) herunter.

3. Abhängigkeiten installieren und bauen
   ```powershell
   bun install
   cd client && npm install && npm run build && cd .. && move client\build build
   ```

4. MySpeed starten
   ```powershell
   bun run server/index.js
   ```
