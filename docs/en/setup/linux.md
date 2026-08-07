# Setup Linux
Here the setup for Linux is described. MySpeed can be installed in several ways.

## Installation with Docker

::: tip Help
You don't know how to install Docker? Then check out [this guide](https://docs.docker.com/engine/install/#server)
:::


::: code-group

```sh [Stable Version]
docker run -d -p 5216:5216 -v myspeed:/myspeed/data --restart=unless-stopped --name MySpeed i7gamer/myspeed
```


```sh [Development Version]
docker run -d -p 5216:5216 -v myspeed:/myspeed/data --restart=unless-stopped --name MySpeed i7gamer/myspeed:development
```

:::

## Automatic installation

::: code-group

```sh [Stable Version]
bash <(curl -sSL https://install.myspeed.dev)
```

```sh [Development Version]
curl -sSL https://raw.githubusercontent.com/i7Gamer/MySpeed/development/scripts/install.sh | bash -s -- --beta
```

:::

## Automatic uninstall process
Don't want to use MySpeed anymore? You can easily remove MySpeed. Decide here if you want to keep or delete your data.

::: warning Execute these commands with caution
Executing the commands will result in deletion / uninstallation of MySpeed. Please be aware of this.
:::

::: code-group

```sh [Keep data]
curl -sSL https://raw.githubusercontent.com/i7Gamer/MySpeed/development/scripts/uninstall.sh | bash -s -- --keep-data
```

```sh [Delete data]
curl -sSL https://raw.githubusercontent.com/i7Gamer/MySpeed/development/scripts/uninstall.sh | bash
```

:::

## Manual installation
```sh
sudo apt-get install wget curl -y #(1)

mkdir /opt/myspeed && cd /opt/myspeed #(2)

# Detect architecture and download the appropriate binary
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

1. Here you install all necessary packages to install the project.
2. Now create the folder where you want to install MySpeed. In this case it is the folder `/opt/myspeed`.
3. Download the pre-compiled binary for your architecture (x64 or arm64).
4. Make the binary executable.
5. Now MySpeed is started. MySpeed is now available on port 5216.
   If you plan to run MySpeed in the background, see the guide below.

## Install MySpeed from the source code
::: warning Attention
This process installs the latest development version of MySpeed. Errors may occur.

:::

```sh
sudo apt-get install git curl unzip -y #(1)

# Install Bun
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH" #(2)

mkdir /opt/myspeed && cd /opt/myspeed #(3)

git clone https://github.com/i7Gamer/MySpeed.git . #(4)

bun install #(5)

cd client && npm install && npm run build && cd .. && mv client/build . #(6)

bun run server/index.js #(7)
```

1. Here you install all necessary packages to install the project.
2. This step installs the Bun runtime.
3. Now create the folder where you want to install MySpeed. In this case this is the folder `/opt/myspeed`.
4. Clone the MySpeed repository to get access to the code.
5. Now install all dependencies of the server.
6. Now compile the interface of MySpeed and move it to the folder where MySpeed can read it.
7. Now start MySpeed. MySpeed is now accessible on port 5216.
   If you plan to run MySpeed in the background, see the guide below.


## Install MySpeed 24/7
::: warning Important
You have used the installation script? Then you don't need to do this step at all.
:::

Installing as a system service is not even that hard. In this case we use `systemd`, because it is directly integrated in most Linux distributions.

1. Create a file named `myspeed.service` under `/etc/systemd/system`. Here we use `nano`
   ```sh
   nano /etc/systemd/system/myspeed.service
   ```

2. Now paste the content of the file.
   ```ini
   [Unit]
   Description=MySpeed
   After=network.target

   [Service]
   Type=simple
   ExecStart=/opt/myspeed/myspeed
   Restart=always
   # \/ It is strongly recommended to create your own user here
   User=root
   # \/ Specify your installation location here
   WorkingDirectory=/opt/myspeed 

   [Install]
   WantedBy=multi-user.target
   ```

3. Save the file. This varies a bit depending on the editor

   ::: code-group
   ```sh [nano]
    Press `CTRL` + `X`, then press `Y` and press `Enter` to save the file and exit the editor.
    ```

    ```sh [vim]
    Press `ESC`, then type `:wq` and press `Enter` to save the file and exit the editor.
    ```

4. Now reload systemd
   ```sh
   systemctl daemon-reload
   ```

5. If you want MySpeed to boot at systemd startup, type this command:
   ```sh
   systemctl enable myspeed
   ```

6. Done! Now you can finally start MySpeed.
   ```sh
   systemctl start myspeed
   ```

7. Now check the status of MySpeed
   ```sh
   systemctl status myspeed
   ```