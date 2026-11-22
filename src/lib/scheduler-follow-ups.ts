import { z } from "zod";
import twitterText from "twitter-text";
import { X_STANDARD_POST_LIMIT, xPostTextLength } from "./x-account";

export const X_THREAD_MAX_POSTS = 25;
export const LINKEDIN_FIRST_COMMENT_LIMIT = 1_250;
export const LINKEDIN_COMMENT_SCOPE = "w_member_social_feed";
export const xThreadRepliesSchema = z.array(z.string().max(25_000)).max(X_THREAD_MAX_POSTS - 1);
export const linkedInFirstCommentSchema = z.string().max(LINKEDIN_FIRST_COMMENT_LIMIT);

export function xThreadReplies(settings: Record<string, unknown>): string[] | null {
  if (settings.threadReplies == null) return null;
  const result = xThreadRepliesSchema.safeParse(settings.threadReplies);
  return result.success ? result.data : null;
}

export function xThreadError(body: string, settings: Record<string, unknown>): string | null {
  if (settings.threadReplies == null) return null;
  const replies = xThreadReplies(settings);
  if (!replies) return "X threads support up to 25 posts with text in each part.";
  if (settings.kind === "article") return "X Articles cannot be published as threads.";
  if (!replies.length) return "Add a reply to create an X thread.";
  const parts = [body, ...replies];
  for (let index = 0; index < parts.length; index++) {
    if (!parts[index].trim()) return `Add text to thread post ${index + 1}.`;
    if (xPostTextLength(parts[index]) > X_STANDARD_POST_LIMIT)
      return `Thread post ${index + 1} allows 280 characters. Split or shorten this part.`;
  }
  return null;
}

export function linkedInFirstCommentError(settings: Record<string, unknown>): string | null {
  if (settings.firstComment == null) return null;
  return linkedInFirstCommentSchema.safeParse(settings.firstComment).success
    ? null
    : "LinkedIn first comments allow 1,250 characters.";
}

/** Greedy weighted split, keeping URL entities and Unicode graphemes whole. */
export function splitXThread(text: string): string[] {
  if (!text.trim()) return [];
  if (text.length > 25_000) throw new Error("Split up to 25,000 characters at a time.");
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const atoms: string[] = [];
  let cursor = 0;
  const appendText = (value: string) => {
    for (const entry of segmenter.segment(value)) atoms.push(entry.segment);
  };
  for (const url of twitterText.extractUrlsWithIndices(text)) {
    appendText(text.slice(cursor, url.indices[0]));
    atoms.push(text.slice(url.indices[0], url.indices[1]));
    cursor = url.indices[1];
  }
  appendText(text.slice(cursor));
  const parts: string[] = [];
  let start = 0;
  while (start < atoms.length) {
    while (start < atoms.length && /^\s+$/u.test(atoms[start])) start++;
    if (start === atoms.length) break;
    let low = start;
    let high = atoms.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (xPostTextLength(atoms.slice(start, middle).join("")) <= X_STANDARD_POST_LIMIT)
        low = middle;
      else high = middle - 1;
    }
    if (low === start) throw new Error("A text segment cannot fit in an X post.");
    let end = low;
    // Prefer a word boundary, unless this is an unbroken word or the last part.
    if (end < atoms.length && !/^\s+$/u.test(atoms[end])) {
      for (let index = end - 1; index > start; index--) {
        if (/^\s+$/u.test(atoms[index])) {
          end = index;
          break;
        }
      }
    }
    parts.push(atoms.slice(start, end).join("").trim());
    if (parts.length > X_THREAD_MAX_POSTS) throw new Error("X threads support up to 25 posts.");
    start = end;
  }
  return parts;
}
