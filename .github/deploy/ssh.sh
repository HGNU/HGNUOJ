#!/usr/bin/env bash
# Runs on the GitHub runner.
#
# Auth: IP + port + a key file protected by a PASSPHRASE (this host has no login
# password). A passphrase-protected key never raises a keyboard-interactive
# prompt, so `sshpass -f` (login-password mode) cannot help. Supported paths,
# probed in order:
#   1. SSH_ASKPASS + SSH_ASKPASS_REQUIRE=force: ssh reads the passphrase from a
#      helper script. Needs no tty, so stdin stays free for server.sh.
#   2. sshpass -P passphrase (sshpass >= 1.10).
# Whichever authenticates is used for every remaining hop.
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

for name in DEPLOY_HOST DEPLOY_USER DEPLOY_PORT DEPLOY_PATH DEPLOY_NODE_BIN \
  DEPLOY_ADDON_PATH DEPLOY_LANGUAGE_SERVER_PATH DEPLOY_KNOWN_HOSTS DEPLOY_SHA; do
  if [[ -z "${!name:-}" ]]; then
    echo "::error::Missing $name"
    exit 1
  fi
done
[[ "$DEPLOY_PORT" =~ ^[0-9]+$ ]] || { echo "::error::DEPLOY_PORT must be numeric"; exit 1; }
[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::DEPLOY_SHA must be a full commit id"; exit 1; }
[[ -n "${DEPLOY_SSH_KEY:-}" ]] || { echo "::error::Set DEPLOY_SSH_KEY (private key contents)"; exit 1; }

work=$(mktemp -d)
umask 077
trap 'rm -rf -- "$work"' EXIT

printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$work/known_hosts"
# Verbatim: an encrypted PEM/PKCS#8 key must keep its headers and line breaks.
printf '%s\n' "$DEPLOY_SSH_KEY" > "$work/key"
chmod 600 "$work/key"

# Catch the two paste mistakes before touching the network.
if grep -qE '^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp[0-9]+) ' "$work/key"; then
  echo "::error::DEPLOY_SSH_KEY is a PUBLIC key; paste the private key file instead"
  exit 1
fi
grep -q -- '-----BEGIN' "$work/key" \
  || { echo "::error::DEPLOY_SSH_KEY is not private key material"; exit 1; }

key_encrypted=false
if grep -q 'Proc-Type:.*ENCRYPTED' "$work/key" \
  || grep -q -- '-----BEGIN ENCRYPTED PRIVATE KEY-----' "$work/key"; then
  key_encrypted=true
fi
if [[ "$key_encrypted" == true && -z "${DEPLOY_SSH_PASSPHRASE:-}" ]]; then
  echo "::error::the key is encrypted; also set DEPLOY_SSH_PASSPHRASE"
  exit 1
fi

opts=(
  -p "$DEPLOY_PORT"
  -o IdentitiesOnly=yes
  -i "$work/key"
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$work/known_hosts"
  -o ConnectTimeout=20
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=6
  -o NumberOfPasswordPrompts=1
)

target="$DEPLOY_USER@$DEPLOY_HOST"

# ---- askpass helper --------------------------------------------------------
if [[ -n "${DEPLOY_SSH_PASSPHRASE:-}" ]]; then
  printf '%s' "$DEPLOY_SSH_PASSPHRASE" > "$work/keypass"
  chmod 600 "$work/keypass"
  cat > "$work/askpass.sh" <<EOF
#!/bin/sh
cat "$work/keypass"
EOF
  chmod 700 "$work/askpass.sh"
fi

# Transport wrappers. They deliberately do NOT touch stdin: the callers redirect
# the payload into them, so an inner `</dev/null` would swallow it.
ssh_askpass() {
  SSH_ASKPASS="$work/askpass.sh" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
    ssh -T "${opts[@]}" -o BatchMode=no "$@"
}
ssh_sshpass() {
  sshpass -P passphrase -f "$work/keypass" \
    ssh -T "${opts[@]}" -o BatchMode=yes "$@"
}
ssh_plain() {
  ssh -T "${opts[@]}" -o BatchMode=yes "$@"
}

# ---- pick the first mechanism that authenticates ---------------------------
# A one-shot `true` probes auth without consuming any payload.
candidates=()
[[ -n "${DEPLOY_SSH_PASSPHRASE:-}" ]] && candidates+=(askpass)
if [[ -n "${DEPLOY_SSH_PASSPHRASE:-}" ]] && command -v sshpass > /dev/null; then
  sshpass -P passphrase -f "$work/keypass" true > /dev/null 2>&1 && candidates+=(sshpass)
fi
[[ -z "${DEPLOY_SSH_PASSPHRASE:-}" ]] && candidates+=(plain)

method=""
for candidate in "${candidates[@]}"; do
  if "ssh_$candidate" "$target" true > /dev/null 2>&1 < /dev/null; then
    method=$candidate
    break
  fi
  echo "::warning::auth method '$candidate' failed, trying the next one"
done

if [[ -z "$method" ]]; then
  echo "::error::no SSH auth method succeeded; test the key manually first"
  # Surface the real reason once instead of only ::error.
  last=${candidates[${#candidates[@]}-1]}
  "ssh_$last" "$target" true < /dev/null || true
  exit 1
fi
echo "[deploy] auth method: $method"

# ---- 1. compiled artifacts -------------------------------------------------
# The build job already compiled this exact commit, so ship the output rather
# than rebuilding on the production host.
asset_bundle=""
if [[ -d .cache/ts-out && -d packages/ui-default/public ]]; then
  remote_bundle="/var/tmp/hgnuoj-$DEPLOY_SHA.tgz"
  # yarn.lock is gitignored in this repo, so CI resolves its own tree. Ship it
  # with the artifacts: the host must install the SAME versions the frontend was
  # built against, otherwise bundle/runtime drift shows up as runtime errors.
  artifacts=(./.cache/ts-out ./packages/ui-default/public)
  [[ -d packages/ui-default/misc/.iconfont ]] \
    && artifacts+=(./packages/ui-default/misc/.iconfont)
  [[ -f yarn.lock ]] && artifacts+=(./yarn.lock)
  tar -czf "$work/assets.tgz" "${artifacts[@]}"
  echo "[deploy] uploading $(du -h "$work/assets.tgz" | cut -f1) of build artifacts"
  # -T keeps the byte stream clean; the archive arrives on stdin.
  "ssh_$method" "$target" "umask 077; cat > $(printf '%q' "$remote_bundle")" \
    < "$work/assets.tgz"
  asset_bundle=$remote_bundle
else
  echo "::warning::no local build artifacts, the server will compile from source"
fi

# ---- 2. arguments ----------------------------------------------------------
# %q-encodes each value: the remote login shell is not necessarily bash.
printf -v remote_args ' %q' \
  "$DEPLOY_PATH" "$DEPLOY_SHA" "$DEPLOY_NODE_BIN" "$DEPLOY_ADDON_PATH" \
  "$DEPLOY_LANGUAGE_SERVER_PATH" "${DEPLOY_PM2_NAME:-HGNUOJ}" \
  "${DEPLOY_JUDGE_PM2_NAME:-}" "${DEPLOY_JUDGE_CONFIG:-}" \
  "${DEPLOY_HEALTH_URL:-}" "${YARN_VERSION:-4.18.1}" "$asset_bundle"

# ---- 3. deploy -------------------------------------------------------------
"ssh_$method" "$target" "bash -se --$remote_args" < "$script_dir/server.sh"
