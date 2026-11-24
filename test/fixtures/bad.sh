#!/bin/sh
# Missing strict mode, unsafe delete, backticks.
dir=`mktemp -d`
rm -rf $dir
