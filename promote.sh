#!/bin/bash
case $# in
    0 )
        echo "Usage: promote.sh stage/nm"
        exit;;
    * )
        :;;
esac
ENV=$1
git tag -m "Promoting to $ENV" release/${ENV}-$(date +%Y%m%d-%H%M)
git push --tags
