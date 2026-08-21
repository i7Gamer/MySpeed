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
#
# Every arm refuses rather than shrugs, because every way of mis-parsing this
# command line ends in deleting something:
#
#   - `-d` took whatever followed it, flag or not. `uninstall.sh -d $DIR
#     --keep-data` with DIR unset - an ordinary thing for a wrapper script to do
#     - read "--keep-data" as the path, so the flag was never seen and the very
#     next block removed the docker volume holding the database it was typed to
#     keep.
#   - `-d` with nothing after it, or with an empty value, fell through to the
#     compiled-in default and deleted that instead. install.sh refuses the same
#     input.
#   - Anything unrecognised was shifted away in silence. `--help` ran a complete
#     destructive uninstall, and every near-miss of the one flag that protects
#     data - `--keepdata`, `-keep-data`, `--keep_data` - destroyed it.
KEEP_DATA=""
CHOSEN_PATH=""

usage() {
  echo -e "$NORMAL Usage: uninstall.sh [-d /path/to/installation] [--keep-data]"
  echo -e "$NORMAL   -d           where MySpeed is installed, when it is not the recorded path"
  echo -e "$NORMAL   --keep-data  keep the data directory, and the account that owns it"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --keep-data)
      KEEP_DATA="--keep-data"
      ;;
    -d)
      # The value, not merely the next word: a flag there means the path was
      # never supplied, and continuing would delete the default.
      if [ $# -lt 2 ] || [ -z "$2" ] || [ "${2#-}" != "$2" ]; then
        echo -e "$RED✗ Uninstallation Error:$NORMAL -d needs the path MySpeed is installed at."
        usage
        exit 1
      fi
      CHOSEN_PATH="$2"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo -e "$RED✗ Uninstallation Error:$NORMAL Unknown argument \"$1\"."
      usage
      exit 1
      ;;
  esac
  shift
done

# And a -d that could not name an installation is refused here, rather than
# discovered by the one step in this script that cannot be undone.
#
# `-d /` passes every check below it - the directory exists, it is not a symlink -
# and arrives at `rm -R /`. That GNU coreutils declines it is the whole of the
# current protection: busybox does not, and by then the container has been
# removed and both unit files deleted, so a refusal at that point is far from
# free. A relative path is the same mistake from the other end, resolved against
# whatever directory the operator was standing in.
#
# What install.sh can produce is an absolute path with a name on the end, so
# that is what is accepted.
if [ -n "$CHOSEN_PATH" ]; then
  case "$CHOSEN_PATH" in
    /*) ;;
    *)
      echo -e "$RED✗ Uninstallation Error:$NORMAL -d needs an absolute path, and \"$CHOSEN_PATH\" is relative."
      echo -e "$NORMAL It would be taken from the directory you are standing in."
      exit 1
      ;;
  esac

  # Trailing slashes are the operator's, not the path's - /opt/myspeed/ is the
  # installation. What is left after taking them off is what has to be a
  # directory somebody could have installed into.
  TRIMMED="$CHOSEN_PATH"
  while [ "${TRIMMED%/}" != "$TRIMMED" ]; do
    TRIMMED="${TRIMMED%/}"
  done

  case "$TRIMMED" in
    "" | */. | */.. | . | ..)
      echo -e "$RED✗ Uninstallation Error:$NORMAL \"$CHOSEN_PATH\" is not an installation directory."
      echo -e "$NORMAL Removing it would take the filesystem with it. Name the directory MySpeed is in."
      exit 1
      ;;
  esac

  CHOSEN_PATH="$TRIMMED"
fi

# Where the installation actually is, which is not always the default:
# install.sh takes -d and records the chosen path in the unit's
# WorkingDirectory. Read back here because the operator uninstalling months
# later need not be the one who chose it, and the system already knows.
#
# It has to happen before the systemd block below, which deletes the unit file -
# and with it the only record of where anything was put.
#
# Whether the answer came from the system or from a guess is remembered, because
# the end of this script cannot otherwise tell two identical-looking hosts apart:
# one whose installation is genuinely gone, and one whose installation is
# somewhere this run was never told to look. The unit's own WorkingDirectory is
# authoritative - an empty directory at that path means the files are gone. A -d,
# or the compiled-in default, is a guess, and a wrong guess is indistinguishable
# from an absence.
PATH_FROM_UNIT=0
RECORDED=""

# Read whatever the system recorded, always - including when -d was given. The
# unit is the only place the real path is written down, this script is about to
# delete it, and an operator's -d is worth corroborating: a -d that names exactly
# what the unit records is not a guess at all, and treating it as one reported a
# finished uninstall as an installation left on disk.
for unit in "${SERVICE_FILES[@]}"; do
  [ -f "$unit" ] || continue

  RECORDED="$(sed -n 's/^WorkingDirectory=//p' "$unit" | head -n 1)"
  [ -n "$RECORDED" ] && break
done

if [ -n "$CHOSEN_PATH" ]; then
  INSTALLATION_PATH="$CHOSEN_PATH"
  [ "$CHOSEN_PATH" = "$RECORDED" ] && PATH_FROM_UNIT=1
elif [ -n "$RECORDED" ]; then
  INSTALLATION_PATH="$RECORDED"
  PATH_FROM_UNIT=1
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
  echo -e "$YELLOW Found Docker container. Stopping the container..."
  docker stop MySpeed
  echo -e "$YELLOW Removing Docker container..."

  # Checked, and the flag set from the result rather than from having tried. A
  # container under a restart policy, one the daemon refuses, or a socket this
  # user cannot write all leave `docker rm` failing - and unchecked, that still
  # set REMOVED_CONTAINER and still reached the success banner, with the two
  # `clear` calls below wiping the daemon's error off the screen and out of the
  # scrollback. The operator was told MySpeed was uninstalled while it went on
  # serving on its published port.
  if ! docker rm MySpeed; then
    echo -e "$RED✗ Could not remove the Docker container.$NORMAL"
    echo -e "$NORMAL It is still there, and may still be running. Nothing else has been touched."
    exit 1
  fi

  REMOVED_CONTAINER=1

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
# What it records is not "there is a directory to remove" - that is asked
# directly, below - but "a native installation existed here", which is what makes
# an installation directory nobody could find worth reporting.
FOUND_SERVICE=0

# The whole unit name, not a substring of somebody else's.
#
# `grep -q "myspeed.service"` matches anywhere in the line, so an unrelated
# notmyspeed.service made this host look like it had a native MySpeed on it -
# and FOUND_SERVICE is what decides whether the myspeed account is deleted at the
# end of the run. The same defect the container name had, on the other half of
# the same decision. The `.` was a regex any-char into the bargain.
#
# -q, not -n: the condition wants an answer, and -n printed the matched line
# and its number into the middle of the uninstall output.
if command -v systemctl &> /dev/null \
    && systemctl --all --type service | grep -qE '(^|[[:space:]])myspeed\.service([[:space:]]|$)'; then
  FOUND_SERVICE=1

  systemctl stop myspeed
  systemctl disable myspeed
fi

# The unit files themselves, whether or not that list named them.
#
# Removing them used to be inside the branch above, so a host where systemd does
# not list the service - never reloaded after install.sh wrote the unit, the unit
# masked, or no systemctl at all - finished the uninstall with the unit still on
# disk, pointing at a directory this script had just deleted. The next
# daemon-reload brings that service back, and install.sh will not overwrite it,
# because the account it checks for is still there too.
#
# A unit file on disk is the same evidence the list is: a native installation was
# here. That is what FOUND_SERVICE records, so either sets it.
#
# Walked through the list that names them, guarded - the same list this script
# already walks to read the recorded path. Spelled out as two bare `rm`s, every
# ordinary uninstall printed "cannot remove ...: No such file or directory" for
# the path install.sh never creates, swallowed for want of `set -e`, directly
# beneath the success banner.
for unit in "${SERVICE_FILES[@]}"; do
  if [ -f "$unit" ]; then
    FOUND_SERVICE=1
    rm -f "$unit"
  fi
done

# Guarded on systemctl as well as on having found something, because this branch
# is now reachable on a host that has no systemd for the units to be reloaded
# into.
if [ "$FOUND_SERVICE" -eq 1 ] && command -v systemctl &> /dev/null; then
  systemctl daemon-reload
  systemctl reset-failed
fi

# Whether there was an installation to remove, read once and before anything is
# removed - every question after this point needs the answer, and by then the
# directory may be gone because this script took it.
INSTALLATION_FOUND=0
[ -d "$INSTALLATION_PATH" ] && INSTALLATION_FOUND=1

# A symlink is refused rather than followed.
#
# `[ -d ]` answers true for a link to a directory, and `rm -R` then removes the
# link and nothing else - so the installation survived in full while the script
# reported it gone, which is this file's worst failure mode wearing a different
# hat. Following it instead would be worse: the operator would be deleting
# whatever the link happens to point at, named by something this script cannot
# see.
if [ -L "$INSTALLATION_PATH" ]; then
  echo -e "$RED✗ $INSTALLATION_PATH is a symbolic link, not the installation.$NORMAL"
  echo -e "$NORMAL Removing it would delete the link and leave MySpeed on disk."
  echo -e "$NORMAL Re-run with$YELLOW -d$NORMAL naming the directory it points at."
  exit 1
fi

# And the installation itself.
#
# Entered where there is something at this path, and on a run that found no
# MySpeed anywhere - which has nothing to remove either, but does have something
# to say, and says it at the top of the block rather than reaching a banner.
#
# What is deliberately *not* entered is a host where the container or the service
# was already dealt with and there is nothing at this path. That is either an
# installation that is genuinely gone or one that is somewhere else, and `rm`
# cannot tell the difference - it can only fail, and a failure here would report
# a finished uninstall as a broken one. The block after this is where that
# difference is reported instead.
if [ "$INSTALLATION_FOUND" -eq 1 ] || { [ "$REMOVED_CONTAINER" -eq 0 ] && [ "$FOUND_SERVICE" -eq 0 ]; }; then
  clear
  echo -e "$BLUE🔎 Status:$NORMAL Removing MySpeed system data if present..."
  sleep 3

  # What has already happened, for the failures below to be honest about.
  #
  # Every message in this block once began "Nothing was removed" or "The service
  # has been stopped and removed", and by the time any of them can print, neither
  # is reliably true: the container, its volume, the compose directory, the
  # service and both unit files may all be gone already, or none of them may be.
  # A failure that misdescribes the state it failed in is what stops anyone going
  # to look.
  ALREADY_REMOVED=""
  [ "$REMOVED_CONTAINER" -eq 1 ] && ALREADY_REMOVED="The Docker container has been removed."
  if [ "$FOUND_SERVICE" -eq 1 ]; then
    if [ -n "$ALREADY_REMOVED" ]; then
      ALREADY_REMOVED="$ALREADY_REMOVED The service has been stopped and removed."
    else
      ALREADY_REMOVED="The service has been stopped and removed."
    fi
  fi
  [ -z "$ALREADY_REMOVED" ] && ALREADY_REMOVED="Nothing else was found to remove."

  # Nothing at that path, said rather than discovered by failing to remove it.
  #
  # This branch is reached only when nothing else was found either, so the run
  # has found no MySpeed anywhere. `rm -R` was doing the talking - it failed, and
  # the handler announced that the installation was "still on disk", which on a
  # host that has none is untrue and sends the operator looking for something
  # that is not there. What is worth saying is which path was looked at.
  if [ "$INSTALLATION_FOUND" -eq 0 ]; then
    echo -e "$RED✗ Found nothing to uninstall at $INSTALLATION_PATH.$NORMAL"
    echo -e "$NORMAL If MySpeed is installed elsewhere, re-run with$YELLOW -d /your/path$NORMAL."
    exit 1
  fi

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
    STAGING="$(mktemp -d)" || { echo -e "$RED✗ Could not create a staging directory.$NORMAL"; echo -e "$NORMAL $ALREADY_REMOVED The installation is untouched."; exit 1; }

    # Guarded, because the step after it is the one that cannot be undone. This
    # is a cross-filesystem copy in practice - /opt on disk, /tmp often tmpfs -
    # so a full /tmp fails here, and deleting the installation anyway would
    # destroy the data this flag exists to keep.
    if ! mv "$INSTALLATION_PATH/data" "$STAGING/data"; then
      echo -e "$RED✗ Could not move the data directory to safety.$NORMAL"
      echo -e "$NORMAL $ALREADY_REMOVED The installation at $INSTALLATION_PATH is untouched."
      rmdir "$STAGING" 2>/dev/null
      exit 1
    fi

    # From here the data is in the staging directory and nowhere else, so every
    # step is checked and every failure says where it is. Unchecked, a full disk
    # or a read-only mount left the database in a mktemp directory nobody was
    # told about, under the success banner.
    if ! rm -R "$INSTALLATION_PATH"; then
      echo -e "$RED✗ Could not remove $INSTALLATION_PATH.$NORMAL"
      echo -e "$NORMAL Your data is safe in$YELLOW $STAGING/data$NORMAL - move it back by hand."
      exit 1
    fi

    if ! mkdir "$INSTALLATION_PATH"; then
      echo -e "$RED✗ Could not recreate $INSTALLATION_PATH.$NORMAL"
      echo -e "$NORMAL Your data is safe in$YELLOW $STAGING/data$NORMAL - move it back by hand."
      exit 1
    fi


    # The mode is stated because mkdir applies the umask, and what reads it is
    # the *next* install: reachable_by_service walks this directory, and root on
    # a hardened host runs with 027 or 077, so the recreated directory came back
    # 0750 or 0700 and install.sh fell back to SERVICE_ACCOUNT="root". Keeping
    # the data is what makes reinstalling the easy path, so this flag was the
    # quiet way an installation lost its privilege separation. install.sh states
    # the same mode where it creates the directory itself.
    chmod 755 "$INSTALLATION_PATH"

    if ! mv "$STAGING/data" "$INSTALLATION_PATH/data"; then
      echo -e "$RED✗ Could not put the data directory back.$NORMAL"
      echo -e "$NORMAL It is safe in$YELLOW $STAGING/data$NORMAL - move it to $INSTALLATION_PATH/data by hand."
      exit 1
    fi

    rmdir "$STAGING"
  else
    # Checked, because this is the step that cannot be undone and it was the one
    # whose failure was discarded. There is no `set -e`, so a path that was
    # never there failed to stderr and the success banner printed anyway - which
    # is worse than the failure, because it is what stops anyone going to look.
    if ! rm -R "$INSTALLATION_PATH"; then
      echo -e "$RED✗ Could not remove $INSTALLATION_PATH.$NORMAL"
      echo -e "$NORMAL $ALREADY_REMOVED The installation is still on disk."

      # The recorded path, when there was one and it is not the path just tried.
      # The unit that held it has been deleted by now, so "re-run with -d" was
      # advice the operator had no way left to follow.
      if [ -n "$RECORDED" ] && [ "$RECORDED" != "$INSTALLATION_PATH" ]; then
        echo -e "$NORMAL The service recorded it at$YELLOW $RECORDED$NORMAL - re-run with$YELLOW -d $RECORDED$NORMAL."
      else
        echo -e "$NORMAL If it was installed elsewhere, re-run with$YELLOW -d /your/path$NORMAL."
      fi

      exit 1
    fi
  fi
fi

# There was reason to expect a native installation, and none was found.
#
# Two ways to have that reason: a service was here, or the operator named a path
# with -d. The second is what this missed - install.sh writes no unit on a host
# without systemctl, and a unit removed by hand leaves none either, so a wrong -d
# beside a container reached the success banner with the whole installation, its
# database and its password hash untouched on disk.
#
# Not when the path is corroborated. Read from the unit, or matching what the
# unit recorded, an empty directory is the system's own answer that the files are
# gone - and an uninstall that is over must not be reported as a problem.
#
# Ahead of the account removal below, because this exits: deleting the owner of a
# data directory the operator has just been told is still on disk is the state
# --keep-data exists to avoid, arrived at from the other side.
UNACCOUNTED=0
if [ "$INSTALLATION_FOUND" -eq 0 ] && [ "$PATH_FROM_UNIT" -eq 0 ]; then
  [ "$FOUND_SERVICE" -eq 1 ] && UNACCOUNTED=1
  [ -n "$CHOSEN_PATH" ] && UNACCOUNTED=1
fi

if [ "$UNACCOUNTED" -eq 1 ]; then
  echo -e "$RED✗ Found no installation at $INSTALLATION_PATH.$NORMAL"

  if [ -n "$RECORDED" ] && [ "$RECORDED" != "$INSTALLATION_PATH" ]; then
    echo -e "$NORMAL The service recorded it at$YELLOW $RECORDED$NORMAL."
    echo -e "$NORMAL Re-run with$YELLOW -d $RECORDED$NORMAL to remove it."
  else
    echo -e "$NORMAL MySpeed is installed somewhere else. Its data directory - the database and"
    echo -e "$NORMAL the admin password hash - is still on disk."
    echo -e "$NORMAL Re-run with$YELLOW -d /your/path$NORMAL to remove it."
  fi

  exit 1
fi

# The account install.sh creates, taken back out with the files it owned.
#
# Without this, an uninstall that removes the binary, the unit and the whole
# directory still reports "MySpeed has been uninstalled" while leaving a
# `myspeed` entry in /etc/passwd whose home directory is the path just deleted -
# and it survives every later uninstall too, because the installer only runs
# useradd when the account is missing.
#
# Asked of the installation as a whole rather than from inside the directory
# removal above. The account belongs to the service, not to the directory: a
# native install whose directory was already gone still has one, and the removal
# block does not run for it. The container creates no account on the host at all,
# so a docker-only uninstall must not go looking for one to delete.
#
# Not under --keep-data, and that is the whole reason this is a condition rather
# than a line: that flag exists to leave the database on disk for a later
# reinstall, and those files belong to this account. Delete it and they belong to
# a free uid, which the next account created on this host may be given. Data that
# is being kept keeps its owner.
#
# Guarded on every side, and never fatal: a system without userdel must not fail
# an uninstall over it, and an install that fell back to root created no account
# to remove.
SERVICE_USER="myspeed"

if [ "$FOUND_SERVICE" -eq 1 ] || [ "$INSTALLATION_FOUND" -eq 1 ]; then
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
