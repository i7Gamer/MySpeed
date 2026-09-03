#!/usr/bin/env bash

GREEN='\033[0;32m'
BLUE='\033[1;34m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
NORMAL='\033[0;39m'

if [ $EUID -ne 0 ]; then
  echo -e "$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-"
  echo -e "$RED✗ ABORTED"
  echo -e "$NORMAL The installation is currently running via a user without root privileges. However, this is required. Please log in with a Root Account to continue."
  echo -e "$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-$RED-$NORMAL-"
  exit 1
fi

if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}Docker is not installed. Installing Docker...${NORMAL}"
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
fi

INSTALLATION_PATH="/opt/myspeed-dockerized"
mkdir -p "$INSTALLATION_PATH"

# Written once, never over an existing one.
#
# The redirect truncated whatever was there on every run, so a second run - the
# documented way to upgrade - threw away the operator's own edits: the
# `network_mode: host` the README tells Linux users to add to measure their real
# line speed, the environment the reverse-proxy section adds, a changed port
# binding. None of it is recoverable and nothing said it had gone.
if [ -f "$INSTALLATION_PATH/docker-compose.yml" ]; then
  echo -e "${BLUE}Keeping the existing docker-compose.yml.${NORMAL}"
else
  echo -e "${BLUE}Creating docker-compose.yml file...${NORMAL}"
  # The body and its terminator stay at column 0: this is << rather than <<-,
  # so an indented EOF would not end the document.
  cat << EOF > "$INSTALLATION_PATH/docker-compose.yml"
version: '3'
services:
  myspeed:
    image: i7gamer/myspeed
    ports:
      - "5216:5216"
    volumes:
      - myspeed:/myspeed/data
    restart: unless-stopped
    container_name: MySpeed
volumes:
  myspeed:
EOF
fi

# Pulled before it is started. `up -d` fetches an image only when there is none
# locally, and the reference carries no tag - so on a host that had run MySpeed
# before, a re-run recreated nothing, upgraded nothing, and printed that the
# container had started successfully. A pull that fails is reported and does not
# stop the start: an unreachable registry should not take down a container that
# is already running the image it has.
echo -e "${GREEN}Fetching the latest MySpeed image...${NORMAL}"
cd "$INSTALLATION_PATH" || exit 1
docker compose pull || echo -e "${YELLOW}Could not fetch a newer image; starting what is already here.${NORMAL}"

echo -e "${GREEN}Starting MySpeed Docker container...${NORMAL}"
docker compose up -d

if [ $? -eq 0 ]; then
    echo -e "${GREEN}MySpeed Docker container started successfully.${NORMAL}"
else
    echo -e "${RED}Error: Failed to start MySpeed Docker container.${NORMAL}"
    exit 1
fi