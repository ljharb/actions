set -e

. /home/runner/mynvm/nvm.sh

VERSION="${1:-default}"
COMMAND="${2:-npm test}"
BEFORE_INSTALL="${3-}"
CACHE_HIT="${4-}"
AFTER_INSTALL="${5-}"
SKIP_LS_CHECK="${6-}"
SKIP_INSTALL="${7-}"
INSTALL_COMMAND="${8-}"

echo '**** debug ****'
echo "* VERSION: $VERSION"
echo "* COMMAND: $COMMAND"
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
    ;;
esac

echo
echo
echo "******> nvm install-latest-npm"
nvm install-latest-npm

if [ -n "${BEFORE_INSTALL-}" ]; then
  echo
  echo
  echo "******> $BEFORE_INSTALL"
  eval $BEFORE_INSTALL
fi

if [ "${CACHE_HIT-}" != 'true' ] && [ "${SKIP_INSTALL-}" != 'true' ]; then
    export CI_RESET_NODE_VERSION=1
    case "${VERSION}" in
    0.5|0.5.*|0.6|0.6.*|0.7|0.7.*|0.9|0.9.*)
        echo
        echo
        echo "******> nvm install --latest-npm 0.8"
        nvm install --latest-npm 0.8
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
    npm "${INSTALL_COMMAND}"

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

echo
echo
echo "******> ${COMMAND}"
eval $COMMAND
