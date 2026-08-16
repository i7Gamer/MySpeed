#!/usr/bin/env bash

GREEN='\033[0;32m'
BLUE='\033[1;34m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
NORMAL='\033[0;39m'
PURPLE='\033[0;35m'

INSTALLATION_PATH="/opt/myspeed"

while getopts "d:" o > /dev/null 2>&1; do
    # shellcheck disable=SC2220
    case "${o}" in
        d) INSTALLATION_PATH=${OPTARG} ;;
    esac
done

if [ $EUID -ne 0 ]; then
  echo -e "$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-"
  echo -e "$RED✗ ABORTED"
  echo -e "$NORMAL The installation is currently running via a user without root privileges. However, this is required. Please log in with a Root Account to continue."
  echo -e "$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-"
  exit 1
fi

ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        # Bun's default linux-x64 executable requires AVX2. CPUs without it
        # (pre-Haswell / some Atom/Celeron) die with SIGILL on startup.
        if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then
            BINARY_NAME="MySpeed-linux-x64"
            BINARY_FALLBACK="MySpeed-linux-x64-baseline"
        else
            BINARY_NAME="MySpeed-linux-x64-baseline"
            BINARY_FALLBACK="MySpeed-linux-x64"
            echo -e "$YELLOWℹ Info:$NORMAL CPU has no AVX2 — selecting the baseline Linux binary."
        fi
        ;;
    aarch64|arm64)
        BINARY_NAME="MySpeed-linux-arm64"
        BINARY_FALLBACK=""
        ;;
    *)
        echo -e "$RED✗ Unsupported architecture: $ARCH"
        echo -e "$NORMAL MySpeed only supports x64 and arm64 architectures."
        exit 1
        ;;
esac

echo -e "$GREEN ---------$BLUE Automatic Installation$GREEN ---------"
echo -e "$BLUE MySpeed$YELLOW is now being installed."
echo -e "$YELLOW Version:$BLUE MySpeed Release"
echo -e "$YELLOW Architecture:$BLUE $ARCH ($BINARY_NAME)"
echo -e "$YELLOW Location:$BLUE $INSTALLATION_PATH"
echo -e "$GREEN Installation will start in 5 seconds..."
echo -e "$GREEN ----------------------------------------------"
sleep 5
clear

if [ -d "$INSTALLATION_PATH" ]; then
    clear
    echo -e "$YELLOW-$NORMAL-$YELLOW-$NORMAL-$YELLOW-$NORMAL-$YELLOW-$NORMAL-$YELLOW-$NORMAL-$YELLOW-$NORMAL-$YELLOW-$NORMAL-$YELLOW-$NORMAL-$YELLOW-$NORMAL-"
    echo -e ""
    echo -e "$YELLOW⚠ WARNING"
    echo -e "$NORMAL MySpeed is already installed on this system."
    echo -e ""
    echo -e "$GREENℹ Info:$NORMAL Latest update will be installed..."
    echo -e ""
    echo -e "$YELLOW-$NORMAL-$YELLOW-$NORMAL-$YELLOW-$NORMAL-$YELLOW-$NORMAL-$YELLOW-$NORMAL-$YELLOW-$NORMAL-$YELLOW-$NORMAL-$YELLOW-$NORMAL-$YELLOW-$NORMAL-"
    sleep 5
fi

if command -v systemctl &> /dev/null && systemctl --all --type service | grep -q "myspeed.service"; then
  clear
  echo -e "$YELLOWℹ MySpeed Service is being stopped..."
  systemctl stop myspeed
fi

clear
echo -e ""
echo -e "$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-"
echo -e ""
echo -e "$BLUE🔎 STATUS MESSAGE"
echo -e "$NORMAL Searching for updates for Linux system..."
echo -e ""
echo -e "$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-"
echo -e ""
apt-get update -y

clear
echo -e "$GREENℹ Info:$NORMAL Installation is now being prepared. This may take a moment..."
sleep 3

function check() {
  clear
  echo -e "$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-"
  echo -e "$BLUE🔎 STATUS MESSAGE"
  echo -e "$NORMAL Checking if $1 is present..."
  echo -e "$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-$BLUE-$NORMAL-"
  echo -e ""
  if ! command -v "$1" &> /dev/null
  then
      echo -e "$YELLOWℹ \"$1\" is not installed.$NORMAL Installation will proceed..."
      sleep 2
      echo -e "$PURPLEℹ Installing..."
      apt-get install "$1" -y
  fi
}

check "wget"
check "curl"

clear

echo -e "$BLUE🔎 STATUS MESSAGE"
echo -e "$NORMAL Fetching latest release information..."
# Match the asset name exactly so MySpeed-linux-x64 does not also hit
# MySpeed-linux-x64-baseline.
RELEASE_JSON=$(curl -s https://api.github.com/repos/i7Gamer/MySpeed/releases/latest)
release_asset_url() {
    local name="$1"
    echo "$RELEASE_JSON" | grep -oE "\"browser_download_url\":[[:space:]]*\"[^\"]+/${name}\"" | head -1 | cut -d '"' -f 4
}

RELEASE_URL=$(release_asset_url "$BINARY_NAME")
if [ -z "$RELEASE_URL" ] && [ -n "$BINARY_FALLBACK" ]; then
    echo -e "$YELLOWℹ Info:$NORMAL $BINARY_NAME not in latest release — trying $BINARY_FALLBACK."
    if [ "$BINARY_FALLBACK" = "MySpeed-linux-x64" ]; then
        echo -e "$YELLOWℹ Info:$NORMAL that build requires AVX2 and will likely crash on this CPU."
        echo -e "$NORMAL Build a baseline binary locally with 'bun run build:binary:baseline' until the next release ships one."
    fi
    BINARY_NAME="$BINARY_FALLBACK"
    RELEASE_URL=$(release_asset_url "$BINARY_NAME")
fi

if [ -z "$RELEASE_URL" ]; then
    echo -e "$RED✗ Could not find release for $BINARY_NAME"
    exit 1
fi

echo -e "$GREEN✓ Found release:$NORMAL $RELEASE_URL"
sleep 2

clear
echo -e "$GREEN✓ Preparation completed:$NORMAL Installation of MySpeed will now commence..."
sleep 3

clear
if [ ! -d "$INSTALLATION_PATH" ]; then
    echo -e "$BLUEℹ Info: $NORMAL MySpeed will be installed under directory $INSTALLATION_PATH. Creating the folder now."
    sleep 2
    mkdir -p "$INSTALLATION_PATH"
fi

cd "$INSTALLATION_PATH"

clear
echo -e "$BLUEℹ Info: $NORMAL Downloading MySpeed binary. Please wait..."
sleep 2
wget -O myspeed "$RELEASE_URL"
chmod +x myspeed

clear
echo -e "$BLUE🔎 STATUS MESSAGE"
echo -e "$NORMAL Registering MySpeed as a background service..."
echo -e ""
echo -e ""
sleep 2

if command -v systemctl &> /dev/null; then
  cat << EOF > /etc/systemd/system/myspeed.service
[Unit]
Description=MySpeed
After=network.target

[Service]
Type=simple
ExecStart=$INSTALLATION_PATH/myspeed
Restart=always
User=root
WorkingDirectory=$INSTALLATION_PATH

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload

  if ! systemctl is-enabled myspeed &> /dev/null; then
    echo -e "$NORMALℹ MySpeed will be added to autostart..."
    sleep 1
    systemctl enable myspeed
  fi

  echo -e "$NORMALℹ MySpeed service is starting..."
  sleep 1
  systemctl restart myspeed
fi

clear

if ! command -v systemctl &> /dev/null; then
    echo -e "$YELLOW⚠ Warning: $NORMAL Your Linux system currently does not support starting MySpeed in the background. \"systemd\" is required for this purpose."
    echo -e "$BLUEℹ Info: $NORMAL You can start MySpeed manually by running: $INSTALLATION_PATH/myspeed"
    sleep 5
fi

clear
echo -e "$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-"
echo -e "$GREEN✓ Installation completed: $NORMAL MySpeed has been installed under $INSTALLATION_PATH."
echo -e "You can access the web interface in your browser at$BLUE http://$(curl -s ifconfig.me):5216$NORMAL."
if [ -d "$INSTALLATION_PATH" ]; then
  echo -e "$BLUEℹ Info:$NORMAL To restart MySpeed:$BLUE systemctl restart myspeed"
fi
echo -e "$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-"
