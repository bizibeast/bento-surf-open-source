import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Upload, X, Loader2 } from "lucide-react";
import { uploadFile } from "@/lib/upload";
import { getMyProfile } from "@/lib/profile.functions";
import { normalizePlan, planName, uploadLimitMb } from "@/lib/plans";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import { DecodedImage } from "@/components/DecodedImage";

type Kind = "image" | "video" | "audio" | "file" | "cover" | "avatar";

const ACCEPT: Record<Kind, string> = {
  image: "image/*",
  cover: "image/*",
  avatar: "image/*",
  video: "video/*",
  audio: "audio/*",
  file: "",
};

export function FileDropzone({
  kind,
  value,
  onChange,
  label,
  className = "",
  rounded = "2xl",
}: {
  kind: Kind;
  value?: string;
  onChange: (url: string) => void;
  label?: string;
  className?: string;
  rounded?: "xl" | "2xl" | "3xl" | "full";
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const { data: profile } = useQuery({ queryKey: ["my-profile"], queryFn: () => getMyProfile() });
  const plan = normalizePlan(
    (profile as { plan_id?: unknown } | null)?.plan_id,
    Boolean((profile as { is_pro?: boolean } | null)?.is_pro),
  );
  const maxMb = uploadLimitMb(kind, plan);

  const upload = async (file: File) => {
    if (!["avatar", "image", "cover"].includes(kind) && file.size > maxMb * 1024 * 1024) {
      toast.error(
        `File is larger than the ${maxMb} MB limit on ${planName(plan)}${plan === "store" ? "" : ". Upgrade for larger uploads"}`,
      );
      return;
    }
    setBusy(true);
    try {
      const publicUrl = await uploadFile(file, kind);
      onChange(publicUrl);
      toast.success("Uploaded");
    } catch (error: unknown) {
      toast.error(errorMessage(error, "Upload failed"));
    } finally {
      setBusy(false);
    }
  };

  const r = rounded === "full" ? "rounded-full" : `rounded-${rounded}`;

  return (
    <div className={className}>
      {label && <div className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</div>}
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f) upload(f);
        }}
        className={`group relative flex aspect-[3/2] cursor-pointer items-center justify-center overflow-hidden border-2 border-dashed transition ${r} ${
          drag ? "border-foreground bg-accent" : "border-border bg-muted/40 hover:bg-muted"
        }`}
      >
        {value ? (
          kind === "video" ? (
            <video src={value} className="size-full object-cover" muted />
          ) : kind === "audio" ? (
            <div className="flex size-full items-center justify-center bg-muted text-xs text-muted-foreground">
              Audio uploaded
            </div>
          ) : kind === "file" ? (
            <div className="flex size-full items-center justify-center bg-muted text-xs text-muted-foreground">
              File uploaded
            </div>
          ) : (
            <DecodedImage src={value} alt="" className="size-full object-cover" />
          )
        ) : busy ? (
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-muted-foreground">
            <Upload className="size-5" />
            <span className="text-xs">Drag & drop or click</span>
            <span className="text-[10px] opacity-70">Max {maxMb} MB</span>
          </div>
        )}
        {value && !busy && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
            className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-full bg-background/90 text-foreground shadow ring-1 ring-border opacity-0 transition group-hover:opacity-100"
            aria-label="Remove"
          >
            <X className="size-3.5" />
          </button>
        )}
        {busy && value && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60">
            <Loader2 className="size-6 animate-spin" />
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT[kind]}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
