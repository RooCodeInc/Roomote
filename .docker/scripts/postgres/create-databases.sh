#!/bin/bash

set -e
set -u

if [ -n "$POSTGRES_DATABASES" ]; then
  for db in $(echo $POSTGRES_DATABASES | tr ',' ' '); do
    if psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$db';" | grep -q 1; then
      echo "$db already exists"
    else
      echo "Creating $db..."
      createdb -U postgres "$db"
    fi
  done
fi
