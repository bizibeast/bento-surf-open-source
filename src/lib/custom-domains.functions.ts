import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Json } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPlan } from "@/lib/plan.server";
import { entitlementUpgradeMessage, planHasEntitlement } from "@/lib/plans";
import { isConfiguredInstanceHostname, normalizeHostname } from "@/lib/custom-domain";
import {
  createCloudflareHostname,
  deleteCloudflareHostname,
  getCloudflareHostname,
  getCustomDomainCnameTarget,
  refreshCloudflareHostname,
  type CloudflareCustomHostname,
} from "@/lib/cloudflare-custom-hostnames.server";
import { enforceRequestRateLimit } from "@/lib/request-security.server";

type DomainRow = {
  id: string;
  user_id: string;
  hostname: string;
  cloudflare_hostname_id: string | null;
  status: string;
  ssl_status: string;
  verification_records: Json;
  last_error: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

type DnsRecord = { type: "TXT" | "CNAME"; name: string; value: string };

function validationRecords(hostname: CloudflareCustomHostname): DnsRecord[] {
  const records: DnsRecord[] = [];
  const ownership = hostname.ownership_verification;
  if (ownership?.name && ownership.value) {
    records.push({ type: "TXT", name: ownership.name, value: ownership.value });
  }
  for (const record of [
    ...(hostname.ssl?.validation_records ?? []),
    ...(hostname.ssl?.dcv_delegation_records ?? []),
  ]) {
    if (record.txt_name && record.txt_value) {
      records.push({ type: "TXT", name: record.txt_name, value: record.txt_value });
    } else if (record.cname && record.cname_target) {
      records.push({ type: "CNAME", name: record.cname, value: record.cname_target });
    }
  }
  return records.filter(
    (record, index) =>
      records.findIndex(
        (candidate) =>
          candidate.type === record.type &&
          candidate.name === record.name &&
          candidate.value === record.value,
      ) === index,
  );
}

function view(row: DomainRow | null, cnameTarget: string) {
  if (!row) return { domain: null, cnameTarget };
  return {
    cnameTarget,
    domain: {
      id: row.id,
      hostname: row.hostname,
      status: row.status,
      sslStatus: row.ssl_status,
      ready: row.status === "active" && row.ssl_status === "active",
      verificationRecords: Array.isArray(row.verification_records)
        ? (row.verification_records as DnsRecord[])
        : [],
      lastError: row.last_error,
      lastCheckedAt: row.last_checked_at,
      createdAt: row.created_at,
    },
  };
}

async function updateFromCloudflare(row: DomainRow, remote: CloudflareCustomHostname) {
  const records = validationRecords(remote);
  const { data, error } = await supabaseAdmin
    .from("custom_domains")
    .update({
      cloudflare_hostname_id: remote.id,
      status: remote.status ?? "pending",
      ssl_status: remote.ssl?.status ?? "pending_validation",
      verification_records: records as Json,
      last_error: null,
      last_checked_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .select("*")
    .single();
  if (error) throw new Error(`Unable to save domain status: ${error.message}`);
  return data as DomainRow;
}

export const getMyCustomDomain = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("custom_domains")
      .select("*")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return view(data as DomainRow | null, getCustomDomainCnameTarget());
  });

export const connectCustomDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ hostname: z.string().min(1).max(300) }).parse(input))
  .handler(async ({ data, context }) => {
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "custom-domain-connect",
      context.userId,
    );
    if (!planHasEntitlement(await getPlan(context.userId), "customDomain")) {
      throw new Error(entitlementUpgradeMessage("customDomain"));
    }
    const hostname = normalizeHostname(data.hostname);
    const cnameTarget = getCustomDomainCnameTarget();
    if (hostname === cnameTarget || isConfiguredInstanceHostname(hostname, process.env)) {
      throw new Error("Use a domain you own, outside this instance's application hostnames.");
    }

    const { data: existing } = await supabaseAdmin
      .from("custom_domains")
      .select("*")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (existing) throw new Error("Remove your current domain before connecting another.");

    const { data: claimed } = await supabaseAdmin
      .from("custom_domains")
      .select("id")
      .eq("hostname", hostname)
      .maybeSingle();
    if (claimed) throw new Error("That domain is already connected to another account.");

    const { data: reserved, error: reserveError } = await supabaseAdmin
      .from("custom_domains")
      .insert({ user_id: context.userId, hostname })
      .select("*")
      .single();
    if (reserveError || !reserved) {
      if (reserveError?.code === "23505") throw new Error("That domain is already connected.");
      throw new Error("Unable to reserve that domain.");
    }

    let remote: CloudflareCustomHostname | null = null;
    try {
      remote = await createCloudflareHostname(hostname);
      const detail = await getCloudflareHostname(remote.id).catch(() => remote!);
      const saved = await updateFromCloudflare(reserved as DomainRow, detail);
      return view(saved, cnameTarget);
    } catch (error) {
      if (remote?.id) await deleteCloudflareHostname(remote.id).catch(() => undefined);
      await supabaseAdmin.from("custom_domains").delete().eq("id", reserved.id);
      throw new Error(error instanceof Error ? error.message : "Unable to connect that domain.");
    }
  });

export const refreshCustomDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "custom-domain-refresh",
      context.userId,
    );
    const { data: row, error } = await supabaseAdmin
      .from("custom_domains")
      .select("*")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error || !row) throw new Error("No custom domain is connected.");
    if (!row.cloudflare_hostname_id) throw new Error("This domain has not been provisioned yet.");
    try {
      const remote = await refreshCloudflareHostname(row.cloudflare_hostname_id);
      const saved = await updateFromCloudflare(row as DomainRow, remote);
      return view(saved, getCustomDomainCnameTarget());
    } catch (refreshError) {
      const message =
        refreshError instanceof Error ? refreshError.message : "Unable to check domain.";
      await supabaseAdmin
        .from("custom_domains")
        .update({ last_error: message, last_checked_at: new Date().toISOString() })
        .eq("id", row.id);
      throw new Error(message);
    }
  });

export const removeCustomDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "custom-domain-remove",
      context.userId,
    );
    const { data: row, error } = await supabaseAdmin
      .from("custom_domains")
      .select("*")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return { removed: true };
    if (row.cloudflare_hostname_id) await deleteCloudflareHostname(row.cloudflare_hostname_id);
    const { error: deleteError } = await supabaseAdmin
      .from("custom_domains")
      .delete()
      .eq("id", row.id)
      .eq("user_id", context.userId);
    if (deleteError) throw new Error("Unable to remove the domain.");
    return { removed: true };
  });
