#!/usr/bin/env bash

set -e

#. $HOME/.nvm/nvm.sh
. $NVM_DIR/nvm.sh

VERSION="${1:-default}"
BEFORE_INSTALL="${2-}"
CACHE_HIT="${3-}"
AFTER_INSTALL="${4-}"
SKIP_LS_CHECK="${5-}"
SKIP_INSTALL="${6-}"
INSTALL_COMMAND="${7-}"
SKIP_LATEST_NPM="${8-}"

alias echo='\echo ::debug::'

echo '**** debug ****'
echo "* nvm: $(nvm -v)"
echo "* node: $(which node) ($(node -v))"
echo "* npm: $(which npm) ($(npm -v))"
echo "* npm root -g: $(npm root -g)"
echo "* NVM_DIR: $NVM_DIR"
echo "* PATH: $PATH"
echo "* VERSION: $VERSION"
echo "* BEFORE_INSTALL: $BEFORE_INSTALL"
echo "* CACHE_HIT: $CACHE_HIT"
echo "* AFTER_INSTALL: $AFTER_INSTALL"
echo "* SKIP_LS_CHECK: $SKIP_LS_CHECK"
echo "* SKIP_INSTALL: $SKIP_INSTALL"
echo "* INSTALL_COMMAND: $INSTALL_COMMAND"
echo "* SKIP_LATEST_NPM: $SKIP_LATEST_NPM"
echo '**** end debug ****'

case "${VERSION}" in
  *)
    echo
    echo
    if [ "${SKIP_LATEST_NPM-}" != 'true' ]; then
      echo "******> nvm install --latest-npm $VERSION"
      nvm install --latest-npm "${VERSION}"
    else
      echo "******> nvm install $VERSION"
      nvm install "${VERSION}"
    fi
  ;;
esac

echo
echo
echo "******> npm install -g bun"
npm install -g bun

echo '**** debug ****'
echo "* node: $(which node) ($(node -v))"
echo "* npm: $(which npm) ($(npm -v))"
echo "* bun: $(which bun) ($(bun -v))"
echo "* npm root -g: $(npm root -g)"
echo "* PATH: $PATH"
echo '**** end debug ****'

if [ -n "${BEFORE_INSTALL-}" ]; then
  echo
  echo
  echo "******> $BEFORE_INSTALL"
  eval $BEFORE_INSTALL
fi

if [ -z "${CACHE_HIT-}" ] && [ "${SKIP_INSTALL-}" != 'true' ]; then
    echo
    echo
    echo "******> bun ${INSTALL_COMMAND}"
    bun "${INSTALL_COMMAND}"
fi

if [ -n "${AFTER_INSTALL-}" ]; then
  echo
  echo
  echo "******> $AFTER_INSTALL"
  eval $AFTER_INSTALL
fi

if [ "${SKIP_LS_CHECK-}" != 'true' ]; then
  echo
  echo
  echo "******> npm ls"
  npm ls # >/dev/null
fi

echo "${NVM_BIN}" >> $GITHUB_PATH
