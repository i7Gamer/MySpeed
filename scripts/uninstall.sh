#!/usr/bin/env bash


GREEN='\033[0;32m'
BLUE='\033[1;34m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
NORMAL='\033[0;39m'

INSTALLATION_PATH="/opt/myspeed"
DOCKER_INSTALLATION_PATH="/opt/myspeed-dockerized"

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
  if [ "$1" != "--keep-data" ]; then
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
  if [ "$1" == "--keep-data" ]; then
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
    rm -R "$INSTALLATION_PATH"
  fi
fi

clear
echo -e "$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-" #multicolor
echo -e "$GREEN✓ Completed: $NORMAL MySpeed has been uninstalled."
echo -e "$NORMAL You can reinstall MySpeed anytime. Find the instructions at https://github.com/i7Gamer/MySpeed#readme."
echo -e "$RED Thank you for using MySpeed!"
echo -e "$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-" #multicolor
