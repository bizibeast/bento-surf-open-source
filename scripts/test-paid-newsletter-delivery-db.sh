#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
container="${BENTO_SUPABASE_DB_CONTAINER:?Set BENTO_SUPABASE_DB_CONTAINER to your local Supabase PostgreSQL container}"
database="${BENTO_NEWSLETTER_TEST_DATABASE:?Set BENTO_NEWSLETTER_TEST_DATABASE to an isolated local database with current migrations applied}"
# This shared contract deliberately tests hosted quota and downgrade rules.
# Keep its edition switch inside the same connection/transaction; the contract's
# rollback restores the public instance's self-hosted setting. A nested BEGIN
# warning is harmless. public_self_hosted_edition.sql tests the normal edition.
docker exec -i "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 \
  -c "begin; update public.bento_instance_settings set edition='hosted' where singleton;" \
  -f - < supabase/tests/paid_newsletter_purchase_delivery.sql
printf 'PASS: paid newsletter publication, scoped consent, preparation and send authorization contracts\n'
