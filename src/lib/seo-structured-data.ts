export type JsonLd = Record<string, unknown>;

export function jsonLdScript(schema: JsonLd) {
  return {
    type: "application/ld+json",
    children: JSON.stringify(schema).replace(/</g, "\\u003c"),
  };
}
