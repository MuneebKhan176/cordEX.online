#!/bin/sh

set -e

case "$ENGINE" in
    spot)
        echo "Starting CORDEX Spot Engine..."
        exec /app/spot-engine
        ;;

    futures)
        echo "Starting CORDEX Futures Engine..."
        exec /app/futures-engine
        ;;

    *)
        echo "ERROR: Invalid ENGINE value: $ENGINE"
        echo "Allowed values: spot or futures"
        exit 1
        ;;
esac