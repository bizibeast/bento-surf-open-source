import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import type { StudioMedia } from "@/lib/content-studio";

export function StudioLabel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="studio-label">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function StudioInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className="content-field studio-field" />;
}

export function StudioTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className="content-field studio-field" />;
}

export function StudioSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className="content-field studio-field" />;
}

export function StudioMediaPicker({
  assets,
  value,
  onChange,
  label,
  kind,
}: {
  assets: StudioMedia[];
  value?: string | null;
  onChange: (id: string | null) => void;
  label: string;
  kind?: StudioMedia["kind"];
}) {
  const choices = kind ? assets.filter((asset) => asset.kind === kind) : assets;
  return (
    <StudioLabel label={label}>
      <StudioSelect value={value || ""} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">Choose from Media</option>
        {value && !choices.some((asset) => asset.id === value) && (
          <option value={value}>Unavailable media</option>
        )}
        {choices.map((asset) => (
          <option value={asset.id} key={asset.id}>
            {asset.name} · {asset.kind}
          </option>
        ))}
      </StudioSelect>
    </StudioLabel>
  );
}

export function StudioOrder({
  item,
  index,
  count,
  min,
  onMove,
  onRemove,
}: {
  item: string;
  index: number;
  count: number;
  min: number;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="studio-actions studio-order">
      <button
        className="content-action"
        type="button"
        aria-label={`Move ${item} earlier`}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUp size={16} />
      </button>
      <button
        className="content-action"
        type="button"
        aria-label={`Move ${item} later`}
        disabled={index + 1 === count}
        onClick={() => onMove(1)}
      >
        <ArrowDown size={16} />
      </button>
      <button
        className="content-action"
        type="button"
        aria-label={`Remove ${item}`}
        disabled={count <= min}
        onClick={onRemove}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
