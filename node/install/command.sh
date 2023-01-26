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
echo '**** end debug ****'

case "${VERSION}" in
    0.*)
      echo "******> export NPM_CONFIG_STRICT_SSL=false"
      export NPM_CONFIG_STRICT_SSL=false
      echo "******> export PYTHON=\`which python2\`"
      export PYTHON=`which python2`
    ;;
esac

case "${VERSION}" in
  0.1|0.1.*|0.2|0.2.*|0.3|0.3.*|0.4|0.4.*|0.5|0.5.*|0.6|0.6.*|0.7|0.7.*|0.8|0.8.*)
    echo
    echo
    echo "******> nvm install $VERSION"
    nvm install "${VERSION}"
    SKIP_LS_CHECK=true
  ;;
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

echo '**** debug ****'
echo "* node: $(which node) ($(node -v))"
echo "* npm: $(which npm) ($(npm -v))"
echo "* npm root -g: $(npm root -g)"
echo "* PATH: $PATH"
echo '**** end debug ****'

if [ -n "${BEFORE_INSTALL-}" ]; then
  echo
  echo
  echo "******> $BEFORE_INSTALL"
  eval $BEFORE_INSTALL
fi

if [ "${CACHE_HIT-}" != 'true' ] && [ "${SKIP_INSTALL-}" != 'true' ]; then
    export CI_RESET_NODE_VERSION=1
    case "${VERSION}" in
    0.5|0.5.*|0.6|0.6.*|0.7|0.7.*|0.8|0.8.*|0.9|0.9.*)
        echo
        echo
        echo "******> nvm install --latest-npm 0.10"
        nvm install --latest-npm 0.10
    ;;
    5.*|6.1|6.2)
        echo
        echo
        echo "******> nvm install --latest-npm 6"
        nvm install --latest-npm 6
    ;;
    9.0|9.1|9.2)
        echo
        echo
        echo "******> nvm install --latest-npm 9"
        nvm install --latest-npm 9
    ;;
    *)
        export CI_RESET_NODE_VERSION=0
    ;;
    esac

    echo
    echo
    echo "******> npm ${INSTALL_COMMAND}"
    npm "${INSTALL_COMMAND}" || {
      export CI_RESET_NODE_VERSION=1
      echo "******> nvm install --latest-npm node"
      nvm install --latest-npm node
      echo "******> npm ${INSTALL_COMMAND}"
      npm "${INSTALL_COMMAND}"
    }

    if [ "${CI_RESET_NODE_VERSION-}" = 1 ]; then
        echo
        echo
        echo "******> nvm use ${VERSION}"
        nvm use "${VERSION}"
    fi
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
  echo "******> npm ls >/dev/null"
  npm ls >/dev/null
fi

echo "${NVM_BIN}" >> $GITHUB_PATH
