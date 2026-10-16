#!/usr/bin/env bash
set -euo pipefail
# Local verification only. Applies the migration and fixture inside one transaction
# against an existing Bento Supabase schema, then rolls back schema and fixture.
cd "$(dirname "$0")/.."
python3 - <<'PY' | docker exec -i "${BENTO_SUPABASE_DB_CONTAINER:-supabase_db_cloud-supabase-private}" psql -U postgres -d postgres -v ON_ERROR_STOP=1
from pathlib import Path
migration = Path('supabase/migrations/20261012120000_content_agent_identity.sql').read_text()
assert migration.startswith('begin;') and migration.rstrip().endswith('commit;')
print('begin;')
fixture = Path('supabase/tests/content_agent_identity.sql').read_text()
legacy, checks = fixture.split('-- Migration boundary: the runner applies schema here, after legacy fixtures.')
print(legacy)
print(migration[len('begin;'):migration.rfind('commit;')])
print(checks)
print('rollback;')
PY
