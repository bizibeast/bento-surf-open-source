import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INSTAGRAM_CONNECTION_SCOPES,
  instagramConnectionScopes,
  instagramPermissionFailureMessage,
  missingInstagramConnectionScopes,
} from "./social-connections.functions";

const connectionSource = readFileSync(
  resolve(process.cwd(), "src/lib/social-connections.functions.ts"),
  "utf8",
);

describe("Instagram connection scopes", () => {
  it("requests one full permission set for every Instagram connect intent", () => {
    const expected = [
      "instagram_business_basic",
      "instagram_business_manage_comments",
      "instagram_business_manage_messages",
      "instagram_business_manage_insights",
      "instagram_business_content_publish",
    ];
    expect(INSTAGRAM_CONNECTION_SCOPES).toEqual(expected);
    expect(instagramConnectionScopes("auto_dm")).toEqual(expected);
    expect(instagramConnectionScopes("scheduler")).toEqual(expected);
    expect(instagramConnectionScopes()).toEqual(expected);
  });

  it("detects permissions Meta did not actually grant", () => {
    expect(
      missingInstagramConnectionScopes(
        ["instagram_business_basic", "instagram_business_manage_comments"],
        instagramConnectionScopes(),
      ),
    ).toEqual([
      "instagram_business_manage_messages",
      "instagram_business_manage_insights",
      "instagram_business_content_publish",
    ]);
  });

  it("accepts a token only when every requested permission is present", () => {
    const requested = instagramConnectionScopes();
    expect(missingInstagramConnectionScopes(requested, requested)).toEqual([]);
  });

  it("gives one recovery path for incomplete Instagram permissions", () => {
    expect(instagramPermissionFailureMessage(instagramConnectionScopes())).toContain(
      "publishing, Auto-DM, and insights permissions",
    );
    expect(instagramPermissionFailureMessage(instagramConnectionScopes())).toContain(
      "Settings → Integrations",
    );
  });
});

describe("Instagram OAuth callback safety", () => {
  it("does not force a fresh Instagram password or two-factor challenge on every connect", () => {
    expect(connectionSource).not.toContain('url.searchParams.set("force_reauth"');
  });

  it("atomically consumes a state owned by the authenticated user before token exchange", () => {
    const consumeMatch = connectionSource.match(/\.from\("social_oauth_states"\)\s*\.delete\(\)/);
    const consumeStart = consumeMatch?.index ?? -1;
    const exchangeStart = connectionSource.indexOf(
      '"https://api.instagram.com/oauth/access_token"',
    );

    expect(consumeStart).toBeGreaterThan(-1);
    expect(exchangeStart).toBeGreaterThan(consumeStart);
    const consumeQuery = connectionSource.slice(consumeStart, exchangeStart);
    expect(consumeQuery).toContain('.eq("provider", "instagram")');
    expect(consumeQuery).toContain('.eq("user_id", context.userId)');
    expect(consumeQuery).toContain('.gt("expires_at", nowIso)');
    expect(consumeQuery).toContain(".maybeSingle()");
  });

  it("prevents one Instagram account from being attached to two Bento users", () => {
    expect(connectionSource).toContain('.eq("provider_user_id", accountId)');
    expect(connectionSource).toContain('.neq("user_id", context.userId)');
    expect(connectionSource).toContain(
      "This Instagram account is already connected to another Bento workspace.",
    );
    expect(connectionSource).toContain('if (error.code === "23505")');
  });

  it("verifies the scopes Meta granted before marking a connection healthy", () => {
    const grantedScopesRead = connectionSource.indexOf(
      "const grantedScopes = shortToken.permissions ?? []",
    );
    const healthyWrite = connectionSource.indexOf('connection_health: "healthy"');

    expect(grantedScopesRead).toBeGreaterThan(-1);
    expect(healthyWrite).toBeGreaterThan(grantedScopesRead);
    expect(connectionSource).not.toContain("/debug_token");
    expect(connectionSource).toContain("missingInstagramConnectionScopes");
    expect(connectionSource).toContain("scopes: grantedScopes");
  });

  it("stores the Instagram profile picture returned during connection", () => {
    expect(connectionSource).toContain("fetchInstagramAccountProfile(longToken.access_token)");
    expect(connectionSource).toContain("provider_avatar_url: providerAvatarUrl");
  });
});
