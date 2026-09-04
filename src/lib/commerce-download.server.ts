/* eslint-disable @typescript-eslint/no-explicit-any -- Commerce tables are introduced by the pending staging migration; remove after regenerating Supabase types. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { CommerceAsset } from "./commerce";
import {
  resolveBundleDeliveryProductIds,
  resolveBundleDigitalDeliveryFiles,
  resolveDigitalDeliveryFiles,
} from "./commerce-assets.server";
import { validateMediaObjectKey } from "./r2-storage.server";
import { commerceTokenHash, resolveCommerceGrantByToken } from "./commerce-access.server";

export const COMMERCE_DOWNLOAD_PATH = "/api/commerce/download/";

type CommerceDownloadDependencies = {
  db?: any;
  resolveGrant?: typeof resolveCommerceGrantByToken;
};

function safeDownloadName(value: unknown) {
  const cleaned = String(value || "download")
    .replace(/[\r\n"\\/]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || "download";
}

export async function handleCommerceDownloadRequest(
  request: Request,
  env: Pick<Env, "MEDIA_BUCKET" | "PUBLIC_API_RATE_LIMITER">,
  context?: Pick<ExecutionContext, "waitUntil">,
  dependencies: CommerceDownloadDependencies = {},
) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(COMMERCE_DOWNLOAD_PATH)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
  const parts = path.slice(COMMERCE_DOWNLOAD_PATH.length).split("/").filter(Boolean);
  if (parts.length !== 2) return new Response("Invalid download link", { status: 400 });
  const [token, assetId] = parts;
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token) || !/^[A-Za-z0-9_-]{1,100}$/.test(assetId)) {
    return new Response("Invalid download link", { status: 400 });
  }
  if (env.PUBLIC_API_RATE_LIMITER) {
    const limit = await env.PUBLIC_API_RATE_LIMITER.limit({
      key: `commerce-download:${await commerceTokenHash(token)}`,
    });
    if (!limit.success) {
      return new Response("Too many download attempts. Please wait and try again.", {
        status: 429,
        headers: { "retry-after": "60" },
      });
    }
  }

  const db = dependencies.db ?? (supabaseAdmin as any);
  let grant;
  try {
    grant = await (dependencies.resolveGrant ?? resolveCommerceGrantByToken)(
      db,
      token,
      "id, product_id, creator_id, status, expires_at, delivery_snapshot",
    );
  } catch {
    return new Response("Download could not be verified", { status: 503 });
  }
  if (!grant) {
    return new Response("This download link is no longer active", { status: 403 });
  }
  const { data: product, error: productError } = await db
    .from("commerce_products")
    .select("kind, settings")
    .eq("id", grant.product_id)
    .eq("creator_id", grant.creator_id)
    .single();
  if (productError || !product) return new Response("Product not found", { status: 404 });
  let file: CommerceAsset | undefined;
  let deliveredProductId = grant.product_id;
  if (product.kind === "digital_product") {
    file = resolveDigitalDeliveryFiles(grant.delivery_snapshot, product.settings).find(
      (candidate) => String(candidate?.id) === assetId,
    );
  } else if (product.kind === "bundle") {
    const bundledProductIds = resolveBundleDeliveryProductIds(
      grant.delivery_snapshot,
      product.settings,
    );
    const { data: bundledProducts, error: bundledProductsError } = bundledProductIds.length
      ? await db
          .from("commerce_products")
          .select("id, kind, settings")
          .eq("creator_id", grant.creator_id)
          .eq("kind", "digital_product")
          .in("id", bundledProductIds)
      : { data: [], error: null };
    if (bundledProductsError) {
      return new Response("Download could not be verified", { status: 503 });
    }
    for (const bundledProduct of bundledProducts ?? []) {
      file = resolveBundleDigitalDeliveryFiles(
        grant.delivery_snapshot,
        bundledProduct.id,
        bundledProduct.settings,
      ).find((candidate) => String(candidate?.id) === assetId);
      if (file) {
        deliveredProductId = bundledProduct.id;
        break;
      }
    }
  }
  const key = validateMediaObjectKey(String(file?.key || ""));
  const ownerPrefix = `private/users/${grant.creator_id}/store/`;
  if (!file || !key || !key.startsWith(ownerPrefix)) {
    return new Response("File not found", { status: 404 });
  }
  const object =
    request.method === "HEAD" ? await env.MEDIA_BUCKET.head(key) : await env.MEDIA_BUCKET.get(key);
  if (!object) {
    const recordMissing = async () => {
      try {
        const { error } = await db.from("commerce_download_events").insert({
          grant_id: grant.id,
          product_id: deliveredProductId,
          creator_id: grant.creator_id,
          asset_id: assetId,
          outcome: "missing",
          object_size: null,
        });
        if (error) console.error("[commerce-download] missing-file audit failed", error);
      } catch (error) {
        console.error("[commerce-download] missing-file audit failed", error);
      }
    };
    if (context) context.waitUntil(recordMissing());
    else await recordMissing();
    return new Response("File not found", { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-disposition", `attachment; filename="${safeDownloadName(file.name)}"`);
  headers.set("content-length", String(object.size));
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  const recordAccess = async () => {
    try {
      const [accessResult, auditResult] = await Promise.all([
        db
          .from("commerce_access_grants")
          .update({ last_accessed_at: new Date().toISOString() })
          .eq("id", grant.id),
        db.from("commerce_download_events").insert({
          grant_id: grant.id,
          product_id: deliveredProductId,
          creator_id: grant.creator_id,
          asset_id: assetId,
          outcome: request.method === "HEAD" ? "verified" : "downloaded",
          object_size: object.size,
        }),
      ]);
      if (accessResult.error)
        console.error("[commerce-download] access timestamp failed", accessResult.error);
      if (auditResult.error)
        console.error("[commerce-download] access audit failed", auditResult.error);
    } catch (error) {
      console.error("[commerce-download] access audit failed", error);
    }
  };
  if (context) context.waitUntil(recordAccess());
  else await recordAccess();
  return new Response(request.method === "HEAD" ? null : (object as R2ObjectBody).body, {
    headers,
  });
}
