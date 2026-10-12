#!/bin/sh
# Shed installer: curl -fsSL https://shed-sigma.vercel.app/install.sh | sh
# Installs Shed into ~/.shed/app, runs it (and its https tunnel) as two background services that start at login,
# then opens it in your browser. Run again to update. Uninstall: curl -fsSL …/install.sh | sh -s -- --uninstall
set -eu

SHED_HOME="${SHED_HOME:-$HOME/.shed}"
APP="$SHED_HOME/app"
REPO="${SHED_REPO:-https://github.com/IAmUnbounded/shed.git}"
REF="${SHED_REF:-main}"
PORT="${SHED_PORT:-4378}"
LABEL="${SHED_LABEL:-dev.shed}"
AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
say() { printf '  %s\n' "$1"; }
die() { printf '\033[31mShed: %s\033[0m\n' "$1" >&2; exit 1; }

stop_services() {
  for name in server tunnel; do
    launchctl bootout "$DOMAIN/$LABEL.$name" 2>/dev/null || true
    # bootout returns before the service is gone, and bootstrapping it again too soon fails.
    i=0
    while launchctl print "$DOMAIN/$LABEL.$name" >/dev/null 2>&1 && [ "$i" -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
  done
}

if [ "${1:-}" = "--uninstall" ]; then
  bold "Removing Shed"
  stop_services
  rm -f "$AGENTS/$LABEL.server.plist" "$AGENTS/$LABEL.tunnel.plist"
  say "Stopped the services. Your data is still in $APP/.jev-data."
  say "Delete $SHED_HOME to remove everything."
  exit 0
fi

bold "Installing Shed"
[ "$(uname -s)" = "Darwin" ] || die "Shed runs on macOS: it drives agent sessions in Terminal.app."

# Tools: git, Node 20+, cloudflared. Homebrew installs the missing ones when it is available.
need_brew() {
  command -v brew >/dev/null 2>&1 || die "$1 is missing. Install Homebrew (https://brew.sh) or $1, then run this again."
  say "Installing $1 with Homebrew…"
  brew install "$2" >/dev/null
}
command -v git >/dev/null 2>&1 || die "git is missing. Run: xcode-select --install"
if ! command -v node >/dev/null 2>&1; then need_brew "Node.js" node; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Shed needs Node 20 or newer (found $(node -v)). Update it with: brew upgrade node"
if ! command -v cloudflared >/dev/null 2>&1; then need_brew "cloudflared" cloudflared; fi
NODE="$(command -v node)"
CLOUDFLARED="$(command -v cloudflared)"

found=""
for agent in claude codex gemini opencode pi; do command -v "$agent" >/dev/null 2>&1 && found="$found $agent"; done
[ -n "$found" ] && say "Found agents:$found" || say "No coding agents found yet. Install Claude Code or Codex and Shed picks them up."

# The code: a shallow clone, updated in place on later runs (your settings live in the ignored .jev-data folder).
mkdir -p "$SHED_HOME"
if [ -d "$APP/.git" ]; then
  say "Updating ${APP}…"
  git -C "$APP" fetch --depth 1 origin "$REF" -q
  git -C "$APP" checkout -q -B "$REF" FETCH_HEAD
else
  say "Downloading Shed to ${APP}…"
  git clone -q --depth 1 --branch "$REF" "$REPO" "$APP"
fi
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)

stop_services
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "Port $PORT is in use. Stop whatever is using it, or install with SHED_PORT=4400."
fi

# Background services: the PATH from this shell, so Shed finds the same claude/codex you use.
mkdir -p "$AGENTS"
plist() {
  name="$1"; script="$2"
  cat > "$AGENTS/$LABEL.$name.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL.$name</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$APP/server/$script</string></array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$HOME/.local/bin:$PATH</string>
    <key>PORT</key><string>$PORT</string>
    <key>CLOUDFLARED</key><string>$CLOUDFLARED</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP/.jev-data/$name.log</string>
  <key>StandardErrorPath</key><string>$APP/.jev-data/$name.err.log</string>
</dict>
</plist>
PLIST
}
mkdir -p "$APP/.jev-data" && chmod 700 "$APP/.jev-data"
plist server index.js
plist tunnel tunnel.js
launchctl bootstrap "$DOMAIN" "$AGENTS/$LABEL.server.plist"
launchctl bootstrap "$DOMAIN" "$AGENTS/$LABEL.tunnel.plist"

say "Starting…"
i=0
until curl -fsS "http://127.0.0.1:$PORT/api/auth/status" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || die "Shed did not start. See $APP/.jev-data/server.err.log"
  sleep 1
done

bold "Shed is running at http://localhost:$PORT"
say "1. Set a password in the browser window that just opened."
say "2. Scan the QR code with your phone and add Shed to your Home Screen."
say "The first launch downloads the Laya routing model (about 1.7 GB) in the background."
say "macOS will ask once to let Shed control Terminal. Allow it, so agents run in windows you can watch."
[ "${SHED_NO_OPEN:-}" = "1" ] || open "http://localhost:$PORT"
