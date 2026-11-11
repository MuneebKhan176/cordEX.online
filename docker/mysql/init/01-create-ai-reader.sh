#!/bin/bash
set -Eeuo pipefail

# The MySQL image creates MYSQL_DATABASE and MYSQL_USER before running
# initialization scripts. This adds the separate, read-only account used
# by CORDEX's AI analytics service.

sql_quote() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\'/\'\'}"
    printf "'%s'" "$value"
}

: "${AI_DB_NAME:?AI_DB_NAME is required}"
: "${AI_DB_USER:?AI_DB_USER is required}"
: "${AI_DB_PASSWORD:?AI_DB_PASSWORD is required}"

if [[ ! "$AI_DB_NAME" =~ ^[A-Za-z0-9_]+$ ]]; then
    echo "AI_DB_NAME may contain only letters, digits, and underscores." >&2
    exit 1
fi

if [[ "${AI_DB_USER,,}" == "root" || "${AI_DB_USER,,}" == "admin" ]]; then
    echo "AI_DB_USER must be a dedicated, non-admin account." >&2
    exit 1
fi

AI_USER_SQL="$(sql_quote "$AI_DB_USER")"
AI_PASSWORD_SQL="$(sql_quote "$AI_DB_PASSWORD")"

mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE USER IF NOT EXISTS ${AI_USER_SQL}@'%';
ALTER USER ${AI_USER_SQL}@'%' IDENTIFIED BY ${AI_PASSWORD_SQL};
GRANT SELECT ON `${AI_DB_NAME}`.* TO ${AI_USER_SQL}@'%';
FLUSH PRIVILEGES;
SQL

echo "CORDEX AI read-only MySQL user provisioned."
