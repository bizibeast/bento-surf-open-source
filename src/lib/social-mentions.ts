import type { SocialProvider } from "./social-scheduler";

export type SocialMention = {
  provider: SocialProvider;
  id: string;
  name: string;
  handle: string | null;
  text: string;
  start: number;
  end: number;
  kind: "person" | "page" | "channel" | "handle";
  verified: boolean;
};

export type SocialMentionSuggestion = Pick<
  SocialMention,
  "provider" | "id" | "name" | "handle" | "kind" | "verified"
> & { avatarUrl?: string | null; detail?: string };

export function mentionQueryAtCursor(value: string, cursor: number, provider?: SocialProvider) {
  const prefix = value.slice(0, cursor);
  const match = /(^|[\s([{])@([\p{L}\p{N}_. -]{0,60})$/u.exec(prefix);
  if (!match) return null;
  const query = match[2].trim();
  if (
    (provider && !["facebook", "linkedin", "twitter"].includes(provider) && /\s/.test(query)) ||
    query.split(/\s+/).length > 4
  )
    return null;
  return { start: cursor - match[2].length - 1, end: cursor, query };
}

export function mentionVisibleText(suggestion: SocialMentionSuggestion) {
  if (suggestion.provider === "facebook" || suggestion.provider === "linkedin")
    return `@${suggestion.name}`;
  return `@${suggestion.handle || suggestion.name.replace(/^@/, "")}`;
}

export function insertSocialMention(
  value: string,
  range: { start: number; end: number },
  suggestion: SocialMentionSuggestion,
) {
  const text = mentionVisibleText(suggestion);
  const next = `${value.slice(0, range.start)}${text}${value.slice(range.end)}`;
  return {
    value: next,
    cursor: range.start + text.length,
    mention: {
      provider: suggestion.provider,
      id: suggestion.id,
      name: suggestion.name,
      handle: suggestion.handle,
      text,
      start: range.start,
      end: range.start + text.length,
      kind: suggestion.kind,
      verified: suggestion.verified,
    } satisfies SocialMention,
  };
}

/** Keep untouched tags attached to their text as users edit nearby copy. */
export function remapSocialMentions(
  before: string,
  after: string,
  mentions: readonly SocialMention[],
): SocialMention[] {
  if (before === after) return [...mentions];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const delta = newEnd - oldEnd;
  return mentions.flatMap((mention) => {
    const moved =
      mention.end <= start
        ? mention
        : mention.start >= oldEnd
          ? { ...mention, start: mention.start + delta, end: mention.end + delta }
          : null;
    if (moved && after.slice(moved.start, moved.end) === moved.text) return [moved];
    const found = after.indexOf(mention.text);
    if (found >= 0 && after.indexOf(mention.text, found + 1) < 0)
      return [{ ...mention, start: found, end: found + mention.text.length }];
    return [];
  });
}

export function validSocialMentions(
  body: string,
  provider: SocialProvider,
  input: unknown,
): SocialMention[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 20).flatMap((item): SocialMention[] => {
    if (!item || typeof item !== "object") return [];
    const mention = item as Partial<SocialMention>;
    if (
      mention.provider !== provider ||
      typeof mention.id !== "string" ||
      mention.id.length > 150 ||
      typeof mention.name !== "string" ||
      mention.name.length > 150 ||
      typeof mention.text !== "string" ||
      mention.text.length > 160 ||
      !Number.isInteger(mention.start) ||
      !Number.isInteger(mention.end) ||
      typeof mention.start !== "number" ||
      typeof mention.end !== "number" ||
      mention.start < 0 ||
      mention.end > body.length ||
      mention.end <= mention.start ||
      body.slice(mention.start, mention.end) !== mention.text
    )
      return [];
    return [
      {
        provider,
        id: mention.id,
        name: mention.name,
        handle: typeof mention.handle === "string" ? mention.handle : null,
        text: mention.text,
        start: mention.start,
        end: mention.end,
        kind:
          mention.kind === "page" || mention.kind === "channel" || mention.kind === "person"
            ? mention.kind
            : "handle",
        verified: mention.verified === true,
      },
    ];
  });
}

/** Graph Page IDs and LinkedIn URNs need a publishing form distinct from the editor label. */
export function renderSocialMentions(body: string, provider: SocialProvider, input: unknown) {
  const mentions = validSocialMentions(body, provider, input)
    .filter((mention) => mention.verified)
    .sort((a, b) => b.start - a.start);
  let rendered = body;
  let rightEdge = body.length;
  for (const mention of mentions) {
    if (mention.end > rightEdge) continue;
    let replacement: string | null = null;
    if (provider === "facebook" && mention.kind === "page" && /^\d{1,30}$/.test(mention.id))
      replacement = `@[${mention.id}]`;
    if (
      provider === "linkedin" &&
      /^urn:li:(?:person|organization):[A-Za-z0-9_-]{1,100}$/.test(mention.id) &&
      !["[", "]", "(", ")", "\r", "\n"].some((char) => mention.name.includes(char))
    )
      replacement = `@[${mention.name}](${mention.id})`;
    if (replacement) {
      rendered = `${rendered.slice(0, mention.start)}${replacement}${rendered.slice(mention.end)}`;
      rightEdge = mention.start;
    }
  }
  return rendered;
}
