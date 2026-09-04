import { describe, expect, it } from "vitest";
import migrationSql from "../../supabase/migrations/20260830143654_priority_dm_conversations.sql?raw";

const sql = migrationSql.toLowerCase();

function functionSql(name: string) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} must exist`).toBeGreaterThan(-1);
  if (start < 0) return "";
  const end = sql.indexOf("\n$$;", start);
  expect(end, `${name} must terminate`).toBeGreaterThan(start);
  return sql.slice(start, end + 4);
}

describe("Priority DM conversations migration", () => {
  it("keeps messages private and appends them atomically", () => {
    expect(sql).toContain("create table public.commerce_priority_dm_messages");
    expect(sql).toContain("order_id uuid unique");
    expect(sql).toContain(
      "alter table public.commerce_priority_dm_messages enable row level security",
    );
    expect(sql).toContain("grant select on public.commerce_priority_dm_messages to authenticated");
    expect(sql).toContain("grant all on public.commerce_priority_dm_messages to service_role");
    expect(sql).toContain(
      "revoke update (creator_reply, replied_at) on public.commerce_priority_dm_requests from authenticated",
    );
    expect(sql).toContain("auth.uid() = request.creator_id");
    expect(sql).toContain("if p_sender is null or p_sender not in");
    expect(sql).toContain("for update");
    expect(sql).toContain("free follow-up limit reached");
    expect(sql).toContain("paid follow-up amount does not match");
    expect(sql).toContain("on conflict (order_id) do nothing");
    expect(sql).toContain("commerce_intent");
    expect(sql).toContain("priority_dm_followup");
  });

  it("backfills both sides of legacy conversations", () => {
    expect(sql).toContain("request.message");
    expect(sql).toContain("request.creator_reply");
    expect(sql).toContain("where request.creator_reply is not null");
  });

  it("keeps legacy backfill outside missing-notification repair", () => {
    const backfill = sql.slice(
      sql.indexOf("insert into public.commerce_priority_dm_messages"),
      sql.indexOf("alter table public.commerce_priority_dm_requests\n  alter column"),
    );
    const repair = functionSql("list_missing_priority_dm_notifications");

    expect(backfill.match(/notification_eligible/g) ?? []).toHaveLength(2);
    expect(backfill.match(/\bfalse\b/g) ?? []).toHaveLength(2);
    expect(repair).toContain("message.notification_eligible");
  });

  it("keeps non-paid-follow-up messages behind initial-order eligibility", () => {
    expect(sql).toMatch(
      /select \*\s+into order_row\s+from public\.commerce_orders\s+where id = request_row\.order_id\s+for update;[\s\S]*?if order_row\.id is null\s+or order_row\.status not in \('paid', 'partially_refunded'\) then\s+raise exception 'priority dm purchase is no longer eligible for replies';/,
    );
  });

  it("commits a validated paid follow-up before mutable thread and initial-order guards", () => {
    const append = functionSql("append_priority_dm_message");
    const paidValidation = append.indexOf("paid follow-up order is not eligible");
    const paidInsert = append.indexOf(
      "insert into public.commerce_priority_dm_messages",
      paidValidation,
    );
    const paidIdempotency = append.indexOf("on conflict (order_id) do nothing", paidInsert);
    const initialOrderGuard = append.indexOf(
      "priority dm purchase is no longer eligible for replies",
    );
    const closedGuard = append.indexOf("priority dm conversation is closed");

    expect(paidInsert).toBeGreaterThan(paidValidation);
    expect(paidIdempotency).toBeGreaterThan(paidInsert);
    expect(paidIdempotency).toBeLessThan(initialOrderGuard);
    expect(paidIdempotency).toBeLessThan(closedGuard);
  });

  it("returns an order-linked retry only inside the same conversation before mutable guards", () => {
    const append = functionSql("append_priority_dm_message");
    const retryLookup = append.indexOf("if p_order_id is not null then");
    const paidBranch = append.indexOf("and p_order_id <> request_row.order_id then");
    const initialOrderGuard = append.indexOf(
      "priority dm purchase is no longer eligible for replies",
    );
    const closedGuard = append.indexOf("priority dm conversation is closed");
    const retryBlock = append.slice(retryLookup, paidBranch);

    expect(retryLookup).toBeGreaterThan(0);
    expect(retryBlock).toMatch(/where request_id = request_row\.id\s+and order_id = p_order_id/);
    expect(retryBlock).toContain("return to_jsonb(message_row)");
    expect(retryLookup).toBeLessThan(initialOrderGuard);
    expect(retryLookup).toBeLessThan(closedGuard);
  });

  it("preserves a closed thread while a paid follow-up fulfillment appends", () => {
    const append = functionSql("append_priority_dm_message");
    const paidBranch = append.slice(
      append.indexOf("and p_order_id <> request_row.order_id then"),
      append.indexOf(
        "select *\n  into order_row\n  from public.commerce_orders\n  where id = request_row.order_id",
      ),
    );

    expect(paidBranch).toContain(
      "status = case when request_row.status = 'closed' then 'closed' else 'unread' end",
    );
  });

  it("keeps the verified session name for provider-paid follow-ups", () => {
    const fulfill = functionSql("fulfill_provider_commerce_order");
    const orderInsert = fulfill.slice(fulfill.indexOf("insert into public.commerce_orders"));

    expect(orderInsert).toMatch(
      /case\s+when coalesce\(p_metadata->>'commerce_intent', ''\) = 'priority_dm_followup'\s+then nullif\(trim\(session_row\.buyer_name\), ''\)\s+else nullif\(trim\(p_buyer_name\), ''\)\s+end/,
    );
  });

  it("selects every missing message notification oldest first", () => {
    const repair = functionSql("list_missing_priority_dm_notifications");

    expect(repair).toContain("from public.commerce_priority_dm_messages message");
    expect(repair).toContain("not exists");
    expect(repair).toContain("from public.email_outbox outbox");
    expect(repair).toContain("'priority-dm-message:' || message.id::text");
    expect(repair).toContain("order by message.created_at asc, message.id asc");
    expect(repair).toContain("limit least(500, greatest(1, coalesce(p_limit, 200)))");
    expect(sql).toContain(
      "grant execute on function public.list_missing_priority_dm_notifications(integer) to service_role",
    );
  });

  it("validates mock follow-up money against the conversation snapshot", () => {
    const createOrder = functionSql("create_fulfilled_commerce_order");

    expect(createOrder).toContain("follow_up_request public.commerce_priority_dm_requests%rowtype");
    expect(createOrder).toContain("request.follow_up_price_amount = p_gross_amount");
    expect(createOrder).toContain("request.follow_up_currency = lower(trim(p_currency))");
    expect(createOrder).toMatch(
      /if is_priority_dm_followup then[\s\S]*?paid follow-up does not match conversation snapshot[\s\S]*?else[\s\S]*?if p_currency <> product\.currency then/,
    );
  });
});
