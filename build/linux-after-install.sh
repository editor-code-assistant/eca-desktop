#!/bin/sh
# Ensure Chromium's SUID sandbox helper has the permissions Electron
# requires. Without this, launching the app fails with:
#
#   FATAL:setuid_sandbox_host.cc: The SUID sandbox helper binary was
#   found, but is not configured correctly.
#
# Some build/package pipelines don't preserve the setuid bit, so we
# fix it here unconditionally after install/upgrade.

set -e

SANDBOX=/opt/ECA/chrome-sandbox

if [ -e "$SANDBOX" ]; then
    chown root:root "$SANDBOX" || true
    chmod 4755 "$SANDBOX" || true
fi

exit 0
