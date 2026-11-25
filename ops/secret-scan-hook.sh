#!/usr/bin/env bash
exec "$(git rev-parse --show-toplevel)/ops/secret-scan.sh" --staged
