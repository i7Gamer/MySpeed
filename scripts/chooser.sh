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

# Fetched to a file and checked before it is run. Piped straight into bash
# from a curl with no --fail, an HTTP error body - a release with no such
# asset, GitHub answering 5xx - was handed to bash as a program, as root,
# and reported as a page of syntax errors rather than as the download it was.
run_installer() {
    local name="$1"
    local url="https://github.com/i7Gamer/MySpeed/releases/latest/download/$name"
    local script
    script="$(mktemp)" || exit 1

    if ! curl -fsSL -o "$script" "$url"; then
        echo -e "${RED}Could not download $url - the release may not carry $name, or GitHub is not answering.${NORMAL}"
        rm -f "$script"
        exit 1
    fi

    bash "$script"
    local status=$?
    rm -f "$script"
    return $status
}

echo -e "${GREEN}---------${BLUE} MySpeed Installation ${GREEN}---------${NORMAL}"
echo -e "${BLUE}Welcome to MySpeed Installation Script!${NORMAL}"
echo -e "${YELLOW}Do you want to install MySpeed with Docker or the normal installation script?${NORMAL}"
echo -e "${YELLOW}[1]${NORMAL} Docker (Recommended)"
echo -e "${YELLOW}[2]${NORMAL} Normal Install Script"

read -p "Enter your choice (1/2): " choice

case $choice in
    1)
        echo -e "${BLUE}Running Docker installation script...${NORMAL}"
        run_installer docker-install.sh
        ;;
    2)
        echo -e "${BLUE}Running normal installation script...${NORMAL}"
        run_installer install.sh
        ;;
    *)
        echo -e "${RED}Invalid choice. Exiting.${NORMAL}"
        exit 1
        ;;
esac