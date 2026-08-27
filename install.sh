#!/usr/bin/env bash
# install.sh - One-Click Bash Installer for Intercom Global
set -e

echo -e "\033[1;36m============================================================\033[0m"
echo -e "\033[1;32m🚀 Installing Intercom Global (Multi-Agent Intercom & Auto-Wake)\033[0m"
echo -e "\033[1;36m============================================================\033[0m"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "\n\033[1;33m📦 Installing dependencies...\033[0m"
npm install

echo -e "\n\033[1;33m🔗 Linking global CLI commands...\033[0m"
npm link

chmod +x bin/intercom.js bin/intercom-wake.js bin/intercom-mcp.js

echo -e "\n\033[1;32m✅ Installation Complete!\033[0m"
echo -e "You can now run: \033[1;37mintercom --help\033[0m"
