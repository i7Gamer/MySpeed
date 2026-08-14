#!/usr/bin/env bash


GREEN='\033[0;32m'
BLUE='\033[1;34m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
NORMAL='\033[0;39m'

INSTALLATION_PATH="/opt/myspeed"
DOCKER_INSTALLATION_PATH="/opt/myspeed-dockerized"
SERVICE_FILES=("/etc/systemd/system/myspeed.service" "/usr/lib/systemd/system/myspeed.service")

# Parsed by hand rather than with getopts, which stops at the first argument
# beginning with "--" and would leave --keep-data unseen the moment -d is also
# passed. Both flags are read wherever they appear.
KEEP_DATA=""
CHOSEN_PATH=""

while [ $# -gt 0 ]; do
  case "$1" in
    --keep-data) KEEP_DATA="--keep-data" ;;
    -d) shift; CHOSEN_PATH="$1" ;;
  esac
  shift
done

# Where the installation actually is, which is not always the default:
# install.sh takes -d and records the chosen path in the unit's
# WorkingDirectory. Read back here because the operator uninstalling months
# later need not be the one who chose it, and the system already knows.
#
# It has to happen before the systemd block below, which deletes the unit file -
# and with it the only record of where anything was put.
if [ -n "$CHOSEN_PATH" ]; then
  INSTALLATION_PATH="$CHOSEN_PATH"
else
  for unit in "${SERVICE_FILES[@]}"; do
    [ -f "$unit" ] || continue

    RECORDED="$(sed -n 's/^WorkingDirectory=//p' "$unit" | head -n 1)"
    [ -n "$RECORDED" ] && INSTALLATION_PATH="$RECORDED"
    break
  done
fi

if [ $EUID -ne 0 ]; then
  echo -e "$RED✗ Uninstallation Error:$NORMAL You need root privileges to initiate the uninstallation."
  exit 1
fi

echo -e "$GREEN ---------$BLUE Automatic Uninstallation$GREEN ---------"
echo -e "$BLUE MySpeed$YELLOW is now being uninstalled."
echo -e "$YELLOW If you want to$RED cancel$YELLOW, you can abort the uninstallation by pressing$RED CTRL + C$YELLOW."
echo -e "$GREEN Uninstallation will begin in 5 seconds..."
echo -e "$GREEN ----------------------------------------------"
sleep 5

clear
echo -e "$BLUE🔎 Status:$NORMAL Removing service data if present..."
sleep 3

if docker ps -a --format '{{.Names}}' | grep -q "MySpeed"; then
  echo -e "$YELLOW Found Docker container. Stopping the container..."
  docker stop MySpeed
  echo -e "$YELLOW Removing Docker container..."
  docker rm MySpeed
  echo -e "$YELLOW Removing MySpeed Docker folder..."
  if [ "$KEEP_DATA" != "--keep-data" ]; then
    docker volume rm myspeed-dockerized_myspeed
  fi
  rm -rf "$DOCKER_INSTALLATION_PATH"
else
  if command -v systemctl &> /dev/null && systemctl --all --type service | grep -n "myspeed.service"; then
    systemctl stop myspeed
    systemctl disable myspeed
    rm /etc/systemd/system/myspeed.service
    rm /usr/lib/systemd/system/myspeed.service
    systemctl daemon-reload
    systemctl reset-failed
  fi

  clear
  echo -e "$BLUE🔎 Status:$NORMAL Removing MySpeed system data if present..."
  sleep 3

  # Remove folder
  if [ "$KEEP_DATA" == "--keep-data" ]; then
    # A fresh staging directory every run, rather than a fixed /tmp path.
    #
    # mv renames into an empty destination but moves *into* an existing
    # directory, so a fixed path left behind by an interrupted uninstall turned
    # the staging step into /tmp/myspeed_data/data, and the restore put that
    # back as $INSTALLATION_PATH/data/data - one level too deep for the server
    # to find, which presents as total data loss.
    #
    # Deleting that leftover first would be worse, not better: after an
    # interrupted run it is the only surviving copy of the database. mktemp
    # cannot collide with anything, so there is nothing to delete.
    STAGING="$(mktemp -d)" || { echo -e "$RED✗ Could not create a staging directory. Nothing was removed.$NORMAL"; exit 1; }

    # Guarded, because the step after it is the one that cannot be undone. This
    # is a cross-filesystem copy in practice - /opt on disk, /tmp often tmpfs -
    # so a full /tmp fails here, and deleting the installation anyway would
    # destroy the data this flag exists to keep.
    if ! mv "$INSTALLATION_PATH/data" "$STAGING/data"; then
      echo -e "$RED✗ Could not move the data directory to safety. Nothing was removed.$NORMAL"
      exit 1
    fi

    rm -R "$INSTALLATION_PATH"
    mkdir "$INSTALLATION_PATH"
    mv "$STAGING/data" "$INSTALLATION_PATH/data"
    rmdir "$STAGING"
  else
    # Checked, because this is the step that cannot be undone and it was the one
    # whose failure was discarded. There is no `set -e`, so a path that was
    # never there failed to stderr and the success banner printed anyway - which
    # is worse than the failure, because it is what stops anyone going to look.
    if ! rm -R "$INSTALLATION_PATH"; then
      echo -e "$RED✗ Could not remove $INSTALLATION_PATH.$NORMAL"
      echo -e "$NORMAL The service has been stopped and removed, but the installation is still on disk."
      echo -e "$NORMAL If it was installed elsewhere, re-run with$YELLOW -d /your/path$NORMAL."
      exit 1
    fi
  fi
fi

clear
echo -e "$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-" #multicolor
echo -e "$GREEN✓ Completed: $NORMAL MySpeed has been uninstalled."
echo -e "$NORMAL You can reinstall MySpeed anytime. Find the instructions at https://github.com/i7Gamer/MySpeed#readme."
echo -e "$RED Thank you for using MySpeed!"
echo -e "$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-" #multicolor
