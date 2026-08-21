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

# An empty -d is not a relative path, and must not be made into one. Called as
# `install.sh -d "$MYSPEED_DIR"` with the variable unset, this used to fail safe
# - the path stayed empty and `cd ""` ended the run. Resolved against the working
# directory it becomes a real, existing one, so the install proceeds into
# wherever the caller happened to be, chowns its data and bin subdirectories to
# the service account and writes that path into the unit. Run from the
# filesystem root that re-owns the system bin directory.
if [ -z "$INSTALLATION_PATH" ]; then
  echo -e "$RED✗ ABORTED"
  echo -e "$NORMAL The installation path given with -d is empty. Pass a directory, or omit -d for /opt/myspeed."
  exit 1
fi

# Made absolute before anything is written with it. systemd refuses a relative
# WorkingDirectory, so `-d myspeed` recorded a unit that could not start - and
# the same relative path is what sent the reachability walk climbing for ever.
case "$INSTALLATION_PATH" in
    /*) ;;
    *) INSTALLATION_PATH="$(pwd)/$INSTALLATION_PATH" ;;
esac

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
# Only where there is an apt-get to call. This script targets Debian-shaped
# systems and says so by using apt-get at all; on anything else it used to
# stagger through "command not found" errors and succeed only if curl and wget
# happened to be preinstalled. What it owes those machines is an honest message
# instead of a broken half-install - check() below delivers it.
if command -v apt-get &> /dev/null
then
  apt-get update -y
else
  echo -e "$YELLOWℹ apt-get was not found - skipping the package update.$NORMAL Dependencies are checked next..."
fi

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
      if ! command -v apt-get &> /dev/null
      then
          echo -e "$RED✗ \"$1\" is required and apt-get is not available to install it."
          echo -e "$NORMALℹ Install \"$1\" with your distribution's package manager and run this installer again."
          exit 1
      fi
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
RELEASE_JSON=$(curl -s --max-time 15 https://api.github.com/repos/i7Gamer/MySpeed/releases/latest)

# A rate limit, an outage, or no network answers with JSON holding no assets at
# all, which reads exactly like a release that happens not to carry the file
# being looked for. Everything below reports a missing asset as a fact - and on
# a CPU without AVX2 it stops the install on that basis - so the two have to be
# told apart here, while the difference is still visible.
if ! echo "$RELEASE_JSON" | grep -q "browser_download_url"; then
    echo -e "$RED✗ Could not fetch release information"
    echo -e "$NORMAL The GitHub API did not answer with a release. This is usually a rate limit or no network."
    DETAIL=$(echo "$RELEASE_JSON" | grep -oE "\"message\":[[:space:]]*\"[^\"]*\"" | head -1 | cut -d '"' -f 4)
    [ -n "$DETAIL" ] && echo -e "$NORMAL GitHub said: $DETAIL"
    exit 1
fi

release_asset_url() {
    local name="$1"
    echo "$RELEASE_JSON" | grep -oE "\"browser_download_url\":[[:space:]]*\"[^\"]+/${name}\"" | head -1 | cut -d '"' -f 4
}

RELEASE_URL=$(release_asset_url "$BINARY_NAME")
if [ -z "$RELEASE_URL" ] && [ -n "$BINARY_FALLBACK" ]; then
    # The fallback only runs one way. Baseline starts on every x86_64 CPU, so an
    # AVX2 machine that has to take it loses nothing. The reverse installs a
    # binary that SIGILLs on every start, under a unit written below with
    # Restart=always - a permanent crash loop, announced by the completion
    # banner as a finished installation. Stopping is the more useful answer.
    if [ "$BINARY_FALLBACK" = "MySpeed-linux-x64" ]; then
        echo -e "$RED✗ ABORTED"
        echo -e "$NORMAL This CPU has no AVX2, and $BINARY_NAME is not among the latest release's assets."
        echo -e "$NORMAL $BINARY_FALLBACK needs AVX2 and would crash on every start here, so it was not installed."
        echo -e "$NORMAL Build one on a Linux machine with 'bun run build:binary:baseline', or wait for the next release."
        exit 1
    fi

    echo -e "$YELLOWℹ Info:$NORMAL $BINARY_NAME not in latest release — trying $BINARY_FALLBACK."
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

# An unwritable path, a read-only mount or a name already taken by a file all
# leave this failing - and unchecked, the binary was then written into whatever
# directory the caller happened to be in while the unit still pointed at
# $INSTALLATION_PATH.
if ! cd "$INSTALLATION_PATH"; then
    echo -e "$RED✗ Could not enter $INSTALLATION_PATH.$NORMAL Check that the path exists and is writable."
    exit 1
fi

clear
echo -e "$BLUEℹ Info: $NORMAL Downloading MySpeed binary. Please wait..."
sleep 2

# Downloaded beside the installed binary, never over it.
#
# `wget -O` opens and truncates its output file before the transfer starts, so
# pointing it at `myspeed` destroyed a working install the moment it ran. Nothing
# checked the result either, and there is no `set -e`, so a download that died
# mid-transfer - a dropped link, a proxy that blocks the CDN, a full disk - fell
# straight through to writing the service, restarting it, and printing
# "Installation completed" over a zero-byte executable in a Restart=always loop,
# exiting 0 so a pipeline read it as a successful upgrade.
#
# This is the same conclusion the AVX2 check above reaches: a permanent crash
# loop announced as a finished installation is worse than stopping.
DOWNLOAD_TMP="myspeed.download.$$"

if ! wget --timeout=30 -O "$DOWNLOAD_TMP" "$RELEASE_URL"; then
    rm -f "$DOWNLOAD_TMP"
    echo -e "$RED✗ Could not download MySpeed from $RELEASE_URL"
    echo -e "$NORMALℹ Any existing installation has been left untouched."
    exit 1
fi

# A 200 carrying an error page, or a transfer that ended at zero bytes, is not a
# binary - and making it executable below makes it look like one to systemd.
if [ ! -s "$DOWNLOAD_TMP" ]; then
    rm -f "$DOWNLOAD_TMP"
    echo -e "$RED✗ The download produced an empty file.$NORMAL The release may be incomplete."
    echo -e "$NORMALℹ Any existing installation has been left untouched."
    exit 1
fi

# Stated rather than added to. `chmod +x` is masked by the umask - POSIX says so
# - and wget creates the file at 666 less that mask, so on a host where root runs
# with 077 this left the binary at 700. That did not matter while the whole
# installation was handed to the service account, because it then owned the
# binary; root keeps it now, so 700 is a binary the service can neither read nor
# execute, under a unit with Restart=always. The install directory is created
# under the same mask, so the usual way in is an upgrade: the directory is
# already there and traversable, nothing falls back to root, and only the new
# binary comes out unreadable.
chmod 755 "$DOWNLOAD_TMP"
mv -f "$DOWNLOAD_TMP" myspeed

clear
echo -e "$BLUE🔎 STATUS MESSAGE"
echo -e "$NORMAL Registering MySpeed as a background service..."
echo -e ""
echo -e ""
sleep 2

# The account the service runs as, which used to be root.
#
# Nothing MySpeed does needs a privilege: it listens on 5216, which is above the
# reserved range, and it writes its database and its logs inside its own
# installation directory. What it also does is download a third-party speedtest
# CLI at first boot and spawn it - so as root, a replaced upstream asset or any
# remote-code flaw in the server ran with full access to the host. The Docker
# path for the same code already drops to an unprivileged user.
#
# The home directory is the installation path rather than nothing, and it is not
# load-bearing: the account needs no writable home, because the Ookla CLI is
# spawned with --accept-license and --accept-gdpr on every run - see the argument
# list in server/util/speedtest.js - so there is no acceptance for it to store
# and nothing for it to re-prompt about. Which matters here, because the
# installation root stays with root below and this $HOME is therefore not
# writable by the account that names it.
#
# What the coupling does cost is a stale $HOME: useradd only runs when the
# account is missing, so reinstalling at a different -d path leaves the home
# pointing at the old one.
#
# The sandbox below is written against $INSTALLATION_PATH rather than against
# /opt, because -d puts it anywhere. ReadWritePaths names it explicitly, so
# ProtectSystem=full cannot make the one directory the service writes read-only
# - which is what "-d /usr/local/myspeed" would otherwise do, leaving a service
# that starts, fails to create its data folders, and restarts for ever behind a
# banner saying the install completed.
#
# ProtectHome is deliberately not among them: it makes /home and /root
# inaccessible, and "-d /root/myspeed" is a path a root user typing this command
# will reach for. That path is handled below by falling back to root rather than
# by the sandbox, but a directive that would break it for the fallback too is
# still the wrong thing to add.
SERVICE_USER="myspeed"

if ! id -u "$SERVICE_USER" > /dev/null 2>&1 && command -v useradd &> /dev/null; then
    useradd --system --no-create-home --home-dir "$INSTALLATION_PATH" \
        --shell /usr/sbin/nologin "$SERVICE_USER" > /dev/null 2>&1 || true
fi

# Whether an unprivileged account could reach the installation at all.
#
# systemd chdirs to WorkingDirectory and execs ExecStart *after* dropping to
# User=, so every directory above the installation has to be traversable by that
# account. "-d /root/myspeed" is the case: /root is 0700 root:root, and handing
# over the installation never touches /root itself, so the service fails chdir
# with EACCES and Restart=always turns that into a permanent loop behind a banner
# saying the install completed. Asked rather than assumed, because that failure
# is invisible until somebody opens the port.
#
# The other-execute bit is what decides it: this account is in no group of the
# directories above it, so group permissions cannot help.
reachable_by_service() {
    local directory="$1"
    local parent

    while :; do
        [ -n "$(find "$directory" -maxdepth 0 -perm -o=x 2>/dev/null)" ] || return 1

        # Stop where the walk stops moving, rather than at "/" alone. Only an
        # absolute path ever reaches "/": `dirname "."` is ".", so a relative
        # one - which `-d myspeed` gives - climbed for ever, hanging the
        # installer in a loop no message explained and only Ctrl-C ended.
        parent=$(dirname "$directory")
        [ "$parent" = "$directory" ] && return 0
        directory="$parent"
    done
}

# Falling back rather than failing, in both directions. A system with no useradd,
# and a path the account cannot reach, each still get a working install: a unit
# naming an account that does not exist, or one that cannot chdir to its own
# directory, starts nothing at all - which is worse than the privilege being
# dropped here. Said out loud, because these are the cases where the install is
# less safe than it reads.
SERVICE_ACCOUNT="root"
SERVICE_FALLBACK=""

if ! id -u "$SERVICE_USER" > /dev/null 2>&1; then
    SERVICE_FALLBACK="the \"$SERVICE_USER\" account could not be created"
elif ! reachable_by_service "$INSTALLATION_PATH"; then
    SERVICE_FALLBACK="$INSTALLATION_PATH cannot be reached by an unprivileged account"
else
    SERVICE_ACCOUNT="$SERVICE_USER"
fi

if [ "$SERVICE_ACCOUNT" = "$SERVICE_USER" ]; then
    # These two and nothing else. The server writes its database, its logs and
    # the CLI it downloads under `data` and `bin`, and writes nothing at the
    # installation root - so creating them here means the account never needs
    # the root, and a recursive chown never leaves the directories this script
    # made.
    #
    # It used to hand over $INSTALLATION_PATH whole, behind a check that the
    # path held a `myspeed` file. That check could not work: the script writes
    # that file itself a few lines above, so it passed for any path on a host
    # that had none - "-d /opt" re-owned every other application under /opt, and
    # "-d /" the filesystem. It fired only when `myspeed` was a *directory*,
    # which is a real prior install one level down: exactly the wrong way round.
    #
    # Leaving the binary with root is worth having for itself: the account that
    # runs it cannot rewrite it.
    #
    # Before the service is registered, not after - on an upgrade these are
    # owned by root because that is what installed them, and the first thing the
    # new account would otherwise do is fail to open its own database.
    #
    # The user only, not user:group - useradd --system creates a matching group
    # on Debian and RHEL but not everywhere, and a chown that names a group that
    # does not exist changes nothing at all.
    mkdir -p "$INSTALLATION_PATH/data" "$INSTALLATION_PATH/bin"
    chown -R "$SERVICE_USER" "$INSTALLATION_PATH/data" "$INSTALLATION_PATH/bin"
else
    echo -e "$YELLOW⚠ Warning: $NORMAL $SERVICE_FALLBACK, so MySpeed will run as root."
    sleep 2
fi

if command -v systemctl &> /dev/null; then
  cat << EOF > /etc/systemd/system/myspeed.service
[Unit]
Description=MySpeed
After=network.target

[Service]
Type=simple
ExecStart=$INSTALLATION_PATH/myspeed
Restart=always
User=$SERVICE_ACCOUNT
WorkingDirectory=$INSTALLATION_PATH
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$INSTALLATION_PATH
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true

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
# The address is a convenience, and the lookup is judged whole: -f turns an
# HTTP error page into a failure instead of an address, and a failed or timed
# out lookup is discarded outright - command substitution keeps whatever
# partial bytes arrived before a timeout, so splicing a fallback onto curl's
# output would print half an address for a slow link.
PUBLIC_ADDRESS=$(curl -sf --max-time 5 ifconfig.me) || PUBLIC_ADDRESS=""
if [ -z "$PUBLIC_ADDRESS" ]; then
  PUBLIC_ADDRESS="<this-server's-address>"
fi

echo -e "You can access the web interface in your browser at$BLUE http://$PUBLIC_ADDRESS:5216$NORMAL."
if [ -d "$INSTALLATION_PATH" ]; then
  echo -e "$BLUEℹ Info:$NORMAL To restart MySpeed:$BLUE systemctl restart myspeed"
fi
echo -e "$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-"
