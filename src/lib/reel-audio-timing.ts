/** User-selected times are relative to the beginning of the uploaded audio track. */
export function reelAudioTrackStart(
  firstTimestamp: number,
  endTimestamp: number,
  startSeconds = 0,
) {
  if (
    !Number.isFinite(startSeconds) ||
    startSeconds < 0 ||
    !Number.isFinite(firstTimestamp) ||
    !Number.isFinite(endTimestamp) ||
    endTimestamp <= firstTimestamp ||
    firstTimestamp + startSeconds >= endTimestamp
  ) {
    throw new Error("Choose an audio start time before the end of the track.");
  }
  return firstTimestamp + startSeconds;
}
