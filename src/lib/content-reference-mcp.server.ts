import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  contentReferenceInput,
  referenceDraftInput,
  referenceJobIdInput,
} from "./content-reference";
import type { ReferenceActor } from "./content-reference-analysis.server";

const result = (data: unknown, message?: string) => ({
  structuredContent: { result: data },
  content: [{ type: "text" as const, text: message || JSON.stringify(data) }],
});

export function registerContentReferenceMcpTools(
  server: Pick<McpServer, "registerTool">,
  actor: (workspaceId: string) => Promise<ReferenceActor>,
) {
  if (process.env.BENTO_V2_REFERENCE_ANALYSIS_ENABLED !== "true") return;
  server.registerTool(
    "analyze_content_reference",
    {
      title: "Study a content reference",
      description:
        "Start an analysis of a public Instagram Reel or carousel link or an owned video Media ID. Returns a job ID. Analysis uses downloaded media, a timestamped video overview, visual analysis and speech transcription where available, with warnings for missing evidence. Video decoding requires Creator+. Limits are 24 MB, 90 seconds or 3600 video frames, and 20 images. Reference footage is private analysis material.",
      inputSchema: contentReferenceInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      const { queueContentReference } = await import("./content-reference-jobs.server");
      const job = await queueContentReference(await actor(input.workspaceId), input);
      return result(
        job,
        `Reference ${job.id} is ${job.status}. Open References in Benny to follow progress and inspect the evidence.`,
      );
    },
  );
  server.registerTool(
    "create_video_frame_grid",
    {
      title: "Extract a video frame grid",
      description:
        "Create a private JPEG contact sheet from a public Instagram video or an owned video Media ID. All mode includes every decoded frame with timestamps and a separate frame-index JSON; overview mode samples frames. Limits are 90 seconds, 3600 frames and 24 MB. Requires Creator+ allowance. Returns a job ID and produces a private grid link.",
      inputSchema: contentReferenceInput.safeExtend({
        mode: z.enum(["overview", "all"]).default("all"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      const { queueContentReference } = await import("./content-reference-jobs.server");
      const job = await queueContentReference(await actor(input.workspaceId), input, true);
      return result(
        job,
        `Frame grid ${job.id} is ${job.status}. Open References in Benny to inspect it when ready.`,
      );
    },
  );
  server.registerTool(
    "get_content_reference",
    {
      title: "Read reference analysis",
      description:
        "List the workspace’s five most recent reference jobs when jobId is omitted, or read a job’s status and evidence by ID. Evidence can include ordered slide descriptions, transcript, warnings and private frame-grid links. Queued jobs have not been analyzed. Results and grids expire after seven days.",
      inputSchema: referenceJobIdInput.partial({ jobId: true }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, jobId }) => {
      const { readContentReference, listContentReferences } =
        await import("./content-reference-jobs.server");
      const owner = await actor(workspaceId);
      if (jobId) return result(await readContentReference(owner, jobId));
      const jobs = await listContentReferences(owner);
      return result({
        jobs: jobs.slice(0, 5).map((job) => ({
          id: job.id,
          status: job.status,
          sourceUrl: job.evidence?.sourceUrl,
          format: job.evidence?.format,
          warnings: job.evidence?.warnings,
          error: job.error,
        })),
      });
    },
  );
  server.registerTool(
    "create_content_from_reference",
    {
      title: "Create an editable reference-inspired draft",
      description:
        "Create and save an editable Studio project or reusable preset from a completed analysisId. A seed document supplies layout, style and brand and takes precedence over source colors and fonts. Presets contain editable placeholders; projects contain original copy. Missing evidence produces warnings. A saved aiProviderId and optional aiModel select a connected model; without aiProviderId, Brain is required. Creator+ can select a managed editing model. Returns the saved entry ID, revision and reviewPath. This tool does not render, schedule or publish.",
      inputSchema: referenceDraftInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      const { createReferenceDraft } = await import("./content-reference-draft.server");
      const saved = await createReferenceDraft(await actor(input.workspaceId), input);
      return result(
        saved,
        `Saved editable ${saved.entry.kind === "preset" ? "template" : "draft"} "${saved.entry.title}" (ID ${saved.entry.id}, revision ${saved.entry.revision}). Preview and revise it in Benny chat at ${saved.reviewPath}.${saved.warnings.length ? " Check the evidence warnings in References." : ""}`,
      );
    },
  );
}
