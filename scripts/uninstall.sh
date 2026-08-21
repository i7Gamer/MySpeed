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

# Exactly, not merely containing: an unrelated MySpeedBackup container is not
# this one, and the substring match that used to decide this took its whole
# branch on the strength of the name.
REMOVED_CONTAINER=0

if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "MySpeed"; then
  REMOVED_CONTAINER=1
  echo -e "$YELLOW Found Docker container. Stopping the container..."
  docker stop MySpeed
  echo -e "$YELLOW Removing Docker container..."
  docker rm MySpeed
  echo -e "$YELLOW Removing MySpeed Docker folder..."
  if [ "$KEEP_DATA" != "--keep-data" ]; then
    docker volume rm myspeed-dockerized_myspeed
  fi
  rm -rf "$DOCKER_INSTALLATION_PATH"
fi

# Asked on its own, not as the other half of the question above.
#
# A host can hold both. The README recommends Docker, so migrating a native
# install means the container runs beside a systemd unit that is still enabled -
# and that is exactly when somebody reaches for this script. Written as an
# `else`, finding the container was the end of it: the service kept running, the
# unit stayed enabled through every reboot, and the installation stayed on disk
# with its database and its password hash, under a banner announcing that
# MySpeed had been uninstalled.
#
# Both halves are guarded on finding their own, so a host with only one pays
# nothing for the other being asked.
#
# Recorded but not consulted below: what decides whether the installation
# directory is removed is whether there is one, not whether a unit named it.
FOUND_SERVICE=0

# -q, not -n: the condition wants an answer, and -n printed the matched line
# and its number into the middle of the uninstall output.
if command -v systemctl &> /dev/null && systemctl --all --type service | grep -q "myspeed.service"; then
  FOUND_SERVICE=1

  systemctl stop myspeed
  systemctl disable myspeed

  # Through the list that names them, guarded - the same list this script
  # already walks to read the recorded path. Spelled out as two bare `rm`s,
  # every ordinary uninstall printed "cannot remove ...: No such file or
  # directory" for the path install.sh never creates, swallowed for want of
  # `set -e`, directly beneath the success banner.
  for unit in "${SERVICE_FILES[@]}"; do
    rm -f "$unit"
  done

  systemctl daemon-reload
  systemctl reset-failed
fi

# And the installation itself, unless a container was the whole of what was here.
#
# `rm -R` on a path that was never there is checked and fatal, deliberately: that
# check is what stops a removal which failed from printing the success banner. So
# it cannot simply run always - a docker-only host has no /opt/myspeed, and would
# have its finished uninstall reported as a failure.
#
# A native host reaches the removal whatever was found, so a wrong -d still earns
# the message naming the path it could not remove - the sentence that sends
# anyone to look for where their installation actually is.
#
# FOUND_SERVICE is deliberately not part of this. Treating a unit as evidence
# that there is something to remove looks right and is not: on a host holding
# both a container and a stale unit, with the directory already gone, it pulled
# execution into a removal with nothing left to remove, printed "the installation
# is still on disk" over a host where it was not, and exited 1 on an uninstall
# that had removed everything it found. The question is whether anything is at
# that path, and -d asks it.
if [ "$REMOVED_CONTAINER" -eq 0 ] || [ -d "$INSTALLATION_PATH" ]; then
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

    # The mode is stated because mkdir applies the umask, and what reads it is
    # the *next* install: reachable_by_service walks this directory, and root on
    # a hardened host runs with 027 or 077, so the recreated directory came back
    # 0750 or 0700 and install.sh fell back to SERVICE_ACCOUNT="root". Keeping
    # the data is what makes reinstalling the easy path, so this flag was the
    # quiet way an installation lost its privilege separation. install.sh states
    # the same mode where it creates the directory itself.
    chmod 755 "$INSTALLATION_PATH"

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

  # The account install.sh creates, taken back out with the files it owned.
  #
  # Without this, an uninstall that removes the binary, the unit and the whole
  # directory still reports "MySpeed has been uninstalled" while leaving a
  # `myspeed` entry in /etc/passwd whose home directory is the path just
  # deleted - and it survives every later uninstall too, because the installer
  # only runs useradd when the account is missing.
  #
  # Not under --keep-data, and that is the whole reason this is a condition
  # rather than a line: that flag exists to leave the database on disk for a
  # later reinstall, and those files belong to this account. Delete it and they
  # belong to a free uid, which the next account created on this host may be
  # given. Data that is being kept keeps its owner.
  #
  # Guarded on both sides, and never fatal: a system without userdel must not
  # fail an uninstall over it, and an install that fell back to root created no
  # account to remove.
  SERVICE_USER="myspeed"

  if [ "$KEEP_DATA" != "--keep-data" ] && command -v userdel &> /dev/null \
      && id -u "$SERVICE_USER" > /dev/null 2>&1; then
    userdel "$SERVICE_USER" > /dev/null 2>&1 || true
  fi
fi

clear
echo -e "$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-" #multicolor
echo -e "$GREEN✓ Completed: $NORMAL MySpeed has been uninstalled."
echo -e "$NORMAL You can reinstall MySpeed anytime. Find the instructions at https://github.com/i7Gamer/MySpeed#readme."
echo -e "$RED Thank you for using MySpeed!"
echo -e "$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-$GREEN-$NORMAL-" #multicolor
