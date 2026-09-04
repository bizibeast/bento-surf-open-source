export type UnicodeTextStyle = "normal" | "bold" | "italic" | "bold-italic";

const ranges = {
  bold: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
  italic: { upper: 0x1d434, lower: 0x1d44e },
  "bold-italic": { upper: 0x1d468, lower: 0x1d482, digit: 0x1d7ce },
} as const;

export function stylizeUnicodeText(text: string, style: UnicodeTextStyle) {
  if (style === "normal") return text;
  const range = ranges[style];
  return Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 65 && code <= 90) return String.fromCodePoint(range.upper + code - 65);
    if (code >= 97 && code <= 122) {
      if (style === "italic" && character === "h") return "ℎ";
      return String.fromCodePoint(range.lower + code - 97);
    }
    if (code >= 48 && code <= 57 && "digit" in range) {
      return String.fromCodePoint(range.digit + code - 48);
    }
    return character;
  }).join("");
}

export function splitThreadText(text: string, numbered = true, limit = 280) {
  // ponytail: reserve supports up to 99 posts; add iterative suffix sizing if longer threads matter.
  const contentLimit = numbered ? limit - 8 : limit;
  const words = text.trim().split(/\s+/).filter(Boolean);
  const posts: string[] = [];
  let current = "";

  for (const word of words) {
    if (Array.from(word).length > contentLimit) {
      if (current) posts.push(current);
      const characters = Array.from(word);
      while (characters.length > contentLimit)
        posts.push(characters.splice(0, contentLimit).join(""));
      current = characters.join("");
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (Array.from(candidate).length <= contentLimit) current = candidate;
    else {
      posts.push(current);
      current = word;
    }
  }
  if (current) posts.push(current);
  if (!numbered) return posts;
  return posts.map((post, index) => `${post} (${index + 1}/${posts.length})`);
}
