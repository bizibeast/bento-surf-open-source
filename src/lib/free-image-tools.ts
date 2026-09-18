export const socialImagePresets = [
  { id: "instagram-square", label: "Instagram square", width: 1080, height: 1080 },
  { id: "instagram-portrait", label: "Instagram portrait", width: 1080, height: 1350 },
  { id: "story-reel", label: "Story / Reel cover", width: 1080, height: 1920 },
  { id: "linkedin-landscape", label: "LinkedIn landscape", width: 1200, height: 627 },
  { id: "x-landscape", label: "X landscape", width: 1600, height: 900 },
  { id: "youtube-thumbnail", label: "YouTube thumbnail", width: 1280, height: 720 },
] as const;

export function coverSourceRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
) {
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;
  if (sourceRatio > targetRatio) {
    const width = sourceHeight * targetRatio;
    return { x: (sourceWidth - width) / 2, y: 0, width, height: sourceHeight };
  }
  const height = sourceWidth / targetRatio;
  return { x: 0, y: (sourceHeight - height) / 2, width: sourceWidth, height };
}

export function containDestinationRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
) {
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: (targetWidth - width) / 2, y: (targetHeight - height) / 2, width, height };
}
export const BACKGROUND_REMOVAL_API_PATH = "/api/tools/remove-background";
