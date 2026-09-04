type CloudflareValidationRecord = {
  txt_name?: string;
  txt_value?: string;
  cname?: string;
  cname_target?: string;
};

export type CloudflareCustomHostname = {
  id: string;
  hostname: string;
  status?: string;
  ownership_verification?: { name?: string; type?: "txt"; value?: string };
  ssl?: {
    status?: string;
    validation_records?: CloudflareValidationRecord[];
    dcv_delegation_records?: CloudflareValidationRecord[];
  };
};

type CloudflareEnvelope<T> = {
  success: boolean;
  result?: T;
  errors?: Array<{ message?: string }>;
};

function config() {
  if (process.env.CUSTOM_DOMAINS_ENABLED === "false") {
    throw new Error("Custom domains are disabled in the test environment.");
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const cnameTarget = process.env.CLOUDFLARE_SAAS_TARGET;
  if (!token || !zoneId || !cnameTarget) {
    throw new Error("Custom domains are not configured on this deployment.");
  }
  return { token, zoneId, cnameTarget: cnameTarget.toLowerCase().replace(/\.$/, "") };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { token, zoneId } = config();
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/custom_hostnames${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init?.headers,
      },
    },
  );
  const payload = (await response.json()) as CloudflareEnvelope<T>;
  if (!response.ok || !payload.success || payload.result === undefined) {
    const detail = payload.errors
      ?.map((error) => error.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(detail || `Cloudflare request failed (${response.status}).`);
  }
  return payload.result;
}

export function getCustomDomainCnameTarget(): string {
  return config().cnameTarget;
}

export function createCloudflareHostname(hostname: string) {
  return request<CloudflareCustomHostname>("", {
    method: "POST",
    body: JSON.stringify({ hostname, ssl: { method: "http", type: "dv" } }),
  });
}

export function getCloudflareHostname(id: string) {
  return request<CloudflareCustomHostname>(`/${encodeURIComponent(id)}`);
}

export async function refreshCloudflareHostname(id: string) {
  await request<CloudflareCustomHostname>(`/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ ssl: { method: "http", type: "dv" } }),
  });
  return getCloudflareHostname(id);
}

export async function deleteCloudflareHostname(id: string): Promise<void> {
  try {
    await request<CloudflareCustomHostname>(`/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (error) {
    if (error instanceof Error && /not found|does not exist/i.test(error.message)) return;
    throw error;
  }
}
