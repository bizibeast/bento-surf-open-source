/* eslint-disable @typescript-eslint/no-explicit-any -- Scheduler tables land with the paired migration. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptServerSecret, encryptServerSecret } from "./secret-crypto.server";
import {
  deriveSocialPostStatus,
  parseRetryAfterSeconds,
  socialRetryDelaySeconds,
  SOCIAL_PROVIDER_DEFINITIONS,
  parseSchedulerMediaSetting,
  resolvedYouTubeFormat,
  tiktokCoverTimestampMs,
  youtubeDescriptionForUpload,
  youtubePublishedUrl,
  YOUTUBE_THUMBNAIL_MAX_BYTES,
  type SchedulerMedia,
  type SocialProvider,
  type YouTubePostFormat,
} from "./social-scheduler";
import { getPlan } from "./plan.server";
import { planHasEntitlement } from "./plans";
import {
  downloadProviderMedia,
  LINKEDIN_DOCUMENT_MAX_BYTES,
  LINKEDIN_IMAGE_MAX_BYTES,
  LINKEDIN_VIDEO_MAX_BYTES,
  ProviderMediaDownloadError,
  X_GIF_MAX_BYTES,
  X_IMAGE_MAX_BYTES,
  X_MEDIA_CHUNK_BYTES,
  X_VIDEO_MAX_BYTES,
} from "./social-provider-media";
import { socialProviderUsesMock } from "./social-provider-mode";
import { enqueueEmail } from "./email.server";

export type SocialPublishMessage = {
  kind: "social_publish";
  targetId: string;
  idempotencyKey: string;
};

type PublishResult = { id: string; url?: string; pending?: boolean };

export type RedditCommunity = {
  name: string;
  title: string;
  subscribers: number | null;
  submissionType: "any" | "link" | "self";
  over18: boolean;
};

const REDDIT_USER_AGENT = "web:bento.surf.scheduler:1.0 (by /u/bentosurf)";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterSeconds?: number | null,
  ) {
    super(message);
  }
}

async function providerJson(url: string, init: RequestInit, provider: SocialProvider) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  const providerErrorCode = data.error?.code;
  const providerReportedError = Boolean(data.error) && !["ok", "0", 0].includes(providerErrorCode);
  if (!response.ok || providerReportedError) {
    const retryable = response.status === 429 || response.status >= 500;
    const code = String(data.error?.code || data.code || response.status);
    const rawMessage =
      data.error?.message ||
      data.detail ||
      data.title ||
      data.message ||
      data.error_description ||
      (typeof data.error === "string" ? data.error : undefined) ||
      `${provider} rejected the post`;
    const providerMessage =
      code === "url_ownership_unverified"
        ? "TikTok rejected the video URL because this instance's media domain is not verified under URL properties in the TikTok developer app. Verify domain ownership, then retry."
        : code === "unaudited_client_can_only_post_to_private_accounts"
          ? "Unaudited / sandbox TikTok apps can only post when the TikTok account is private and privacy is Only me (SELF_ONLY)."
          : code === "privacy_level_option_mismatch"
            ? "That TikTok privacy option is not allowed for this account right now. Use Only me while the app is in sandbox / unaudited."
            : rawMessage;
    throw new ProviderError(
      String(providerMessage).slice(0, 500),
      code,
      retryable,
      response.status,
      parseRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }
  return { data, response };
}

async function providerBinaryPut(url: string, body: Uint8Array, contentType: string) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: Uint8Array.from(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    throw new ProviderError(
      `Upload failed with HTTP ${response.status}.`,
      String(response.status),
      response.status === 429 || response.status >= 500,
      response.status,
    );
  }
  return {
    response,
    etag: (response.headers.get("etag") || "").replaceAll('"', "").trim(),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishThreads(
  userId: string,
  token: string,
  body: string,
  media: SchedulerMedia[],
) {
  const params = new URLSearchParams({ access_token: token, text: body });
  const first = media[0];
  if (first?.mimeType.startsWith("video/")) {
    params.set("media_type", "VIDEO");
    params.set("video_url", first.url);
  } else if (first) {
    params.set("media_type", "IMAGE");
    params.set("image_url", first.url);
  } else {
    params.set("media_type", "TEXT");
  }
  const created = await providerJson(
    `https://graph.threads.net/v1.0/${userId}/threads`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    },
    "threads",
  );
  const containerId = String(created.data.id || "");
  if (!containerId)
    throw new ProviderError("Threads did not create the post.", "invalid_response", false);
  return { id: containerId, pending: true };
}

async function finishThreads(userId: string, containerId: string, token: string) {
  const statusResult = await providerJson(
    `https://graph.threads.net/v1.0/${containerId}?fields=status,error_message&access_token=${encodeURIComponent(token)}`,
    { method: "GET" },
    "threads",
  );
  const status = String(statusResult.data.status || "").toUpperCase();
  if (status === "ERROR" || status === "EXPIRED") {
    throw new ProviderError(
      String(statusResult.data.error_message || "Threads could not process this media."),
      `container_${status.toLowerCase()}`,
      false,
    );
  }
  if (status && status !== "FINISHED" && status !== "PUBLISHED") {
    return { id: containerId, pending: true };
  }
  const published = await providerJson(
    `https://graph.threads.net/v1.0/${userId}/threads_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: token, creation_id: containerId }),
    },
    "threads",
  );
  return { id: String(published.data.id || "") };
}

async function publishInstagram(
  userId: string,
  token: string,
  body: string,
  media: SchedulerMedia[],
  settings: Record<string, unknown> = {},
) {
  if (!media.length)
    throw new ProviderError("Instagram needs an image or video.", "media_required", false);

  for (const item of media) {
    if (item.mimeType.startsWith("image/") && item.mimeType !== "image/jpeg") {
      throw new ProviderError(
        "Instagram only accepts JPEG images. Remove this file and upload it again so Bento can convert it.",
        "media_invalid_type",
        false,
      );
    }
    if (
      item.mimeType.startsWith("video/") &&
      item.mimeType !== "video/mp4" &&
      item.mimeType !== "video/quicktime"
    ) {
      throw new ProviderError("Instagram videos must be MP4 or MOV.", "media_invalid_type", false);
    }
    if (item.mimeType === "application/pdf") {
      throw new ProviderError(
        "Instagram does not accept PDF uploads.",
        "media_invalid_type",
        false,
      );
    }
  }

  if (media.length === 1) {
    const first = media[0];
    const params = new URLSearchParams({ access_token: token, caption: body });
    if (first.mimeType.startsWith("video/")) {
      params.set("media_type", "REELS");
      params.set("video_url", first.url);
      const cover = parseSchedulerMediaSetting(settings.cover);
      if (cover?.url) params.set("cover_url", cover.url);
    } else {
      params.set("image_url", first.url);
    }
    const created = await providerJson(
      `https://graph.instagram.com/v25.0/${userId}/media`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      },
      "instagram",
    );
    const containerId = String(created.data.id || "");
    if (!containerId)
      throw new ProviderError("Instagram did not create the post.", "invalid_response", false);
    return { id: containerId, pending: true };
  }

  const childIds: string[] = [];
  for (const item of media.slice(0, 10)) {
    const childParams = new URLSearchParams({
      access_token: token,
      is_carousel_item: "true",
    });
    if (item.mimeType.startsWith("video/")) {
      childParams.set("media_type", "VIDEO");
      childParams.set("video_url", item.url);
    } else {
      childParams.set("image_url", item.url);
    }
    const child = await providerJson(
      `https://graph.instagram.com/v25.0/${userId}/media`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: childParams,
      },
      "instagram",
    );
    const childId = String(child.data.id || "");
    if (!childId) {
      throw new ProviderError(
        "Instagram did not create a carousel item.",
        "invalid_response",
        false,
      );
    }
    childIds.push(childId);
  }

  const created = await providerJson(
    `https://graph.instagram.com/v25.0/${userId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        access_token: token,
        media_type: "CAROUSEL",
        children: childIds.join(","),
        caption: body,
      }),
    },
    "instagram",
  );
  const containerId = String(created.data.id || "");
  if (!containerId)
    throw new ProviderError("Instagram did not create the carousel.", "invalid_response", false);
  return { id: containerId, pending: true };
}

async function finishInstagram(userId: string, containerId: string, token: string) {
  const statusResult = await providerJson(
    `https://graph.instagram.com/v25.0/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`,
    { method: "GET" },
    "instagram",
  );
  const status = String(
    statusResult.data.status_code || statusResult.data.status || "",
  ).toUpperCase();
  if (status === "ERROR" || status === "EXPIRED") {
    throw new ProviderError(
      "Instagram could not process this media.",
      `container_${status.toLowerCase()}`,
      false,
    );
  }
  if (status && status !== "FINISHED" && status !== "PUBLISHED") {
    return { id: containerId, pending: true };
  }
  const published = await providerJson(
    `https://graph.instagram.com/v25.0/${userId}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: token, creation_id: containerId }),
    },
    "instagram",
  );
  return { id: String(published.data.id || "") };
}

async function publishFacebook(
  pageId: string,
  token: string,
  body: string,
  media: SchedulerMedia[],
) {
  const first = media[0];
  const isVideo = first?.mimeType.startsWith("video/");
  const path = first ? (isVideo ? "videos" : "photos") : "feed";
  const params = new URLSearchParams({ access_token: token });
  if (first) params.set(isVideo ? "file_url" : "url", first.url);
  params.set(first ? (isVideo ? "description" : "caption") : "message", body);
  const result = await providerJson(
    `https://graph.facebook.com/v25.0/${pageId}/${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    },
    "facebook",
  );
  const id = String(result.data.post_id || result.data.id || "");
  return { id, url: id ? `https://www.facebook.com/${id.replace("_", "/posts/")}` : undefined };
}

async function publishLinkedIn(
  author: string,
  token: string,
  body: string,
  media: SchedulerMedia[],
) {
  const version = process.env.LINKEDIN_API_VERSION?.trim() || "202606";
  const linkedInHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Restli-Protocol-Version": "2.0.0",
    "LinkedIn-Version": version,
  };
  const images = media.filter((item) => item.mimeType.startsWith("image/"));
  const videos = media.filter((item) => item.mimeType.startsWith("video/"));
  const documents = media.filter(
    (item) =>
      item.mimeType === "application/pdf" ||
      item.mimeType === "application/msword" ||
      item.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      item.mimeType === "application/vnd.ms-powerpoint" ||
      item.mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );

  if (images.length && videos.length) {
    throw new ProviderError(
      "LinkedIn cannot mix images and video in one post. Schedule them separately.",
      "media_mix_unsupported",
      false,
    );
  }
  if (documents.length && (images.length || videos.length)) {
    throw new ProviderError(
      "LinkedIn document posts cannot include images or video.",
      "media_mix_unsupported",
      false,
    );
  }
  if (videos.length > 1) {
    throw new ProviderError("LinkedIn accepts one video per post.", "media_limit", false);
  }
  if (documents.length > 1) {
    throw new ProviderError("LinkedIn accepts one document per post.", "media_limit", false);
  }
  if (images.length > 20) {
    throw new ProviderError("LinkedIn accepts up to 20 images per post.", "media_limit", false);
  }

  let content: Record<string, unknown> | undefined;
  if (images.length === 1) {
    const imageUrn = await uploadLinkedInImage(author, images[0], linkedInHeaders);
    content = { media: { id: imageUrn, altText: images[0].name } };
  } else if (images.length >= 2) {
    const uploaded = [];
    for (const image of images) {
      uploaded.push({
        id: await uploadLinkedInImage(author, image, linkedInHeaders),
        altText: image.name,
      });
    }
    content = { multiImage: { images: uploaded } };
  } else if (videos.length === 1) {
    const videoUrn = await uploadLinkedInVideo(author, videos[0], linkedInHeaders);
    content = { media: { id: videoUrn, title: videos[0].name.slice(0, 200) } };
  } else if (documents.length === 1) {
    const documentUrn = await uploadLinkedInDocument(author, documents[0], linkedInHeaders);
    content = { media: { id: documentUrn, title: documents[0].name.slice(0, 200) } };
  }

  const { data, response } = await providerJson(
    "https://api.linkedin.com/rest/posts",
    {
      method: "POST",
      headers: linkedInHeaders,
      body: JSON.stringify({
        author,
        commentary: body,
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
        ...(content ? { content } : {}),
      }),
    },
    "linkedin",
  );
  const id = response.headers.get("x-restli-id") || String(data.id || "");
  return {
    id,
    url: id ? `https://www.linkedin.com/feed/update/${encodeURIComponent(id)}` : undefined,
  };
}

async function downloadLinkedInMedia(
  item: SchedulerMedia,
  maxBytes: number,
  allowedMimeTypes: readonly string[],
  timeoutMs: number,
) {
  try {
    return await downloadProviderMedia(item.url, {
      maxBytes,
      allowedMimeTypes,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof ProviderMediaDownloadError) {
      if (error.code === "invalid_type") {
        throw new ProviderError(
          "This media format is not supported by LinkedIn. Remove it and upload a supported file.",
          "media_invalid_type",
          false,
        );
      }
      throw new ProviderError(error.message, `media_${error.code}`, error.retryable);
    }
    throw error;
  }
}

async function uploadLinkedInImage(
  author: string,
  image: SchedulerMedia,
  linkedInHeaders: Record<string, string>,
) {
  const initialized = await providerJson(
    "https://api.linkedin.com/rest/images?action=initializeUpload",
    {
      method: "POST",
      headers: linkedInHeaders,
      body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
    },
    "linkedin",
  );
  const uploadUrl = String(initialized.data.value?.uploadUrl || "");
  const imageUrn = String(initialized.data.value?.image || "");
  if (!uploadUrl || !imageUrn) {
    throw new ProviderError("LinkedIn did not open an image upload.", "invalid_response", false);
  }
  const downloaded = await downloadLinkedInMedia(
    image,
    LINKEDIN_IMAGE_MAX_BYTES,
    ["image/jpeg", "image/png", "image/gif"],
    60_000,
  );
  await providerBinaryPut(uploadUrl, downloaded.bytes, downloaded.mimeType || image.mimeType);
  return imageUrn;
}

async function waitForLinkedInAsset(
  kind: "videos" | "documents",
  urn: string,
  linkedInHeaders: Record<string, string>,
) {
  const url = `https://api.linkedin.com/rest/${kind}/${encodeURIComponent(urn)}`;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const { data } = await providerJson(
      url,
      { method: "GET", headers: linkedInHeaders },
      "linkedin",
    );
    const status = String(data.status || "").toUpperCase();
    if (status === "AVAILABLE") return;
    if (status === "PROCESSING_FAILED") {
      throw new ProviderError(
        `LinkedIn could not process this ${kind === "videos" ? "video" : "document"}.`,
        "media_processing_failed",
        false,
      );
    }
    await sleep(2_000);
  }
  throw new ProviderError(
    "LinkedIn is still processing this media. Try again in a minute.",
    "media_processing",
    true,
  );
}

async function uploadLinkedInVideo(
  author: string,
  video: SchedulerMedia,
  linkedInHeaders: Record<string, string>,
) {
  const downloaded = await downloadLinkedInMedia(
    video,
    LINKEDIN_VIDEO_MAX_BYTES,
    ["video/mp4", "video/quicktime"],
    180_000,
  );
  const initialized = await providerJson(
    "https://api.linkedin.com/rest/videos?action=initializeUpload",
    {
      method: "POST",
      headers: linkedInHeaders,
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: author,
          fileSizeBytes: downloaded.bytes.byteLength,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      }),
    },
    "linkedin",
  );
  const value = initialized.data.value || {};
  const videoUrn = String(value.video || "");
  const uploadToken = String(value.uploadToken || "");
  const instructions = Array.isArray(value.uploadInstructions) ? value.uploadInstructions : [];
  if (!videoUrn || !instructions.length) {
    throw new ProviderError("LinkedIn did not open a video upload.", "invalid_response", false);
  }

  const uploadedPartIds: string[] = [];
  for (const instruction of instructions) {
    const firstByte = Number(instruction.firstByte);
    const lastByte = Number(instruction.lastByte);
    const uploadUrl = String(instruction.uploadUrl || "");
    if (!uploadUrl || !Number.isFinite(firstByte) || !Number.isFinite(lastByte)) {
      throw new ProviderError(
        "LinkedIn returned an invalid video upload plan.",
        "invalid_response",
        false,
      );
    }
    const part = downloaded.bytes.slice(firstByte, lastByte + 1);
    const uploaded = await providerBinaryPut(uploadUrl, part, "application/octet-stream");
    if (!uploaded.etag) {
      throw new ProviderError(
        "LinkedIn did not acknowledge a video upload part.",
        "invalid_response",
        true,
      );
    }
    uploadedPartIds.push(uploaded.etag);
  }

  await providerJson(
    "https://api.linkedin.com/rest/videos?action=finalizeUpload",
    {
      method: "POST",
      headers: linkedInHeaders,
      body: JSON.stringify({
        finalizeUploadRequest: {
          video: videoUrn,
          uploadToken,
          uploadedPartIds,
        },
      }),
    },
    "linkedin",
  );
  await waitForLinkedInAsset("videos", videoUrn, linkedInHeaders);
  return videoUrn;
}

async function uploadLinkedInDocument(
  author: string,
  document: SchedulerMedia,
  linkedInHeaders: Record<string, string>,
) {
  const downloaded = await downloadLinkedInMedia(
    document,
    LINKEDIN_DOCUMENT_MAX_BYTES,
    [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    120_000,
  );
  const initialized = await providerJson(
    "https://api.linkedin.com/rest/documents?action=initializeUpload",
    {
      method: "POST",
      headers: linkedInHeaders,
      body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
    },
    "linkedin",
  );
  const uploadUrl = String(initialized.data.value?.uploadUrl || "");
  const documentUrn = String(initialized.data.value?.document || "");
  if (!uploadUrl || !documentUrn) {
    throw new ProviderError("LinkedIn did not open a document upload.", "invalid_response", false);
  }
  await providerBinaryPut(
    uploadUrl,
    downloaded.bytes,
    downloaded.mimeType || document.mimeType || "application/pdf",
  );
  await waitForLinkedInAsset("documents", documentUrn, linkedInHeaders);
  return documentUrn;
}

async function downloadXMedia(
  item: SchedulerMedia,
  maxBytes: number,
  allowedMimeTypes: readonly string[],
  timeoutMs: number,
) {
  try {
    return await downloadProviderMedia(item.url, {
      maxBytes,
      allowedMimeTypes,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof ProviderMediaDownloadError) {
      if (error.code === "invalid_type") {
        throw new ProviderError(
          "This media format is not supported by X. Remove it and upload a supported file.",
          "media_invalid_type",
          false,
        );
      }
      if (error.code === "too_large") {
        throw new ProviderError("This media is too large for X.", "media_too_large", false);
      }
      throw new ProviderError(error.message, `media_${error.code}`, error.retryable);
    }
    throw error;
  }
}

async function xMediaFormPost(
  token: string,
  fields: Record<string, string>,
  file?: { bytes: Uint8Array; mimeType: string; filename: string; fieldName?: string },
) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  if (file) {
    form.append(
      file.fieldName || "media",
      new Blob([Uint8Array.from(file.bytes)], { type: file.mimeType }),
      file.filename,
    );
  }
  const response = await fetch("https://api.x.com/2/media/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!response.ok || data.errors?.length) {
    const message =
      data.detail ||
      data.title ||
      data.errors?.[0]?.detail ||
      data.errors?.[0]?.message ||
      data.error?.message ||
      `X media upload failed with HTTP ${response.status}`;
    throw new ProviderError(
      String(message).slice(0, 500),
      String(data.errors?.[0]?.type || data.type || response.status),
      response.status === 429 || response.status >= 500,
      response.status,
    );
  }
  return data;
}

async function waitForXMediaProcessing(token: string, mediaId: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(
      `https://api.x.com/2/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const text = await response.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!response.ok) {
      throw new ProviderError(
        data.detail || data.title || "X could not report media processing status.",
        String(response.status),
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    const info = data.data?.processing_info || data.processing_info;
    if (!info) return;
    const state = String(info.state || "");
    if (state === "succeeded") return;
    if (state === "failed") {
      throw new ProviderError("X could not process this media.", "media_processing_failed", false);
    }
    const waitSeconds = Math.max(1, Number(info.check_after_secs) || 2);
    await sleep(waitSeconds * 1_000);
  }
  throw new ProviderError(
    "X is still processing this media. Try again in a minute.",
    "media_processing",
    true,
  );
}

async function uploadXMediaSimple(
  token: string,
  item: SchedulerMedia,
  category: "tweet_image" | "tweet_gif",
) {
  const maxBytes = category === "tweet_gif" ? X_GIF_MAX_BYTES : X_IMAGE_MAX_BYTES;
  const allowed =
    category === "tweet_gif"
      ? (["image/gif"] as const)
      : (["image/jpeg", "image/png", "image/webp", "image/gif"] as const);
  const downloaded = await downloadXMedia(item, maxBytes, allowed, 60_000);
  const mimeType = downloaded.mimeType || item.mimeType;
  const data = await xMediaFormPost(
    token,
    {
      media_category: category,
      media_type: mimeType,
    },
    {
      bytes: downloaded.bytes,
      mimeType,
      filename: item.name || (category === "tweet_gif" ? "media.gif" : "media.jpg"),
    },
  );
  const mediaId = String(data.data?.id || data.id || data.media_id_string || "");
  if (!mediaId) throw new ProviderError("X did not return a media ID.", "invalid_response", false);
  const processing = data.data?.processing_info || data.processing_info;
  if (processing) await waitForXMediaProcessing(token, mediaId);
  return mediaId;
}

async function uploadXMediaChunked(
  token: string,
  item: SchedulerMedia,
  category: "tweet_video" | "tweet_gif",
) {
  const isGif = category === "tweet_gif";
  const downloaded = await downloadXMedia(
    item,
    isGif ? X_GIF_MAX_BYTES : X_VIDEO_MAX_BYTES,
    isGif ? ["image/gif"] : ["video/mp4", "video/quicktime"],
    isGif ? 60_000 : 180_000,
  );
  const mimeType = downloaded.mimeType || item.mimeType;
  const totalBytes = downloaded.bytes.byteLength;
  const init = await xMediaFormPost(token, {
    command: "INIT",
    media_type: mimeType,
    total_bytes: String(totalBytes),
    media_category: category,
  });
  const mediaId = String(init.data?.id || init.id || init.media_id_string || "");
  if (!mediaId)
    throw new ProviderError("X did not open a media upload.", "invalid_response", false);

  let segmentIndex = 0;
  for (let offset = 0; offset < totalBytes; offset += X_MEDIA_CHUNK_BYTES) {
    const chunk = downloaded.bytes.slice(offset, offset + X_MEDIA_CHUNK_BYTES);
    await xMediaFormPost(
      token,
      {
        command: "APPEND",
        media_id: mediaId,
        segment_index: String(segmentIndex),
      },
      {
        bytes: chunk,
        mimeType: "application/octet-stream",
        filename: `chunk-${segmentIndex}`,
        fieldName: "media",
      },
    );
    segmentIndex += 1;
  }

  const finalized = await xMediaFormPost(token, {
    command: "FINALIZE",
    media_id: mediaId,
  });
  const processing = finalized.data?.processing_info || finalized.processing_info;
  if (processing) await waitForXMediaProcessing(token, mediaId);
  return mediaId;
}

async function publishX(token: string, body: string, media: SchedulerMedia[]) {
  const images = media.filter((item) => item.mimeType.startsWith("image/"));
  const videos = media.filter((item) => item.mimeType.startsWith("video/"));
  const gifs = images.filter((item) => item.mimeType === "image/gif");
  const stills = images.filter((item) => item.mimeType !== "image/gif");

  if (videos.length && images.length) {
    throw new ProviderError(
      "X cannot mix images and video in one post. Schedule them separately.",
      "media_mix_unsupported",
      false,
    );
  }
  if (videos.length > 1) {
    throw new ProviderError("X accepts one video per post.", "media_limit", false);
  }
  if (gifs.length && (stills.length || videos.length)) {
    throw new ProviderError(
      "X GIF posts cannot include other images or video.",
      "media_mix_unsupported",
      false,
    );
  }
  if (gifs.length > 1) {
    throw new ProviderError("X accepts one GIF per post.", "media_limit", false);
  }
  if (stills.length > 4) {
    throw new ProviderError("X accepts up to 4 images per post.", "media_limit", false);
  }

  const mediaIds: string[] = [];
  if (videos.length === 1) {
    mediaIds.push(await uploadXMediaChunked(token, videos[0], "tweet_video"));
  } else if (gifs.length === 1) {
    // Small GIFs can use the simple upload; fall back to chunked for larger files.
    const gif = gifs[0];
    mediaIds.push(
      gif.size > 0 && gif.size <= X_IMAGE_MAX_BYTES
        ? await uploadXMediaSimple(token, gif, "tweet_gif")
        : await uploadXMediaChunked(token, gif, "tweet_gif"),
    );
  } else {
    for (const image of stills) {
      mediaIds.push(await uploadXMediaSimple(token, image, "tweet_image"));
    }
  }

  const payload: Record<string, unknown> = { text: body };
  if (mediaIds.length) payload.media = { media_ids: mediaIds };

  const result = await providerJson(
    "https://api.x.com/2/tweets",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    "twitter",
  );
  const id = String(result.data.data?.id || result.data.id || "");
  return { id, url: id ? `https://x.com/i/web/status/${id}` : undefined };
}

async function publishReddit(
  token: string,
  title: string,
  body: string,
  settings: Record<string, unknown>,
) {
  const community = String(settings.community || "")
    .trim()
    .replace(/^r\//i, "");
  const kind = String(settings.kind || "self") === "link" ? "link" : "self";
  const fields: Record<string, string> = {
    api_type: "json",
    kind,
    sr: community,
    title,
    resubmit: "true",
    sendreplies: "true",
  };
  if (kind === "link") fields.url = String(settings.url || "");
  else fields.text = body;
  if (settings.nsfw) fields.nsfw = "true";
  if (settings.spoiler) fields.spoiler = "true";

  const result = await providerJson(
    "https://oauth.reddit.com/api/submit",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": REDDIT_USER_AGENT,
      },
      body: new URLSearchParams(fields),
    },
    "reddit",
  );
  const errors = result.data.json?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    throw new ProviderError(
      String(Array.isArray(first) ? first[1] || first[0] : "Reddit rejected the post."),
      String(Array.isArray(first) ? first[0] || "reddit_error" : "reddit_error"),
      false,
    );
  }
  const id = String(result.data.json?.data?.id || result.data.json?.data?.name || "");
  const rawUrl = String(result.data.json?.data?.url || "");
  const url = rawUrl.startsWith("/") ? `https://www.reddit.com${rawUrl}` : rawUrl || undefined;
  if (!id) throw new ProviderError("Reddit did not return a post ID.", "invalid_response", false);
  return { id, url };
}

async function setYouTubeThumbnail(
  token: string,
  videoId: string,
  settings: Record<string, unknown>,
  format: YouTubePostFormat,
) {
  const thumbnail = parseSchedulerMediaSetting(settings.thumbnail);
  if (!thumbnail?.url) return;
  let downloaded: Awaited<ReturnType<typeof downloadProviderMedia>>;
  try {
    downloaded = await downloadProviderMedia(thumbnail.url, {
      maxBytes: YOUTUBE_THUMBNAIL_MAX_BYTES,
      allowedMimeTypes: ["image/jpeg"],
    });
  } catch (error) {
    if (error instanceof ProviderMediaDownloadError) {
      throw new ProviderError(error.message, `media_${error.code}`, error.retryable);
    }
    throw error;
  }
  const uploaded = await fetch(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": downloaded.mimeType || thumbnail.mimeType,
      },
      body: new Blob([downloaded.bytes as BlobPart], {
        type: downloaded.mimeType || thumbnail.mimeType,
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!uploaded.ok) {
    const retryable = uploaded.status === 404 || uploaded.status === 429 || uploaded.status >= 500;
    // Shorts use the same thumbnails.set call. 403 usually means the channel
    // cannot set Shorts covers yet; the Shorts feed plays the video anyway.
    if (format === "short" && uploaded.status === 403) return;
    throw new ProviderError(
      "YouTube accepted the video but rejected the custom thumbnail. Confirm the channel can upload thumbnails, then retry.",
      String(uploaded.status),
      retryable,
      uploaded.status,
    );
  }
}

async function publishYouTube(
  token: string,
  title: string,
  body: string,
  media: SchedulerMedia[],
  settings: Record<string, unknown>,
  target: any,
) {
  const existingId = String(target.remote_post_id || "");
  const format = resolvedYouTubeFormat(settings.youtubeFormat, null);
  if (existingId) {
    await setYouTubeThumbnail(token, existingId, settings, format);
    return { id: existingId, url: youtubePublishedUrl(existingId, format) };
  }
  const video = media.find((item) => item.mimeType.startsWith("video/"));
  if (!video) throw new ProviderError("YouTube needs a video.", "video_required", false);
  const requestedPrivacy = String(settings.youtubePrivacy || "private");
  const privacyStatus = ["private", "unlisted", "public"].includes(requestedPrivacy)
    ? requestedPrivacy
    : "private";
  const description = youtubeDescriptionForUpload(body, settings);
  const db = supabaseAdmin as any;
  const chunkSize = 256 * 1024 * 8; // 2 MiB, multiple of 256 KiB
  let location = String(target.upload_session_url || "");
  let offset = Math.max(0, Number(target.upload_byte_offset || 0));

  if (!location) {
    const init = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(video.size),
          "X-Upload-Content-Type": video.mimeType,
        },
        body: JSON.stringify({
          snippet: {
            title: title.trim() || description.slice(0, 100) || "Untitled video",
            description,
            categoryId: "22",
          },
          status: { privacyStatus, selfDeclaredMadeForKids: false },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!init.ok)
      throw new ProviderError(
        "YouTube rejected the upload session.",
        String(init.status),
        init.status >= 500,
        init.status,
      );
    location = init.headers.get("location") || "";
    if (!location)
      throw new ProviderError("YouTube did not open an upload session.", "missing_location", false);
    offset = 0;
    await db
      .from("social_post_targets")
      .update({ upload_session_url: location, upload_byte_offset: 0 })
      .eq("id", target.id);
  }

  const source = await fetch(video.url, { signal: AbortSignal.timeout(60_000) });
  if (!source.ok || !source.body)
    throw new ProviderError("The scheduled video is unavailable.", "media_unavailable", true);
  const bytes = new Uint8Array(await source.arrayBuffer());
  if (bytes.byteLength !== video.size && video.size > 0) {
    // Prefer the actual downloaded size when the stored metadata drifted.
  }
  const total = bytes.byteLength;

  while (offset < total) {
    const end = Math.min(offset + chunkSize, total);
    const chunk = bytes.subarray(offset, end);
    const isFinal = end >= total;
    const uploaded = await fetch(location, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.byteLength),
        "Content-Type": video.mimeType,
        "Content-Range": `bytes ${offset}-${end - 1}/${total}`,
      },
      body: chunk,
      signal: AbortSignal.timeout(120_000),
    });

    if (uploaded.status === 308) {
      const range = uploaded.headers.get("range");
      const matched = range?.match(/bytes=0-(\d+)/);
      offset = matched ? Number(matched[1]) + 1 : end;
      await db
        .from("social_post_targets")
        .update({ upload_session_url: location, upload_byte_offset: offset })
        .eq("id", target.id);
      continue;
    }

    if (!uploaded.ok) {
      const retryable = uploaded.status === 429 || uploaded.status >= 500;
      throw new ProviderError(
        "YouTube rejected a resumable upload chunk.",
        String(uploaded.status),
        retryable,
        uploaded.status,
      );
    }

    const text = await uploaded.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    const id = String(data.id || "");
    await db
      .from("social_post_targets")
      .update({
        upload_session_url: null,
        upload_byte_offset: total,
        ...(id
          ? {
              remote_post_id: id,
              remote_post_url: youtubePublishedUrl(id, format),
            }
          : {}),
      })
      .eq("id", target.id);
    if (!id && !isFinal) {
      offset = end;
      continue;
    }
    if (id) await setYouTubeThumbnail(token, id, settings, format);
    return { id, url: id ? youtubePublishedUrl(id, format) : undefined };
  }

  throw new ProviderError("YouTube upload did not complete.", "upload_incomplete", true);
}

async function fetchTikTokCreatorInfo(token: string) {
  const result = await providerJson(
    "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: "{}",
    },
    "tiktok",
  );
  const creator = result.data.data || {};
  return {
    username: String(creator.creator_username || ""),
    nickname: String(creator.creator_nickname || creator.creator_username || "TikTok creator"),
    avatarUrl: creator.creator_avatar_url ? String(creator.creator_avatar_url) : null,
    privacyLevelOptions: Array.isArray(creator.privacy_level_options)
      ? creator.privacy_level_options.map(String)
      : [],
    commentDisabled: Boolean(creator.comment_disabled),
    duetDisabled: Boolean(creator.duet_disabled),
    stitchDisabled: Boolean(creator.stitch_disabled),
    maxVideoPostDurationSec: Number(creator.max_video_post_duration_sec || 0),
  };
}

export async function loadTikTokCreatorInfo(connection: any) {
  return {
    connectionId: String(connection.id),
    ...(await fetchTikTokCreatorInfo(await accessTokenForConnection(connection))),
  };
}

const RETRYABLE_TIKTOK_FAILURES = new Set(["internal", "video_pull_failed"]);

export function buildTikTokPostInfo(
  body: string,
  settings: Record<string, unknown> = {},
  creator: { commentDisabled: boolean; duetDisabled: boolean; stitchDisabled: boolean },
) {
  return {
    title: body,
    privacy_level: String(settings.privacyLevel || ""),
    disable_duet: creator.duetDisabled || Boolean(settings.disableDuet),
    disable_comment: creator.commentDisabled || Boolean(settings.disableComment),
    disable_stitch: creator.stitchDisabled || Boolean(settings.disableStitch),
    video_cover_timestamp_ms: tiktokCoverTimestampMs(settings),
    brand_content_toggle: Boolean(settings.brandContentToggle),
    brand_organic_toggle: Boolean(settings.brandOrganicToggle),
    is_aigc: Boolean(settings.isAigc),
  };
}

async function publishTikTok(token: string, body: string, media: SchedulerMedia[], settings: any) {
  const video = media.find((item) => item.mimeType.startsWith("video/"));
  if (!video) throw new ProviderError("TikTok needs a video.", "video_required", false);
  const creator = await fetchTikTokCreatorInfo(token);
  const allowed = creator.privacyLevelOptions;
  const requested = String(settings?.privacyLevel || "");
  if (!requested || !allowed.includes(requested)) {
    throw new ProviderError(
      allowed.length
        ? `TikTok only allows these privacy options for this account right now: ${allowed.join(", ")}. Sandbox / unaudited apps usually require Only me (SELF_ONLY), and the TikTok account must be private.`
        : "Choose a TikTok privacy setting before publishing.",
      "privacy_required",
      false,
    );
  }
  const duration = Number(settings?.videoDurationSeconds);
  if (
    Number.isFinite(duration) &&
    creator.maxVideoPostDurationSec > 0 &&
    duration > creator.maxVideoPostDurationSec
  ) {
    throw new ProviderError(
      `This TikTok account accepts videos up to ${creator.maxVideoPostDurationSec} seconds.`,
      "video_duration_too_long",
      false,
    );
  }
  const brandContent = Boolean(settings?.brandContentToggle);
  const brandOrganic = Boolean(settings?.brandOrganicToggle);
  if (settings?.commercialContent && !brandContent && !brandOrganic) {
    throw new ProviderError(
      "Choose whether the TikTok post promotes your brand, another brand, or both.",
      "commercial_content_type_required",
      false,
    );
  }
  if (brandContent && requested === "SELF_ONLY") {
    throw new ProviderError(
      "TikTok branded content cannot use Only me privacy.",
      "branded_content_privacy",
      false,
    );
  }
  const result = await providerJson(
    "https://open.tiktokapis.com/v2/post/publish/video/init/",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        post_info: buildTikTokPostInfo(body, settings, creator),
        source_info: { source: "PULL_FROM_URL", video_url: video.url },
      }),
    },
    "tiktok",
  );
  const id = String(result.data.data?.publish_id || "");
  return { id, pending: true };
}

async function finishTikTok(publishId: string, token: string): Promise<PublishResult> {
  const result = await providerJson(
    "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ publish_id: publishId }),
    },
    "tiktok",
  );
  const status = String(result.data.data?.status || "").toUpperCase();
  if (status === "FAILED") {
    const reason = String(result.data.data?.fail_reason || "TikTok could not publish this post.");
    throw new ProviderError(
      reason,
      reason || "publish_failed",
      RETRYABLE_TIKTOK_FAILURES.has(reason),
    );
  }
  if (status !== "PUBLISH_COMPLETE") return { id: publishId, pending: true };
  const publicIds = result.data.data?.publicaly_available_post_id;
  const id = String(Array.isArray(publicIds) && publicIds[0] ? publicIds[0] : publishId);
  return { id };
}

export function tiktokRetryRemotePostId(
  provider: SocialProvider,
  isStatusCheck: boolean,
  errorCode: string,
  remotePostId: string | null,
) {
  return provider === "tiktok" && isStatusCheck && RETRYABLE_TIKTOK_FAILURES.has(errorCode)
    ? null
    : remotePostId;
}

export async function accessTokenForConnection(connection: any) {
  if (!connection.access_token)
    throw new ProviderError(
      "Reconnect this account before publishing.",
      "reconnect_required",
      false,
    );
  const current = await decryptServerSecret(connection.access_token, "social");
  const expiresAt = connection.token_expires_at
    ? new Date(connection.token_expires_at).getTime()
    : Number.POSITIVE_INFINITY;
  if (expiresAt > Date.now() + 5 * 60_000) return current;
  const provider = connection.provider as SocialProvider;

  if (provider === "threads") {
    const url = new URL("https://graph.threads.net/refresh_access_token");
    url.searchParams.set("grant_type", "th_refresh_token");
    url.searchParams.set("access_token", current);
    const refreshed = await providerJson(url.toString(), { method: "GET" }, provider);
    const nextAccessToken = String(refreshed.data.access_token || "");
    if (!nextAccessToken)
      throw new ProviderError("Threads did not refresh this connection.", "refresh_failed", false);
    const expiresIn = Number(refreshed.data.expires_in || 5_184_000);
    await (supabaseAdmin as any)
      .from("social_connections")
      .update({
        access_token: await encryptServerSecret(nextAccessToken, "social"),
        token_expires_at: new Date(Date.now() + expiresIn * 1_000).toISOString(),
        last_refreshed_at: new Date().toISOString(),
        status: "active",
        last_error: null,
      })
      .eq("id", connection.id);
    return nextAccessToken;
  }

  if (!connection.refresh_token) {
    throw new ProviderError(
      "This connection expired. Reconnect it before publishing.",
      "reconnect_required",
      false,
      401,
    );
  }

  const refreshToken = await decryptServerSecret(connection.refresh_token, "social");
  let endpoint = "";
  const fields: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (provider === "youtube") {
    endpoint = "https://oauth2.googleapis.com/token";
    fields.client_id = process.env.GOOGLE_YOUTUBE_CLIENT_ID?.trim() || "";
    fields.client_secret = process.env.GOOGLE_YOUTUBE_CLIENT_SECRET?.trim() || "";
  } else if (provider === "twitter") {
    endpoint = "https://api.x.com/2/oauth2/token";
    const clientId = process.env.X_CLIENT_ID?.trim() || "";
    const clientSecret = process.env.X_CLIENT_SECRET?.trim() || "";
    if (!clientId || !clientSecret) {
      throw new ProviderError(
        "Bento's X provider credentials are incomplete.",
        "provider_not_configured",
        false,
      );
    }
    headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  } else if (provider === "tiktok") {
    endpoint = "https://open.tiktokapis.com/v2/oauth/token/";
    fields.client_key = process.env.TIKTOK_CLIENT_KEY?.trim() || "";
    fields.client_secret = process.env.TIKTOK_CLIENT_SECRET?.trim() || "";
  } else if (provider === "linkedin") {
    endpoint = "https://www.linkedin.com/oauth/v2/accessToken";
    fields.client_id = process.env.LINKEDIN_CLIENT_ID?.trim() || "";
    fields.client_secret = process.env.LINKEDIN_CLIENT_SECRET?.trim() || "";
  } else if (provider === "reddit") {
    endpoint = "https://www.reddit.com/api/v1/access_token";
    const clientId = process.env.REDDIT_CLIENT_ID?.trim() || "";
    const clientSecret = process.env.REDDIT_CLIENT_SECRET?.trim() || "";
    if (!clientId || !clientSecret) {
      throw new ProviderError(
        "Bento's Reddit provider credentials are incomplete.",
        "provider_not_configured",
        false,
      );
    }
    headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
    headers["User-Agent"] = REDDIT_USER_AGENT;
  } else {
    throw new ProviderError(
      "This connection expired. Reconnect it before publishing.",
      "reconnect_required",
      false,
      401,
    );
  }
  if (Object.values(fields).some((value) => !value)) {
    throw new ProviderError(
      "Bento's provider credentials are incomplete.",
      "provider_not_configured",
      false,
    );
  }
  const refreshed = await providerJson(
    endpoint,
    { method: "POST", headers, body: new URLSearchParams(fields) },
    provider,
  );
  const nextAccessToken = String(refreshed.data.access_token || "");
  if (!nextAccessToken)
    throw new ProviderError(
      "The provider did not refresh this connection.",
      "refresh_failed",
      false,
    );
  const nextRefreshToken = String(refreshed.data.refresh_token || refreshToken);
  const expiresIn = Number(refreshed.data.expires_in || 3_600);
  await (supabaseAdmin as any)
    .from("social_connections")
    .update({
      access_token: await encryptServerSecret(nextAccessToken, "social"),
      refresh_token: await encryptServerSecret(nextRefreshToken, "social"),
      token_expires_at: new Date(Date.now() + expiresIn * 1_000).toISOString(),
      last_refreshed_at: new Date().toISOString(),
      status: "active",
      last_error: null,
    })
    .eq("id", connection.id);
  return nextAccessToken;
}

function redditCommunityFromListing(value: any): RedditCommunity | null {
  const name = String(value?.display_name || "").trim();
  if (!name) return null;
  const submissionType = String(value?.submission_type || "any");
  return {
    name,
    title: String(value?.title || name).trim() || name,
    subscribers: Number.isFinite(Number(value?.subscribers)) ? Number(value.subscribers) : null,
    submissionType: submissionType === "link" || submissionType === "self" ? submissionType : "any",
    over18: Boolean(value?.over18),
  };
}

export async function loadRedditCommunities(connection: any): Promise<RedditCommunity[]> {
  const token = await accessTokenForConnection(connection);
  const result = await providerJson(
    "https://oauth.reddit.com/subreddits/mine/subscriber?limit=100&raw_json=1",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": REDDIT_USER_AGENT,
      },
    },
    "reddit",
  );
  return (Array.isArray(result.data?.data?.children) ? result.data.data.children : [])
    .map((item: any) => redditCommunityFromListing(item?.data))
    .filter((item: RedditCommunity | null): item is RedditCommunity => Boolean(item))
    .sort((left: RedditCommunity, right: RedditCommunity) => left.name.localeCompare(right.name));
}

export async function preflightRedditCommunity(
  connection: any,
  community: string,
  kind: "self" | "link",
) {
  const normalized = community.replace(/^r\//i, "").trim();
  const token = await accessTokenForConnection(connection);
  const result = await providerJson(
    `https://oauth.reddit.com/r/${encodeURIComponent(normalized)}/about?raw_json=1`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": REDDIT_USER_AGENT,
      },
    },
    "reddit",
  );
  const communityInfo = redditCommunityFromListing(result.data?.data);
  if (!communityInfo || communityInfo.name.toLowerCase() !== normalized.toLowerCase()) {
    throw new ProviderError(
      "That Reddit community could not be found.",
      "community_not_found",
      false,
    );
  }
  if (communityInfo.submissionType !== "any" && communityInfo.submissionType !== kind) {
    const allowed = communityInfo.submissionType === "self" ? "text posts" : "link posts";
    throw new ProviderError(
      `r/${communityInfo.name} only accepts ${allowed}.`,
      "post_type_not_allowed",
      false,
    );
  }
  if (
    result.data?.data?.restrict_posting &&
    !result.data?.data?.user_is_contributor &&
    !result.data?.data?.user_is_moderator
  ) {
    throw new ProviderError(
      `r/${communityInfo.name} only allows approved users to post.`,
      "posting_restricted",
      false,
    );
  }
  return communityInfo;
}

async function publish(
  provider: SocialProvider,
  connection: any,
  post: any,
  target: any,
): Promise<PublishResult> {
  if (socialProviderUsesMock(provider)) {
    return { id: `staging-${target.id}` };
  }
  const token = await accessTokenForConnection(connection);
  const media = (Array.isArray(post.media) ? post.media : []) as SchedulerMedia[];
  if (provider === "threads")
    return publishThreads(connection.provider_user_id, token, post.body, media);
  if (provider === "instagram")
    return publishInstagram(
      connection.provider_user_id,
      token,
      post.body,
      media,
      target.provider_settings || {},
    );
  if (provider === "facebook")
    return publishFacebook(connection.provider_user_id, token, post.body, media);
  if (provider === "linkedin")
    return publishLinkedIn(connection.provider_user_id, token, post.body, media);
  if (provider === "twitter") return publishX(token, post.body, media);
  if (provider === "youtube")
    return publishYouTube(
      token,
      post.title,
      post.body,
      media,
      target.provider_settings || {},
      target,
    );
  if (provider === "reddit")
    return publishReddit(token, post.title, post.body, target.provider_settings || {});
  if (provider === "tiktok")
    return publishTikTok(token, post.body, media, target.provider_settings);
  throw new ProviderError("This provider is not supported.", "unsupported_provider", false);
}

async function finishPendingPublish(
  provider: SocialProvider,
  connection: any,
  target: any,
): Promise<PublishResult> {
  const token = await accessTokenForConnection(connection);
  const remoteId = String(target.remote_post_id || "");
  if (!remoteId)
    throw new ProviderError("The provider processing ID is missing.", "missing_remote_id", false);
  if (provider === "instagram")
    return finishInstagram(connection.provider_user_id, remoteId, token);
  if (provider === "threads") return finishThreads(connection.provider_user_id, remoteId, token);
  if (provider === "tiktok") return finishTikTok(remoteId, token);
  throw new ProviderError(
    "This provider does not use asynchronous publishing.",
    "invalid_state",
    false,
  );
}

export async function processSocialPublishMessage(message: SocialPublishMessage) {
  const db = supabaseAdmin as any;
  const { data: target, error } = await db
    .from("social_post_targets")
    .select("*, post:social_posts(*), connection:social_connections(*)")
    .eq("id", message.targetId)
    .eq("idempotency_key", message.idempotencyKey)
    .maybeSingle();
  if (error) throw error;
  if (
    !target ||
    target.status !== "queued" ||
    target.post?.cancelled_at ||
    target.post?.status === "cancelled"
  )
    return;

  const ownerPlan = await getPlan(String(target.post.user_id));
  if (!planHasEntitlement(ownerPlan, "postScheduler")) {
    await db
      .from("social_post_targets")
      .update({
        status: "cancelled",
        lease_expires_at: null,
        next_attempt_at: null,
        last_error_code: "plan_unavailable",
        last_error_message: "This post was cancelled when the creator moved to Free.",
      })
      .eq("post_id", target.post_id)
      .in("status", ["pending", "queued", "retrying", "processing"]);
    await db
      .from("social_posts")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", target.post_id);
    return;
  }

  const isStatusCheck =
    Boolean(target.remote_post_id) &&
    (["instagram", "threads", "tiktok"] as SocialProvider[]).includes(target.provider);
  if (isStatusCheck && Date.now() - new Date(target.created_at).getTime() > 24 * 60 * 60_000) {
    await db
      .from("social_post_targets")
      .update({
        status: "failed",
        lease_expires_at: null,
        next_attempt_at: null,
        last_error_code: "processing_timeout",
        last_error_message:
          "The social network did not finish processing this post within 24 hours.",
      })
      .eq("id", target.id);
    await refreshSocialPostStatus(target.post_id);
    return;
  }
  const attempt = Number(target.attempt_count || 0) + (isStatusCheck ? 0 : 1);
  const started = Date.now();
  const { data: claimed, error: claimError } = await db
    .from("social_post_targets")
    .update({ status: "publishing", attempt_count: attempt })
    .eq("id", target.id)
    .eq("idempotency_key", message.idempotencyKey)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return;
  await db
    .from("social_publish_attempts")
    .insert({ target_id: target.id, attempt, outcome: "started" });
  try {
    const result = isStatusCheck
      ? await finishPendingPublish(target.provider, target.connection, target)
      : await publish(target.provider, target.connection, target.post, target);
    if (result.pending) {
      await db
        .from("social_post_targets")
        .update({
          status: "processing",
          remote_post_id: result.id,
          next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
          lease_expires_at: null,
          last_error_code: null,
          last_error_message: null,
        })
        .eq("id", target.id);
      await db.from("social_publish_attempts").insert({
        target_id: target.id,
        attempt,
        outcome: "submitted",
        duration_ms: Date.now() - started,
      });
      return;
    }
    await db
      .from("social_post_targets")
      .update({
        status: "published",
        remote_post_id: result.id,
        remote_post_url: result.url || null,
        published_at: new Date().toISOString(),
        next_attempt_at: null,
        lease_expires_at: null,
        last_error_code: null,
        last_error_message: null,
      })
      .eq("id", target.id);
    await db.from("social_publish_attempts").insert({
      target_id: target.id,
      attempt,
      outcome: "published",
      duration_ms: Date.now() - started,
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || /aborted|timeout/i.test(error.message));
    const providerError =
      error instanceof ProviderError
        ? error
        : timedOut
          ? new ProviderError(
              "Publishing timed out before the provider confirmed the result.",
              "outcome_unknown",
              false,
            )
          : new ProviderError("Publishing failed unexpectedly.", "unexpected", true);

    if (providerError.code === "outcome_unknown" || timedOut) {
      await db
        .from("social_post_targets")
        .update({
          status: "outcome_unknown",
          next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString(),
          lease_expires_at: null,
          last_error_code: "outcome_unknown",
          last_error_message: providerError.message,
          last_reconcile_at: new Date().toISOString(),
        })
        .eq("id", target.id);
      await db.from("social_publish_attempts").insert({
        target_id: target.id,
        attempt,
        outcome: "outcome_unknown",
        response_status: providerError.status || null,
        error_code: providerError.code,
        error_message: providerError.message,
        duration_ms: Date.now() - started,
      });
    } else {
      const canRetry = providerError.retryable && attempt < 5;
      await db
        .from("social_post_targets")
        .update({
          status: canRetry ? "retrying" : "failed",
          remote_post_id: canRetry
            ? tiktokRetryRemotePostId(
                target.provider,
                isStatusCheck,
                providerError.code,
                target.remote_post_id,
              )
            : target.remote_post_id,
          next_attempt_at: canRetry
            ? new Date(
                Date.now() +
                  socialRetryDelaySeconds(attempt, providerError.retryAfterSeconds) * 1_000,
              ).toISOString()
            : null,
          lease_expires_at: null,
          last_error_code: providerError.code,
          last_error_message: providerError.message,
        })
        .eq("id", target.id);
      await db.from("social_publish_attempts").insert({
        target_id: target.id,
        attempt,
        outcome: canRetry ? "retrying" : "failed",
        response_status: providerError.status || null,
        error_code: providerError.code,
        error_message: providerError.message,
        duration_ms: Date.now() - started,
      });
      if (!canRetry) {
        await notifySocialPublishFailure(target, providerError.message);
      }
    }
    if (providerError.status === 401 || providerError.code === "reconnect_required") {
      await db
        .from("social_connections")
        .update({ status: "expired", last_error: providerError.message })
        .eq("id", target.connection_id);
      await notifySocialConnectionExpired(target);
    }
  } finally {
    await refreshSocialPostStatus(target.post_id);
  }
}

async function refreshSocialPostStatus(postId: string) {
  const db = supabaseAdmin as any;
  const { data: targets } = await db
    .from("social_post_targets")
    .select("status")
    .eq("post_id", postId);
  const statuses = (targets || []).map((target: any) => target.status);
  if (!statuses.length) return;
  const status = deriveSocialPostStatus(statuses);
  if (!status) return;
  await db
    .from("social_posts")
    .update({
      status,
      ...(status === "published" ? { published_at: new Date().toISOString() } : {}),
    })
    .eq("id", postId);
}

async function creatorEmailForUser(userId: string) {
  const { data, error } = await (supabaseAdmin as any).auth.admin.getUserById(userId);
  if (error) return null;
  return data?.user?.email || null;
}

async function notifySocialPublishFailure(target: any, reason: string) {
  const email = await creatorEmailForUser(String(target.post.user_id));
  if (!email) return;
  const providerName =
    SOCIAL_PROVIDER_DEFINITIONS[target.provider as SocialProvider]?.name || target.provider;
  await enqueueEmail({
    eventKey: `social-publish-failed:${target.id}:${target.attempt_count || 0}`,
    eventType: "social_publish_failed",
    category: "transactional",
    recipientEmail: email,
    userId: target.post.user_id,
    payload: {
      provider: providerName,
      reason,
      schedulerUrl: "/post-scheduler",
    },
    immediate: true,
  });
}

async function notifySocialConnectionExpired(target: any) {
  const email = await creatorEmailForUser(String(target.post.user_id));
  if (!email) return;
  const providerName =
    SOCIAL_PROVIDER_DEFINITIONS[target.provider as SocialProvider]?.name || target.provider;
  await enqueueEmail({
    eventKey: `social-connection-expired:${target.connection_id}:${new Date().toISOString().slice(0, 10)}`,
    eventType: "social_connection_expired",
    category: "transactional",
    recipientEmail: email,
    userId: target.post.user_id,
    payload: {
      provider: providerName,
      schedulerUrl: "/post-scheduler",
    },
    immediate: true,
  });
}

export function socialPublishQueueBinding(provider: SocialProvider) {
  switch (provider) {
    case "instagram":
    case "facebook":
    case "threads":
      return "SOCIAL_PUBLISH_QUEUE_META";
    case "linkedin":
      return "SOCIAL_PUBLISH_QUEUE_LINKEDIN";
    case "twitter":
      return "SOCIAL_PUBLISH_QUEUE_X";
    case "tiktok":
      return "SOCIAL_PUBLISH_QUEUE_TIKTOK";
    case "youtube":
      return "SOCIAL_PUBLISH_QUEUE_YOUTUBE";
    case "reddit":
      return "SOCIAL_PUBLISH_QUEUE_REDDIT";
    default:
      return "SOCIAL_PUBLISH_QUEUE";
  }
}

function queueFromEnv(
  env: unknown,
  provider: SocialProvider,
): Queue<SocialPublishMessage> | undefined {
  const bindings = (env || {}) as Record<string, Queue<SocialPublishMessage> | undefined>;
  const binding = socialPublishQueueBinding(provider);
  return bindings[binding] || bindings.SOCIAL_PUBLISH_QUEUE;
}

export async function relaySocialOutbox(env?: unknown) {
  const db = supabaseAdmin as any;
  await db.rpc("repair_social_outbox_events");
  const { data, error } = await db.rpc("claim_social_outbox_events", {
    p_limit: 50,
    p_lease_seconds: 300,
  });
  if (error) throw error;
  const events = data || [];
  const delivered: string[] = [];
  for (const event of events) {
    const provider = String(event.provider) as SocialProvider;
    const queue = queueFromEnv(env ?? globalThis.__env__, provider);
    if (!queue) continue;
    try {
      await queue.send({
        kind: "social_publish",
        targetId: event.target_id,
        idempotencyKey: event.idempotency_key,
      });
      delivered.push(event.outbox_id);
    } catch (sendError) {
      await db
        .from("social_outbox_events")
        .update({
          status: "pending",
          available_at: new Date(Date.now() + 60_000).toISOString(),
          last_error: sendError instanceof Error ? sendError.message : "queue_send_failed",
        })
        .eq("id", event.outbox_id);
    }
  }
  if (delivered.length) {
    await db.rpc("mark_social_outbox_delivered", { p_outbox_ids: delivered });
  }
  return { claimed: events.length, delivered: delivered.length };
}

export async function auditSocialConnections(now = new Date()) {
  const db = supabaseAdmin as any;
  const refreshCutoff = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1_000).toISOString();
  const checkCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const { data, error } = await db
    .from("social_connections")
    .select(
      "id, user_id, provider, provider_user_id, access_token, refresh_token, token_expires_at, status, last_error",
    )
    .neq("provider", "instagram")
    .eq("status", "active")
    .or(`token_expires_at.lt.${refreshCutoff},token_expires_at.is.null`)
    .order("token_expires_at", { ascending: true, nullsFirst: true })
    .limit(40);
  if (error) throw new Error("Unable to load social connections for health checks.");

  const result = { checked: 0, refreshed: 0, expired: 0, skipped: 0 };
  for (const connection of data || []) {
    result.checked += 1;
    if (!connection.refresh_token) {
      if (
        connection.token_expires_at &&
        new Date(connection.token_expires_at).getTime() <= now.getTime()
      ) {
        await db
          .from("social_connections")
          .update({
            status: "expired",
            last_error: "This connection expired. Reconnect it from the scheduler.",
          })
          .eq("id", connection.id);
        result.expired += 1;
      } else {
        result.skipped += 1;
      }
      continue;
    }
    try {
      await accessTokenForConnection(connection);
      result.refreshed += 1;
    } catch (refreshError) {
      const message =
        refreshError instanceof Error
          ? refreshError.message
          : "This connection needs to be reconnected.";
      await db
        .from("social_connections")
        .update({ status: "expired", last_error: message })
        .eq("id", connection.id);
      result.expired += 1;
      const email = await creatorEmailForUser(String(connection.user_id));
      if (email) {
        await enqueueEmail({
          eventKey: `social-connection-expired:${connection.id}:${now.toISOString().slice(0, 10)}`,
          eventType: "social_connection_expired",
          category: "transactional",
          recipientEmail: email,
          userId: connection.user_id,
          payload: {
            provider:
              SOCIAL_PROVIDER_DEFINITIONS[connection.provider as SocialProvider]?.name ||
              connection.provider,
            schedulerUrl: "/post-scheduler",
          },
        });
      }
    }
  }
  void checkCutoff;
  return result;
}

export async function enqueueDueSocialPosts(queue?: Queue<SocialPublishMessage>, env?: unknown) {
  const runtimeEnv = env ?? globalThis.__env__;
  const outbox = await relaySocialOutbox(runtimeEnv);
  const bindings = (runtimeEnv || {}) as Record<string, Queue<SocialPublishMessage> | undefined>;
  if (!queue && !bindings.SOCIAL_PUBLISH_QUEUE) {
    return { configured: false, queued: 0, outbox };
  }
  const db = supabaseAdmin as any;
  const { data, error } = await db.rpc("claim_due_social_targets", {
    claim_limit: 50,
    lease_seconds: 300,
  });
  if (error) throw error;
  const targets = data || [];
  const released: string[] = [];
  for (const target of targets) {
    const { data: row } = await db
      .from("social_post_targets")
      .select("id, provider, idempotency_key")
      .eq("id", target.target_id)
      .maybeSingle();
    const provider = (row?.provider || "instagram") as SocialProvider;
    const providerQueue =
      queueFromEnv(runtimeEnv, provider) || (queue as Queue<SocialPublishMessage> | undefined);
    if (!providerQueue) {
      released.push(target.target_id);
      continue;
    }
    try {
      await providerQueue.send({
        kind: "social_publish",
        targetId: target.target_id,
        idempotencyKey: target.idempotency_key,
      });
    } catch {
      released.push(target.target_id);
    }
  }
  if (released.length) {
    await db.rpc("release_social_target_claims", { p_target_ids: released });
  }
  return { configured: true, queued: targets.length - released.length, outbox };
}
