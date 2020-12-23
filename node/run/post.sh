set -ex

AFTER_SUCCESS="${1-}"

echo '**** debug ****'
echo "* AFTER_SUCCESS: $AFTER_SUCCESS"
echo '**** end debug ****'

if [ -n "${AFTER_SUCCESS}" ]; then
  echo
  echo
  echo "******> $AFTER_SUCCESS"
  eval $AFTER_SUCCESS
elif [ -f coverage/*.json ]; then
    echo
    echo
    echo "******> bash <(curl -s https://codecov.io/bash) -f coverage/*.json"
    bash <(curl -s https://codecov.io/bash) -f coverage/*.json;
fi
