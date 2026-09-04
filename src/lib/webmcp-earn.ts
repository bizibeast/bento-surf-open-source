import { submitReachReward } from "./referral.functions";
import { requireWebMcpUserConfirmation, webMcpResult, type WebMcpTool } from "./webmcp";

export function createEarnReachWebMcpTool(refresh: () => Promise<unknown>): WebMcpTool {
  return {
    name: "bento_submit_reach_reward",
    title: "Submit reach reward post",
    description:
      "Submits a published Instagram, Threads, LinkedIn, or X post for Earn verification after browser approval.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        postUrl: {
          type: "string",
          format: "uri",
          maxLength: 2_048,
          description: "Published social-post URL containing the creator's Bento referral link.",
        },
      },
      required: ["postUrl"],
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input, { signal }) => {
      signal.throwIfAborted();
      const postUrl = typeof input.postUrl === "string" ? input.postUrl : "";
      await requireWebMcpUserConfirmation("Submit reach reward post", { postUrl });
      signal.throwIfAborted();
      const submission = await submitReachReward({ data: { postUrl } });
      signal.throwIfAborted();
      await refresh();
      signal.throwIfAborted();
      return webMcpResult("Submitted the post for reach-reward verification.", {
        submission: { id: submission.id, status: submission.status },
      });
    },
  };
}
