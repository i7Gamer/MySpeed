# Setup Windows
Here we describe the setup for Windows.

## Installing MySpeed

1. Download MySpeed  
   Download the latest version of MySpeed from the [releases page](https://github.com/i7Gamer/MySpeed/releases/latest). Download the file `myspeed-windows-x64.exe`.

2. Place the file  
   Move the downloaded file to a folder of your choice (e.g., `C:\MySpeed`). Rename it to `myspeed.exe` for convenience.

3. Test your installation  
   Open PowerShell or Command Prompt in the folder where you placed the file (Shift + Right-click > "Open PowerShell window here").  
   Run the executable:
   ```powershell
   .\myspeed.exe
   ```

   If everything runs successfully, you did everything right! Congratulations. :)   
   MySpeed is now available on port 5216. Open http://localhost:5216 in your browser.

## Automatic startup using the autostart folder in Windows

1. Open the autostart folder in windows  
   Press both keys (`Windows` + `R`) simultaneously on your keyboard until a Run dialog appears. Then type `%USERPROFILE%\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup` and press `Enter`.

2. Create a shortcut  
   Right-click in the folder and select `New` > `Shortcut`. Browse to your `myspeed.exe` file and create the shortcut.

3. If everything worked, MySpeed should now start automatically when the system is started.

## Alternative: Install from source code
::: warning Attention
This process installs the latest development version of MySpeed. Errors may occur.
:::

1. Download Bun  
   To build MySpeed from source, you need **Bun**. Open PowerShell and run:
   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

2. Download MySpeed source  
   Clone the repository or download the source code from [GitHub](https://github.com/i7Gamer/MySpeed).

3. Install dependencies and build
   ```powershell
   bun install
   cd client && npm install && npm run build && cd .. && move client\build build
   ```

4. Start MySpeed
   ```powershell
   bun run server/index.js
   ```