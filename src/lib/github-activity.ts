export function githubActivityWeekCount(width: number, height: number) {
  // Keep the calendar dense enough to read as GitHub activity while leaving
  // each day large enough to feel intentional at Bento's supported sizes.
  if (width >= 4 && height <= 2) return 28;
  if (width >= 4) return 48;
  if (width >= 3) return 35;
  return 21;
}
