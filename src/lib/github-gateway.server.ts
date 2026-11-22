import { z } from "zod";
import { McpHttpClient } from "./mcp-http.server";
import { readResponseText } from "./request-security.server";
import { githubPullRequestSchema } from "./external-tools";

const endpoint = "https://api.githubcopilot.com/mcp/";
const accountSchema = z.object({ login: z.string().min(1).max(100) });
const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(512),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().optional(),
});
const textContent = z.array(z.object({ type: z.string(), text: z.string().optional() }));

function readTextObject(content: unknown) {
  return JSON.parse(textContent.parse(content).find((part) => part.type === "text")?.text ?? "");
}

export function createGithubGateway(
  credential: string,
  fetcher: typeof fetch = fetch,
  allowPullRequest = false,
) {
  if (!/^github_pat_[A-Za-z0-9_]+$/.test(credential)) {
    throw new Error("Use a fine-grained GitHub personal access token.");
  }
  const deadline = AbortSignal.timeout(10_000);
  const scopedFetch: typeof fetch = async (input, init) => {
    if (String(input) !== endpoint) throw new Error("Unexpected GitHub MCP endpoint.");
    const headers = new Headers(init?.headers);
    headers.set("X-MCP-Readonly", "true");
    headers.set("X-MCP-Toolsets", allowPullRequest ? "context,pull_requests" : "context");
    const response = await fetcher(endpoint, {
      ...init,
      headers,
      redirect: "error",
      signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return new Response(null, { status: response.status });
    }
    const body = await readResponseText(response, 256_000);
    return new Response(body || null, { status: response.status, headers: response.headers });
  };
  const client = new McpHttpClient({ endpoint, accessToken: credential, fetch: scopedFetch });

  async function discover() {
    try {
      const tools = await client.listTools();
      const accountTool = tools.find((tool) => tool?.name === "get_me");
      const schema = z
        .object({
          type: z.literal("object"),
          required: z.array(z.string()).optional(),
        })
        .safeParse(accountTool?.inputSchema);
      if (
        accountTool?.annotations?.readOnlyHint !== true ||
        !schema.success ||
        schema.data.required?.length
      ) {
        throw new Error();
      }
      const capabilities = ["get_me"];
      if (allowPullRequest) {
        const pull = tools.find((tool) => tool.name === "pull_request_read");
        const input = z
          .object({
            type: z.literal("object"),
            properties: z.record(z.string(), z.unknown()),
            required: z.array(z.string()).optional(),
          })
          .safeParse(pull?.inputSchema);
        const keys = ["owner", "repo", "pullNumber", "method"];
        if (
          !input.success ||
          pull?.annotations?.readOnlyHint !== true ||
          !keys.every((key) => Object.hasOwn(input.data.properties, key)) ||
          input.data.required?.some((key) => !keys.includes(key))
        )
          throw new Error();
        capabilities.push("pull_request_read");
      }
      return capabilities;
    } catch {
      throw new Error(
        "GitHub MCP did not expose a compatible read-only tool. Check your token and GitHub settings.",
      );
    }
  }

  return {
    discover,
    async account() {
      await discover();
      try {
        const result = await client.callTool("get_me", {});
        if (result.isError) throw new Error();
        const structured = accountSchema.safeParse(result.structuredContent);
        if (structured.success) return structured.data;
        return accountSchema.parse(readTextObject(result.content));
      } catch {
        throw new Error("GitHub could not return the connected account.");
      }
    },
    async pullRequest(value: z.input<typeof githubPullRequestSchema>) {
      if (!allowPullRequest) throw new Error("GitHub pull request reads are disabled.");
      const { repository, number } = githubPullRequestSchema.parse(value);
      const [owner, repo] = repository.split("/");
      await discover();
      try {
        const result = await client.callTool("pull_request_read", {
          method: "get",
          owner,
          repo,
          pullNumber: number,
        });
        if (result.isError) throw new Error();
        const structured = z
          .union([
            pullRequestSchema,
            z.object({ pull_request: pullRequestSchema }).transform((value) => value.pull_request),
          ])
          .safeParse(result.structuredContent);
        const parsed = structured.success
          ? structured.data
          : pullRequestSchema.parse(readTextObject(result.content));
        if (parsed.number !== number) throw new Error();
        return { ...parsed, url: `https://github.com/${repository}/pull/${number}` };
      } catch {
        throw new Error("GitHub could not return the approved pull request.");
      }
    },
  };
}
