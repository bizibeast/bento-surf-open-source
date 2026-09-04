export function SizePresetIcon({ w, h }: { w: number; h: number }) {
  const max = 16;
  const width = Math.min((w / 8) * max, max);
  const height = Math.min((h / 8) * max, max);
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect
        x={(20 - width) / 2}
        y={(20 - height) / 2}
        width={width}
        height={height}
        rx={Math.min(3, width / 2, height / 2)}
        fill="currentColor"
      />
    </svg>
  );
}
