set -e

. /home/runner/mynvm/nvm.sh

case "${1-:default}" in
    0.*) export NPM_CONFIG_STRICT_SSL=false ;;
esac

echo "\n\n******> nvm install-latest-npm"
nvm install-latest-npm

export CI_RESET_NODE_VERSION=1
case "${1-:default}" in
0.5|0.5.*|0.6|0.6.*|0.7|0.7.*|0.9|0.9.*)
    echo "\n\n******> nvm install --latest-npm 0.8"
    nvm install --latest-npm 0.8
;;
5.*|6.1|6.2)
    echo "\n\n******> nvm install --latest-npm 6"
    nvm install --latest-npm 6
;;
9.0|9.1|9.2)
    echo "\n\n******> nvm install --latest-npm 9"
    nvm install --latest-npm 9
;;
*)
    export CI_RESET_NODE_VERSION=0
;;
esac

echo "\n\n******> npm install"
npm install

if [ "${CI_RESET_NODE_VERSION-}" = 1 ]; then
    echo "\n\n******> nvm use ${1-:default}"
    nvm use "${1-:default}"
fi

echo "\n\n******> npm run ${2:-test}"
npm run "${2:-test}"
