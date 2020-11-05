set -e

. /home/runner/mynvm/nvm.sh

case "${1-:default}" in
    0.*) export NPM_CONFIG_STRICT_SSL=false ;;
esac

echo
echo
echo "******> nvm install-latest-npm"
nvm install-latest-npm

if [ "${3-}" != 'true' ]; then
    export CI_RESET_NODE_VERSION=1
    case "${1-:default}" in
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
    echo "******> npm install"
    npm install

    if [ "${CI_RESET_NODE_VERSION-}" = 1 ]; then
        echo
        echo
        echo "******> nvm use ${1-:default}"
        nvm use "${1-:default}"
    fi
fi

if [ -n "${4-}" ]; then
  echo
  echo
  echo "******> $4"
  eval $4
fi

echo
echo
echo "******> npm ls >/dev/null"
npm ls >/dev/null

echo
echo
echo "******> ${2:-npm test}"
eval ${2:-npm test}
