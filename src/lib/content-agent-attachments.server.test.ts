import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  head: vi.fn(),
  get: vi.fn(),
  media: vi.fn(),
  budget: vi.fn(),
  pdf: vi.fn(),
  register: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc, from: mocks.from },
}));
vi.mock("./r2-storage.server", () => ({
  getMediaBucket: () => ({ head: mocks.head, get: mocks.get }),
  mediaObjectUrl: (key: string) => `https://media.example/${key}`,
  validateMediaObjectKey: (key: string) => !key.includes("..") && !key.includes("%"),
}));
vi.mock("./mcp.content-ops.server", () => ({ manageMcpContentMedia: mocks.media }));
vi.mock("./provider-budget.server", () => ({ reserveProviderUsage: mocks.budget }));
vi.mock("./ai-json.server", () => ({ decodeAiJsonResponse: (v: any) => v }));
vi.mock("unpdf", () => ({ getDocumentProxy: mocks.pdf }));
vi.mock("./content-agent-media.server", () => ({ registerAgentMedia: mocks.register }));
import {
  extractAgentDocument,
  loadAgentAttachments,
  prepareAgentAttachmentForUser,
} from "./content-agent-attachments.server";
import { agentAttachmentKind } from "./content-agent-attachments";
const id = "00000000-0000-4000-8000-000000000001";
const key = `private/users/${id}/agent/brief.txt`;
const row = {
  id,
  user_id: id,
  storage_key: key,
  name: "brief.txt",
  mime_type: "text/plain",
  byte_size: 5,
  etag: "v1",
  status: "ready",
  media_id: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.head.mockResolvedValue({
    size: 5,
    etag: "v1",
    httpMetadata: { contentType: "text/plain" },
  });
});
it("accepts bounded references and rejects unsupported files", () => {
  expect(agentAttachmentKind({ name: "brief.pdf", type: "application/pdf", size: 100 })).toBe(
    "agent_file",
  );
  expect(() =>
    agentAttachmentKind({ name: "large.pdf", type: "application/pdf", size: 9 * 1024 * 1024 }),
  ).toThrow("8 MB");
  expect(() => agentAttachmentKind({ name: "run.html", type: "text/html", size: 5 })).toThrow();
});
it("limits extracted text and rejects binary data", async () => {
  expect(
    (
      await extractAgentDocument(
        new TextEncoder().encode("a".repeat(21000)),
        "text/plain",
        "brief.txt",
      )
    ).text.length,
  ).toBe(20000);
  await expect(
    extractAgentDocument(new Uint8Array([0, 1]), "text/plain", "binary.txt"),
  ).rejects.toThrow("UTF-8");
});
it("reads a bounded number of PDF pages and always destroys its task", async () => {
  const destroy = vi.fn(),
    getPage = vi.fn().mockResolvedValue({
      getTextContent: async () => ({ items: [{ str: "Reference text" }] }),
      cleanup: vi.fn(),
    });
  mocks.pdf.mockResolvedValue({ numPages: 40, getPage, loadingTask: { destroy } });
  const result = await extractAgentDocument(new Uint8Array([1]), "application/pdf", "brief.pdf");
  expect(getPage).toHaveBeenCalledTimes(30);
  expect(destroy).toHaveBeenCalledOnce();
  expect(result.note).toContain("30 pages");
});
it("does not access storage or providers for another workspace's file", async () => {
  await expect(
    prepareAgentAttachmentForUser(id, { key: "users/another/image/x.jpg", name: "x.jpg" }),
  ).rejects.toThrow("another workspace");
  expect(mocks.head).not.toHaveBeenCalled();
  expect(mocks.budget).not.toHaveBeenCalled();
});
it("reuses ready cached references and rejects changed or still-processing files", async () => {
  mocks.rpc.mockResolvedValue({ data: { claimed: false, attachment: row } });
  const cached = await prepareAgentAttachmentForUser(id, { key, name: "brief.txt" });
  expect(cached.url).toBeNull();
  expect(mocks.get).not.toHaveBeenCalled();
  mocks.head.mockResolvedValue({
    size: 5,
    etag: "v2",
    httpMetadata: { contentType: "text/plain" },
  });
  await expect(prepareAgentAttachmentForUser(id, { key, name: "brief.txt" })).rejects.toThrow(
    "changed",
  );
});
it("rejects missing references instead of using unowned or deleted content", async () => {
  const q: any = {
    select: () => q,
    eq: () => q,
    in: () => q,
    then: (resolve: any) => Promise.resolve({ data: [] }).then(resolve),
  };
  mocks.from.mockReturnValue(q);
  await expect(loadAgentAttachments(id, [id])).rejects.toThrow("unavailable");
});
it("does not call vision when the provider budget is denied", async () => {
  const imageKey = `users/${id}/image/a.jpg`,
    imageRow = { ...row, storage_key: imageKey, mime_type: "image/jpeg", status: "processing" };
  mocks.head.mockResolvedValue({
    size: 5,
    etag: "v1",
    httpMetadata: { contentType: "image/jpeg" },
  });
  mocks.rpc.mockResolvedValue({ data: { claimed: true, attachment: imageRow } });
  mocks.from.mockImplementation((table: string) => {
    let update: any;
    const q: any = {
      select: () => q,
      eq: () => q,
      limit: () => q,
      update: (v: any) => {
        update = v;
        return q;
      },
      maybeSingle: async () => ({ data: table === "creator_content_media" ? { id } : null }),
      single: async () => ({ data: { ...imageRow, ...update } }),
    };
    return q;
  });
  mocks.budget.mockRejectedValue(new Error("budget exceeded"));
  const run = vi.fn();
  vi.stubGlobal("__env__", { AI: { run } });
  await prepareAgentAttachmentForUser(id, { key: imageKey, name: "a.jpg" });
  expect(run).not.toHaveBeenCalled();
  expect(mocks.get).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it("reuses owned photos outside the new-upload folder through the existing media registry", async () => {
  const photoKey = `users/${id}/cover/cover.jpg`,
    photoRow = { ...row, storage_key: photoKey, mime_type: "image/jpeg", status: "processing" };
  mocks.head.mockResolvedValue({
    size: 5,
    etag: "v1",
    httpMetadata: { contentType: "image/jpeg" },
  });
  mocks.rpc.mockResolvedValue({ data: { claimed: true, attachment: photoRow } });
  mocks.from.mockImplementation(() => {
    let update: any;
    const q: any = {
      select: () => q,
      eq: () => q,
      limit: () => q,
      update: (v: any) => {
        update = v;
        return q;
      },
      maybeSingle: async () => ({ data: null }),
      single: async () => ({ data: { ...photoRow, ...update } }),
    };
    return q;
  });
  mocks.register.mockResolvedValue(id);
  await prepareAgentAttachmentForUser(id, { key: photoKey, name: "cover.jpg" });
  expect(mocks.register).toHaveBeenCalledWith(
    id,
    photoKey,
    "uploaded",
    expect.objectContaining({ messageId: null }),
  );
  expect(mocks.media).not.toHaveBeenCalled();
});
