#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
        manager=brew
        install_command='brew install node'
    elif command -v apt-get >/dev/null 2>&1; then
        manager=apt
        if [ "$(id -u)" -eq 0 ]; then
            install_command='apt-get update && apt-get install -y nodejs npm'
        else
            install_command='sudo apt-get update && sudo apt-get install -y nodejs npm'
        fi
    else
        printf '%s\n' '✗ Node.js missing. Install Node.js 18+ from https://nodejs.org, then rerun.' >&2
        exit 1
    fi
    printf '• Node.js missing. Install: %s\n' "$install_command"
    for argument do
        if [ "$argument" = '--dry-run' ]; then exit 1; fi
    done
    printf '• Install Node.js now? [y/N] '
    answer=
    read -r answer || true
    case "$answer" in
        y|Y|yes|YES)
            if [ "$manager" = brew ]; then
                brew install node
            elif [ "$(id -u)" -eq 0 ]; then
                apt-get update
                apt-get install -y nodejs npm
            else
                sudo apt-get update
                sudo apt-get install -y nodejs npm
            fi
            ;;
        *) exit 1 ;;
    esac
fi

script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
exec node "$script_dir/install.js" "$@"
