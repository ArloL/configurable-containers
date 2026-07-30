#!/bin/sh
git clone https://github.com/mozilla/multi-account-containers mac
git clone https://github.com/GodKratos/temporary-containers tcp
git update-index --assume-unchanged ./mac/src/img/webicon-*
