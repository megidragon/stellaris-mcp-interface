#!/bin/bash
# Install the AI Player mod to the Stellaris mod directory
# Run from the project root: bash scripts/install-mod.sh

STELLARIS_DOCS="$HOME/Documents/Paradox Interactive/Stellaris"
MOD_NAME="ai_player_mcp"
MOD_DIR="$STELLARIS_DOCS/mod/$MOD_NAME"
MOD_DESCRIPTOR="$STELLARIS_DOCS/mod/${MOD_NAME}.mod"
SOURCE_DIR="$(cd "$(dirname "$0")/../mod" && pwd)"

echo "Installing AI Player MCP mod..."
echo "Source: $SOURCE_DIR"
echo "Target: $MOD_DIR"

# Create mod directory
mkdir -p "$MOD_DIR"

# Copy mod files
cp -r "$SOURCE_DIR/"* "$MOD_DIR/"

# Create the .mod descriptor in the mod directory
cat > "$MOD_DESCRIPTOR" <<EOF
name="AI Player MCP Bridge"
path="$MOD_DIR"
tags={
	"Utilities"
}
supported_version="4.5.*"
EOF

echo ""
echo "Mod installed successfully!"
echo ""
echo "To activate:"
echo "1. Open the Stellaris launcher"
echo "2. Go to Mods > All available mods"
echo "3. Enable 'AI Player MCP Bridge'"
echo "4. Start a new game or load a save (non-ironman)"
echo ""
echo "The mod will write state data to: $STELLARIS_DOCS/logs/game.log"
echo "Look for lines starting with 'AI_' prefix"
