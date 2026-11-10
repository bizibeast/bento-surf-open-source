/** Stable selection keeps webhook retries from changing the message a person receives. */
export function selectAutoDmMessage(
  messages: readonly string[] | null | undefined,
  fallback: string,
  eventKey: string,
): string {
  const choices = (messages || []).map((message) => message.trim()).filter(Boolean);
  if (!choices.length) return fallback;
  let hash = 0;
  for (const character of eventKey) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return choices[hash % choices.length];
}

export function hasAutoDmTextLink(messages: readonly string[]) {
  return messages.some((message) => /(?:https?:\/\/|www\.)\S+/i.test(message));
}

const recipientNameToken = /\{\{(?:name|first_name)\}\}/gi;

export function hasAutoDmNameToken(messages: readonly (string | null | undefined)[]) {
  return messages.some((message) => message && /\{\{(?:name|first_name)\}\}/i.test(message));
}

/** Meta may omit a profile name; templates should read naturally with "there". */
export function personalizeAutoDmText(text: string, recipientName: string | null | undefined) {
  const candidate = recipientName
    ?.normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}{}<>]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const safeName =
    candidate && candidate.length <= 80 && !/(?:https?:\/\/|www\.)\S+/i.test(candidate)
      ? candidate.split(" ")[0].slice(0, 40)
      : null;
  return text.replace(recipientNameToken, safeName || "there");
}

/** Legacy copy may contain a URL; move its first secure URL to the supported button. */
export function autoDmLinkButton(
  text: string,
  configuredUrl: string | null | undefined,
  configuredLabel: string | null | undefined,
) {
  const linkPattern = /(?:https?:\/\/|www\.)[^\s]+/gi;
  const links = text.match(linkPattern) || [];
  const secureLink = links
    .map((link) => link.replace(/[.,!?;:)\]]+$/, ""))
    .map((link) => (link.startsWith("www.") ? `https://${link}` : link))
    .find((link) => link.startsWith("https://"));
  const url = configuredUrl || secureLink || null;
  return {
    text: text
      .replace(linkPattern, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    url: url?.startsWith("https://") ? url : null,
    label: configuredLabel || "Open link",
  };
}
