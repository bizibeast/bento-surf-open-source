/* eslint-disable @typescript-eslint/no-explicit-any -- Content connection rows ship with migrations. */
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  ContentProviderAuthError,
  consumeContentOAuthState,
  type ContentConnection,
  type ContentProviderAdapter,
} from "./content-connections.server";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

function githubCredentials() {
  const appId = process.env.GITHUB_CONTENT_APP_ID?.trim() || "";
  const appSlug = process.env.GITHUB_CONTENT_APP_SLUG?.trim() || "";
  const privateKey = (process.env.GITHUB_CONTENT_APP_PRIVATE_KEY?.trim() || "").replace(
    /\\n/g,
    "\n",
  );
  if (!appId || !/^[0-9]+$/.test(appId) || !/^[a-z0-9-]+$/.test(appSlug) || !privateKey) {
    throw new Error("GitHub Content App is not configured.");
  }
  return { appId, appSlug, privateKey };
}

export function githubReady() {
  try {
    githubCredentials();
    return true;
  } catch {
    return false;
  }
}

export function githubAppInstallationUrl(state: string) {
  const { appSlug } = githubCredentials();
  const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function derLength(length: number) {
  if (length < 128) return new Uint8Array([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, value: Uint8Array) {
  return new Uint8Array([tag, ...derLength(value.length), ...value]);
}

function concat(...parts: Uint8Array[]) {
  const value = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    value.set(part, offset);
    offset += part.length;
  }
  return value;
}

function pemBytes(pem: string) {
  const body = pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, "");
  const binary = atob(body);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function pkcs8Bytes(pem: string) {
  const key = pemBytes(pem);
  if (pem.includes("BEGIN PRIVATE KEY")) return key;
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) throw new Error("Unsupported GitHub private key.");
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaAlgorithm = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  return der(0x30, concat(version, rsaAlgorithm, der(0x04, key)));
}

export async function createGitHubAppJwt(input?: {
  appId?: string;
  privateKey?: string;
  nowSeconds?: number;
}) {
  const configured = githubCredentials();
  const appId = input?.appId || configured.appId;
  const privateKey = input?.privateKey || configured.privateKey;
  const now = input?.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(
    new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8Bytes(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function githubRequest(
  token: string,
  path: string,
  fetcher: typeof fetch,
  init: RequestInit = {},
) {
  const response = await fetcher(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      "user-agent": "Bento-Content-Agent",
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new ContentProviderAuthError("GitHub authorization expired. Reconnect GitHub.");
  }
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}).`);
  return response.json() as Promise<unknown>;
}

export async function createGitHubInstallationToken(
  installationId: string,
  fetcher: typeof fetch = fetch,
) {
  const value = await githubRequest(
    await createGitHubAppJwt(),
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    fetcher,
    { method: "POST" },
  );
  return z.object({ token: z.string().min(1).max(10_000) }).parse(value).token;
}

async function githubInstallationInfo(installationId: string, fetcher: typeof fetch = fetch) {
  const value = await githubRequest(
    await createGitHubAppJwt(),
    `/app/installations/${encodeURIComponent(installationId)}`,
    fetcher,
  );
  const installation = z
    .object({
      account: z.object({
        id: z.number().int().positive(),
        login: z.string().min(1).max(160),
        type: z.string().min(1).max(80),
      }),
    })
    .parse(value);
  return {
    accountId: String(installation.account.id),
    displayName: installation.account.login,
    accountType: installation.account.type,
  };
}

type GitHubInstallationIdentity = {
  installationId: string;
  accountId: string;
  displayName: string;
  accountType: string;
};

async function saveGitHubConnection(userId: string, identity: GitHubInstallationIdentity) {
  const db = supabaseAdmin as any;
  const { data: existing } = await db
    .from("content_connections")
    .select("selected_resources,sync_cursor")
    .eq("user_id", userId)
    .eq("provider", "github")
    .eq("external_account_id", identity.installationId)
    .maybeSingle();
  const { error } = await db.from("content_connections").upsert(
    {
      user_id: userId,
      provider: "github",
      external_account_id: identity.installationId,
      display_name: identity.displayName,
      status: "active",
      scopes: ["metadata:read", "contents:read", "issues:read", "pull_requests:read"],
      selected_resources: existing?.selected_resources || { ids: ["all"] },
      access_token_ciphertext: null,
      refresh_token_ciphertext: null,
      token_expires_at: null,
      metadata: { accountId: identity.accountId, accountType: identity.accountType },
      sync_cursor: existing?.sync_cursor || null,
      last_error: null,
    },
    { onConflict: "user_id,provider,external_account_id" },
  );
  if (error) throw new Error("GitHub connection could not be saved.");
}

export async function completeGitHubConnectionForUser(
  userId: string,
  input: { installationId: string; state: string },
  dependencies: {
    consumeState: typeof consumeContentOAuthState;
    installationInfo: (installationId: string) => Promise<{
      accountId: string;
      displayName: string;
      accountType: string;
    }>;
    save: (userId: string, identity: GitHubInstallationIdentity) => Promise<unknown>;
  } = {
    consumeState: consumeContentOAuthState,
    installationInfo: githubInstallationInfo,
    save: saveGitHubConnection,
  },
) {
  const installationId = z
    .string()
    .regex(/^[0-9]{1,20}$/)
    .parse(input.installationId);
  const state = await dependencies.consumeState({ userId, provider: "github", state: input.state });
  if (!state) throw new Error("This GitHub connection expired. Start again.");
  const account = await dependencies.installationInfo(installationId);
  const identity = { installationId, ...account };
  await dependencies.save(userId, identity);
  return { installationId, displayName: account.displayName };
}

type GitHubRepository = { id: number; full_name: string; html_url: string };
const repositorySchema = z.object({
  id: z.number().int().positive(),
  full_name: z.string().min(3).max(300),
  html_url: z.string().url(),
});

async function installationRepositories(token: string, fetcher: typeof fetch) {
  const repositories: GitHubRepository[] = [];
  for (let page = 1; page <= 2; page += 1) {
    const value = await githubRequest(
      token,
      `/installation/repositories?per_page=100&page=${page}`,
      fetcher,
    );
    const rows = z
      .object({ repositories: z.array(repositorySchema).max(100) })
      .parse(value).repositories;
    repositories.push(...rows);
    if (rows.length < 100) break;
  }
  return repositories;
}

function selectedRepositoryIds(connection: ContentConnection, repositories: GitHubRepository[]) {
  const ids = z
    .object({ ids: z.array(z.string().trim().min(1).max(500)).max(100).default(["all"]) })
    .safeParse(connection.selectedResources);
  const selected = ids.success ? ids.data.ids : ["all"];
  if (selected.includes("all"))
    return new Set(repositories.map((repository) => String(repository.id)));
  return new Set(selected);
}

function repoPath(fullName: string) {
  const [owner, repository] = fullName.split("/");
  if (!owner || !repository) throw new Error("GitHub returned an invalid repository name.");
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

function text(value: unknown, maximum = 10_000) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

export function createGitHubAdapter(dependencies?: {
  fetch?: typeof fetch;
  installationToken?: (installationId: string) => Promise<string>;
  now?: () => Date;
}): ContentProviderAdapter {
  const fetcher = dependencies?.fetch || fetch;
  const installationToken =
    dependencies?.installationToken || ((id: string) => createGitHubInstallationToken(id, fetcher));
  const now = dependencies?.now || (() => new Date());
  return {
    provider: "github",
    async listResources(connection) {
      const token = await installationToken(connection.externalAccountId);
      const repositories = await installationRepositories(token, fetcher);
      return repositories.map((repository) => ({
        id: String(repository.id),
        name: repository.full_name,
        type: "repository",
      }));
    },
    async sync(connection) {
      const token = await installationToken(connection.externalAccountId);
      const repositories = await installationRepositories(token, fetcher);
      const selected = selectedRepositoryIds(connection, repositories);
      const records: unknown[] = [];
      for (const repository of repositories
        .filter((repo) => selected.has(String(repo.id)))
        .slice(0, 20)) {
        const path = repoPath(repository.full_name);
        const since = connection.syncCursor
          ? `&since=${encodeURIComponent(connection.syncCursor)}`
          : "";
        const [commitsValue, issuesValue, pullsValue] = await Promise.all([
          githubRequest(token, `/repos/${path}/commits?per_page=10${since}`, fetcher),
          githubRequest(
            token,
            `/repos/${path}/issues?state=all&sort=updated&direction=desc&per_page=20${since}`,
            fetcher,
          ),
          githubRequest(
            token,
            `/repos/${path}/pulls?state=all&sort=updated&direction=desc&per_page=10`,
            fetcher,
          ),
        ]);
        const commits = z.array(z.record(z.string(), z.unknown())).parse(commitsValue);
        for (const commit of commits) {
          const detail =
            commit.commit && typeof commit.commit === "object"
              ? (commit.commit as Record<string, unknown>)
              : {};
          const author =
            detail.author && typeof detail.author === "object"
              ? (detail.author as Record<string, unknown>)
              : {};
          const sha = text(commit.sha, 100);
          if (!sha) continue;
          records.push({
            provider: "github",
            externalItemId: `${repository.id}:commit:${sha}`,
            type: "commit",
            title: text(detail.message, 300).split("\n")[0] || "GitHub commit",
            text: text(detail.message),
            sourceUrl: text(commit.html_url, 2_000) || repository.html_url,
            occurredAt: text(author.date, 100) || null,
            metadata: { repository: repository.full_name },
          });
        }
        const issues = z.array(z.record(z.string(), z.unknown())).parse(issuesValue);
        for (const issue of issues.filter((item) => !item.pull_request).slice(0, 20)) {
          const number = String(issue.number || issue.id || "");
          if (!number) continue;
          records.push({
            provider: "github",
            externalItemId: `${repository.id}:issue:${number}`,
            type: "issue",
            title: text(issue.title, 300) || "GitHub issue",
            text: [text(issue.title, 300), text(issue.body)].filter(Boolean).join("\n"),
            sourceUrl: text(issue.html_url, 2_000) || repository.html_url,
            occurredAt: text(issue.updated_at, 100) || null,
            metadata: { repository: repository.full_name, number },
          });
        }
        const pulls = z.array(z.record(z.string(), z.unknown())).parse(pullsValue);
        for (const pull of pulls.slice(0, 10)) {
          const number = String(pull.number || pull.id || "");
          if (!number) continue;
          records.push({
            provider: "github",
            externalItemId: `${repository.id}:pull_request:${number}`,
            type: "pull_request",
            title: text(pull.title, 300) || "GitHub pull request",
            text: [text(pull.title, 300), text(pull.body)].filter(Boolean).join("\n"),
            sourceUrl: text(pull.html_url, 2_000) || repository.html_url,
            occurredAt: text(pull.updated_at, 100) || null,
            metadata: { repository: repository.full_name, number },
          });
        }
      }
      return { records, cursor: now().toISOString(), warnings: [] };
    },
  };
}
