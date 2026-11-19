#!/usr/bin/env bash
# Runs on the deploy host; reached through `bash -se`, so this arrives on stdin.
#   1 deploy path   2 commit   3 node bin dir   4 addon.json path
#   5 language server path      6 pm2 name      7 judge pm2 name
#   8 judge config  9 health url  10 yarn version  11 artifact bundle (optional)
#
# Facts this script is written against (verified on the production host):
#   * PM2 app HGNUOJ runs packages/hydrooj/bin/hydrooj.js with an absolute
#     node binary and HOME=/opt/HGNUOJ-Hydro/home, so addon.json lives there.
#   * `yarn` on PATH is 1.22 (classic); the repo needs Yarn 4 via corepack.
#   * origin is https://github.com/... rewritten by git config insteadOf to a
#     mirror; refs/pull/*/merge is reachable there, but after a merge the commit
#     is already on master.
set -euo pipefail

deploy_path=${1:?deploy path}
deploy_sha=${2:?commit sha}
node_bin=${3:?node bin dir}
addon_path=${4:?addon.json path}
language_server_path=${5:?language server path}
pm2_name=${6:-HGNUOJ}
judge_pm2_name=${7:-}
judge_config=${8:-}
health_url=${9:-}
yarn_version=${10:-4.18.1}
asset_bundle=${11:-}

log() { printf '\n[deploy] %s\n' "$*"; }
die() { echo "[deploy] $*" >&2; exit 1; }

export PATH="$node_bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_ENABLE_AUTO_PIN=0
export YARN_ENABLE_IMMUTABLE_INSTALLS=true
# Hydro uses an in-memory database when CI is set; never leak that into pm2.
unset CI

printf '%s' "$deploy_sha" | grep -Eq '^[0-9a-f]{40}$' || die "bad commit id"
command -v git > /dev/null || die "git missing"
command -v node > /dev/null || die "node not found in $node_bin"

cd "$deploy_path"
test "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true \
  || die "$deploy_path is not a git checkout"

# A dirty tree means someone hot-fixed on the server; a hard reset would erase it.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no >&2
  die "tracked files modified in $deploy_path; commit or revert them first"
fi

previous=$(git rev-parse HEAD)
log "target $deploy_path: $previous -> $deploy_sha"

# After a merge the commit is on master; refs/pull/*/merge still exists for open
# or recently closed PRs and is the fallback.
if ! git cat-file -e "$deploy_sha^{commit}" 2> /dev/null; then
  git fetch --no-tags origin master || die "git fetch origin master failed"
fi
if ! git cat-file -e "$deploy_sha^{commit}" 2> /dev/null; then
  git fetch --no-tags origin '+refs/pull/*/head:refs/deploy/pr/*' \
    '+refs/pull/*/merge:refs/deploy/merge/*' || true
fi
git cat-file -e "$deploy_sha^{commit}" 2> /dev/null \
  || die "$deploy_sha is not reachable from origin"

# Skip reinstalling when no dependency file changed between the two commits.
deps_changed=true
if git cat-file -e "$previous^{commit}" 2> /dev/null; then
  if [ -z "$(git diff --name-only "$previous" "$deploy_sha" -- \
              ':(glob)**/package.json' 'yarn.lock' '.yarnrc.yml' '.yarn/patches/**')" ]; then
    deps_changed=false
  fi
fi

git reset --hard "$deploy_sha" > /dev/null
test "$(git rev-parse HEAD)" = "$deploy_sha" || die "HEAD diverged after reset"
git submodule sync --recursive > /dev/null
git submodule update --init --recursive

# ---- artifacts -------------------------------------------------------------
# Unpack into a staging dir first, then swap, so a truncated upload can never
# leave the live public/ half-populated.
if [ -n "$asset_bundle" ] && [ -f "$asset_bundle" ]; then
  log "unpacking $(basename "$asset_bundle")"
  rm -rf .deploy-stage
  mkdir -p .deploy-stage
  tar -xzf "$asset_bundle" -C .deploy-stage \
    || die "artifact archive is corrupt"
  [ -d .deploy-stage/packages/ui-default/public ] \
    || die "archive has no packages/ui-default/public"
  [ -d .deploy-stage/.cache/ts-out ] || die "archive has no .cache/ts-out"

  # public/: full replacement (stale hashed chunks must not survive).
  rm -rf packages/ui-default/public.old
  if [ -d packages/ui-default/public ]; then
    mv packages/ui-default/public packages/ui-default/public.old
  fi
  mv .deploy-stage/packages/ui-default/public packages/ui-default/public

  # .cache/ts-out: merged in place, tsc keeps its incremental graph.
  mkdir -p .cache
  cp -a .deploy-stage/.cache/ts-out .cache/

  # icon font is gitignored and generated; the checkout may not have it.
  if [ -d .deploy-stage/packages/ui-default/misc/.iconfont ]; then
    rm -rf packages/ui-default/misc/.iconfont
    mkdir -p packages/ui-default/misc
    mv .deploy-stage/packages/ui-default/misc/.iconfont packages/ui-default/misc/.iconfont
  fi

  # yarn.lock is gitignored, so git diff alone cannot see dependency drift.
  # Adopt the CI-generated lockfile and force an install when it differs.
  if [ -f .deploy-stage/yarn.lock ]; then
    if [ ! -f yarn.lock ] || ! cmp -s .deploy-stage/yarn.lock yarn.lock; then
      cp .deploy-stage/yarn.lock yarn.lock
      log "yarn.lock replaced by the CI-resolved one"
      deps_changed=true
    fi
  fi

  rm -rf .deploy-stage "$asset_bundle"
  log "artifacts installed"
else
  log "no uploaded artifacts, building from source on this host"
  deps_changed=true
fi

# ---- dependencies ----------------------------------------------------------
# `yarn` on PATH is 1.22 and cannot read workspace:^ ranges; pin Yarn 4 through
# corepack and call it explicitly so PATH order cannot pick the wrong one.
if [ "$deps_changed" = true ]; then
  log "dependencies changed, installing with yarn $yarn_version"
  if [ -x "$node_bin/corepack" ]; then
    mkdir -p "$node_bin"
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$node_bin/corepack" prepare "yarn@$yarn_version" --activate \
      || die "corepack could not prepare yarn@$yarn_version"
    # --install-directory needs the target dir to exist.
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$node_bin/corepack" enable --install-directory "$node_bin" \
      || die "corepack could not expose yarn"
  fi
  command -v yarn > /dev/null || die "yarn unavailable after corepack setup"
  yarn --version
  yarn install || die "yarn install failed"
else
  log "no dependency changes, skipping yarn install"
fi

# ---- addon.json ------------------------------------------------------------
# Rendered from the repo template: __DEPLOY_PATH__ and __LANGUAGE_SERVER__ are
# placeholders, because the live file uses absolute package paths.
addon_config=$(mktemp)
trap 'rm -f -- "$addon_config"' EXIT
node -e '
  const fs = require("node:fs");
  const [file, deployPath, languageServer, out] = process.argv.slice(1);
  const raw = fs.readFileSync(file, "utf8").split("\n")
    .filter((line) => !/^\s*#/.test(line)).join("\n");
  const configured = JSON.parse(raw).map((item) => item
    .replace("__DEPLOY_PATH__", deployPath)
    .replace("__LANGUAGE_SERVER__", languageServer));
  fs.writeFileSync(out, `${JSON.stringify(configured, null, 2)}\n`);
' .github/deploy/addon.json "$deploy_path" "$language_server_path" "$addon_config" \
  || die "could not render .github/deploy/addon.json"

# Compare semantically: the previous file has no trailing newline, and a byte
# comparison would rewrite it (and force an addon reload) on every deploy.
addon_same=false
if [ -f "$addon_path" ]; then
  node -e '
    const fs = require("node:fs");
    const [a, b] = process.argv.slice(1).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
    process.exit(JSON.stringify(a) === JSON.stringify(b) ? 0 : 1);
  ' "$addon_config" "$addon_path" && addon_same=true
fi

if [ "$addon_same" = true ]; then
  log "addon.json unchanged"
else
  mkdir -p "$(dirname "$addon_path")"
  cp "$addon_config" "$addon_path"
  log "addon.json updated"
fi

# ---- restart ---------------------------------------------------------------
# `pm2 restart` WITHOUT --update-env on purpose: --update-env would overwrite the
# app's HOME=/opt/HGNUOJ-Hydro/home with this session's HOME=/root, and Hydro
# would then read /root/.hydro instead of the live config.
command -v pm2 > /dev/null || die "pm2 not on PATH:$PATH"
pm2 restart "$pm2_name" || die "pm2 restart $pm2_name failed"
if [ -n "$judge_pm2_name" ]; then
  if [ -z "$judge_config" ] || [ -f "$judge_config" ]; then
    pm2 restart "$judge_pm2_name" || die "pm2 restart $judge_pm2_name failed"
  else
    echo "[deploy] $judge_config missing, $judge_pm2_name left running" >&2
  fi
fi

# ---- health check ----------------------------------------------------------
if [ -n "$health_url" ]; then
  attempt=0
  while [ $attempt -lt 15 ]; do
    attempt=$((attempt + 1))
    if curl -fsS --max-time 10 -o /dev/null "$health_url"; then
      rm -rf packages/ui-default/public.old
      log "health ok ($attempt/15)"
      exit 0
    fi
    sleep 4
  done
  echo "[deploy] health check failed: $health_url" >&2
  # Keep public.old for a manual rollback; do not delete evidence.
  pm2 logs "$pm2_name" --lines 30 --nostream >&2 || true
  exit 1
fi

rm -rf packages/ui-default/public.old
log done
