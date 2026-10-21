#!/usr/bin/env bash
set -euo pipefail

echo "==> Checking for Homebrew..."
if ! command -v brew >/dev/null 2>&1; then
  echo "Error: Homebrew is not installed."
  echo "Install it from https://brew.sh/"
  exit 1
fi

echo "==> Installing OpenJDK 17..."
brew install openjdk@17

echo "==> Registering Java with macOS..."
sudo ln -sfn "$(brew --prefix openjdk@17)/libexec/openjdk.jdk" \
  /Library/Java/JavaVirtualMachines/openjdk-17.jdk

echo "==> Configuring JAVA_HOME..."
SHELL_RC="$HOME/.zshrc"
JAVA_CONFIG='export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export PATH="$JAVA_HOME/bin:$PATH"'

touch "$SHELL_RC"

if ! grep -Fq 'export JAVA_HOME=$(/usr/libexec/java_home -v 17)' "$SHELL_RC"; then
  printf '\n# Java 17 for Maestro\n%s\n' "$JAVA_CONFIG" >> "$SHELL_RC"
fi

export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export PATH="$JAVA_HOME/bin:$PATH"

echo "==> Adding the Maestro Homebrew tap..."
brew tap mobile-dev-inc/tap

echo "==> Trusting the Maestro formula..."
brew trust --formula mobile-dev-inc/tap/maestro

echo "==> Installing Maestro CLI..."
brew install mobile-dev-inc/tap/maestro

echo "==> Installing AXe from source..."
AXE_SRC_DIR="${AXE_SRC_DIR:-$HOME/.local/src/AXe}"
if [ -d "$AXE_SRC_DIR/.git" ]; then
  git -C "$AXE_SRC_DIR" pull --ff-only
else
  mkdir -p "$(dirname "$AXE_SRC_DIR")"
  git clone https://github.com/KaloyanYosifov/AXe.git "$AXE_SRC_DIR"
fi
"$AXE_SRC_DIR/scripts/install-from-source.sh"

echo "==> Verifying installation..."
java -version
maestro --help
axe --help

echo
echo "Setup complete!"
echo "JAVA_HOME=$JAVA_HOME"
echo "Restart your terminal or run: source ~/.zshrc"
