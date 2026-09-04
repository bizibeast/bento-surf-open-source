export function onboardingSocialBlock(platform: string, handle: string) {
  return {
    type: "social_link" as const,
    content: { platform, handle: handle.trim() },
    w: 2,
    h: 2,
  };
}
