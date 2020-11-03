set -ex

if [ -f coverage/*.json ]; then bash <(curl -s https://codecov.io/bash) -f coverage/*.json; fi
