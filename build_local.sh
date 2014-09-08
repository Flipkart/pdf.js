#!/bin/bash -e
export LOCAL_DIR=$(pwd)
export PACKAGE=fk-digital-pdfjs
export TARGET="local"
export INSTALL_BASE="${LOCAL_DIR}"
./make-$PACKAGE-deb
