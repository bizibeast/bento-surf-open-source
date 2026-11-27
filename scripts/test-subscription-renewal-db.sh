#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
container="${BENTO_SUPABASE_DB_CONTAINER:-supabase_db_cloud-supabase-private}"
database="${BENTO_SUBSCRIPTION_TEST_DATABASE:?Set BENTO_SUBSCRIPTION_TEST_DATABASE to an isolated local database with current migrations applied}"
docker exec -i "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 < supabase/tests/subscription_renewal_order_fulfillment.sql
printf 'PASS: subscription renewal snapshot, inventory, identity, access and one-time SQL contracts\n'
