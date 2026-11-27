#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export BENTO_SUPABASE_DB_CONTAINER="${BENTO_SUPABASE_DB_CONTAINER:?Set BENTO_SUPABASE_DB_CONTAINER to your local Supabase PostgreSQL container}"
: "${BENTO_FREE_CLAIM_TEST_DATABASE:?Set BENTO_FREE_CLAIM_TEST_DATABASE to an isolated local database with current migrations}"
export BENTO_FREE_CLAIM_TEST_DATABASE

docker exec -i "$BENTO_SUPABASE_DB_CONTAINER" psql -X -U postgres -d "$BENTO_FREE_CLAIM_TEST_DATABASE" -v ON_ERROR_STOP=1 < supabase/tests/free_claim_identity_privacy.sql
python3 - <<'PY'
from concurrent.futures import ThreadPoolExecutor
import json
import os
import re
import subprocess
import uuid

database = os.environ['BENTO_FREE_CLAIM_TEST_DATABASE']
if not re.fullmatch(r'[A-Za-z0-9_]+_test', database):
    raise SystemExit('Concurrency fixtures require an explicitly isolated database ending in _test')
container = os.environ['BENTO_SUPABASE_DB_CONTAINER']
owner, product = str(uuid.uuid4()), str(uuid.uuid4())
email = f'free-concurrency-{owner}@example.com'
checkout = f'free_concurrency_{product}'

def sql(statement):
    result = subprocess.run(['docker', 'exec', '-i', container, 'psql', '-XqAt', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'], input=statement, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()

try:
    sql(f"""
      insert into auth.users(id,email) values('{owner}','free-owner-{owner}@example.com');
      insert into public.commerce_products(id,creator_id,kind,status,slug,public_slug,title,description,pricing_type,price_amount,currency,inventory_limit,settings)
      values('{product}','{owner}','paid_community','published','free-{product}','free-{product}','Free concurrency','Free community','free',0,'usd',1,'{{"welcomeMessage":"Welcome"}}');
    """)
    def claim(token):
        output = sql(f"""begin;
          select public.claim_free_commerce_offer('{product}','{email}','Buyer','{checkout}','{{}}',repeat('{token}',64));
          select pg_sleep(0.2);
          commit;
        """)
        return json.loads(next(line for line in output.splitlines() if line.startswith('{')))

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(claim, ['a', 'b']))
    assert sorted(result['created_new_order'] for result in results) == [False, True], results
    repeated = next(result for result in results if not result['created_new_order'])
    assert repeated == {'created_new_order': False}, repeated
    state = json.loads(sql(f"""select json_build_object(
      'orders',(select count(*) from public.commerce_orders where product_id='{product}'),
      'grants',(select count(*) from public.commerce_access_grants where product_id='{product}'),
      'capabilities',(select count(*) from public.commerce_customer_access_tokens token join public.commerce_access_grants grant_row on grant_row.id=token.grant_id where grant_row.product_id='{product}'),
      'seats',(select sales_count from public.commerce_products where id='{product}')
    );"""))
    assert state == {'orders': 1, 'grants': 1, 'capabilities': 0, 'seats': 1}, state
finally:
    sql(f"""delete from public.commerce_orders where product_id='{product}';
      delete from public.audience_contacts where customer_id in (select id from public.commerce_customers where email_normalized='{email}');
      delete from public.commerce_products where id='{product}';
      delete from public.profiles where id='{owner}';
      delete from auth.users where id='{owner}';
      delete from public.commerce_customers where email_normalized='{email}';""")
print('PASS: concurrent anonymous claims create one order, one seat, one grant and no recovery capability')
PY
