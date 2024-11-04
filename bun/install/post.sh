#!/usr/bin/env bash

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
fi
