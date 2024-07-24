#!/bin/bash

set -e

sed -i 's#DEPLOYED_IMG_ROOT\s*=\s*undefined#DEPLOYED_IMG_ROOT='"\"https://5etools.local/5etools-img/\""'#g' js/utils.js
