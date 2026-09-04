import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { toPng } from "html-to-image";
import { Download, Copy, Share2 } from "lucide-react";
import { toast } from "sonner";
import { captureProductEvent } from "@/lib/posthog";
import { errorMessage, errorName } from "@/lib/errors";
import { publicProfileUrl } from "@/lib/application-urls";
import { BentoFullLogo, BentoIcon } from "@/components/BentoBrand";

type Props = {
  username: string;
  pageSlug?: string | null;
  joinedAt?: string | null;
  plan?: string;
  compact?: boolean;
  onShared?: () => void;
};

export function ShareCard({
  username,
  pageSlug,
  joinedAt,
  plan = "Free",
  compact = false,
  onShared,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [busy, setBusy] = useState<null | "download" | "copy" | "share">(null);

  const url = publicProfileUrl(username, pageSlug, import.meta.env.VITE_PUBLIC_URL);

  const formatJoined = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  };

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 512,
      color: { dark: "#0a0a0a", light: "#ffffff" },
    })
      .then((d) => {
        if (!cancelled) setQrDataUrl(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);

  async function generatePng(): Promise<Blob | null> {
    if (!cardRef.current) return null;
    const dataUrl = await toPng(cardRef.current, {
      pixelRatio: 3,
      cacheBust: true,
      backgroundColor: "#ffffff",
    });
    const res = await fetch(dataUrl);
    return await res.blob();
  }

  const message = `Check out my Bento: ${url}\n\nCreated with bento.surf.`;

  async function handleDownload() {
    try {
      setBusy("download");
      const blob = await generatePng();
      if (!blob) return;
      const a = document.createElement("a");
      const objectUrl = URL.createObjectURL(blob);
      a.href = objectUrl;
      a.download = `bento-${username}${pageSlug ? `-${pageSlug}` : ""}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
      onShared?.();
      toast.success("Share card downloaded");
    } catch (error: unknown) {
      toast.error(errorMessage(error, "Could not download"));
    } finally {
      setBusy(null);
    }
  }

  async function handleCopy() {
    try {
      setBusy("copy");
      const blob = await generatePng();
      if (!blob) return;
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      }
      try {
        await navigator.clipboard.writeText(message);
      } catch {
        // Image copy support varies by browser; the outer operation still succeeds.
      }
      captureProductEvent("share_link_copied", {
        method: "copy",
        has_page_slug: Boolean(pageSlug),
      });
      onShared?.();
      toast.success("Image & message copied");
    } catch (error: unknown) {
      // Fallback: copy just the text
      try {
        await navigator.clipboard.writeText(message);
        captureProductEvent("share_link_copied", {
          method: "copy_fallback",
          has_page_slug: Boolean(pageSlug),
        });
        onShared?.();
        toast.success("Message copied (image not supported in this browser)");
      } catch {
        toast.error(errorMessage(error, "Could not copy"));
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleShare() {
    try {
      setBusy("share");
      const blob = await generatePng();
      if (!blob) return;
      const file = new File([blob], `bento-${username}.png`, { type: "image/png" });
      const shareData: ShareData = { title: "My Bento", text: message, url };
      if (navigator.canShare?.({ files: [file] })) {
        shareData.files = [file];
      }
      if (navigator.share) {
        await navigator.share(shareData);
        onShared?.();
      } else {
        await handleCopy();
        toast.info("Sharing not supported here - copied instead");
      }
    } catch (error: unknown) {
      if (errorName(error) !== "AbortError") toast.error(errorMessage(error, "Could not share"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className={`@container ${compact ? "w-[300px] max-w-[calc(100vw-2rem)]" : "mt-4 w-full lg:w-[380px] lg:max-w-[calc(100vw-2rem)]"}`}
    >
      {/* Card - cqw units resolve against the @container wrapper above. */}
      <div
        ref={cardRef}
        className="relative flex aspect-[1.6/1] w-full flex-col justify-between overflow-hidden rounded-2xl border border-border bg-white p-[6cqw] text-left text-neutral-900 shadow-[0_10px_30px_-18px_rgba(0,0,0,0.25)]"
      >
        {/* Top row: logo left, meta right */}
        <div className="flex items-start justify-between gap-[3cqw]">
          <BentoIcon className="size-[clamp(24px,7cqw,34px)]" />
          <div className="text-right leading-tight">
            <div className="whitespace-nowrap text-[clamp(12px,3.4cqw,15px)] font-semibold lowercase tracking-[0.04em] text-neutral-900">
              bento.surf
            </div>
            {joinedAt && (
              <div className="mt-[0.8cqw] whitespace-nowrap text-[clamp(8px,2.4cqw,11px)] font-medium uppercase tracking-[0.14em] text-neutral-500">
                Since {formatJoined(joinedAt)}
              </div>
            )}
            <div className="mt-[0.4cqw] whitespace-nowrap text-[clamp(8px,2.4cqw,11px)] font-medium uppercase tracking-[0.14em] text-neutral-500">
              {plan} plan
            </div>
          </div>
        </div>

        {/* Bottom row: link bottom-left, QR bottom-right */}
        <div className="flex items-end justify-between gap-[3cqw]">
          <div className="min-w-0 flex-1 text-left">
            <BentoFullLogo className="h-[clamp(12px,3.2cqw,16px)] w-auto" />
            <div className="mt-[0.6cqw] truncate font-display text-[clamp(20px,8cqw,34px)] font-normal leading-[1] text-neutral-900">
              /{username}
              {pageSlug ? `/${pageSlug}` : ""}
            </div>
          </div>
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="QR code"
              className="aspect-square w-[clamp(72px,22cqw,92px)] shrink-0 rounded-md bg-white"
            />
          ) : (
            <div className="aspect-square w-[clamp(72px,22cqw,92px)] shrink-0 animate-pulse rounded-md bg-neutral-100" />
          )}
        </div>
      </div>

      {/* Actions */}
      {compact ? (
        <div className="mt-3 flex items-center justify-center gap-3">
          <CircleBtn label="Download" loading={busy === "download"} onClick={handleDownload}>
            <Download className="size-4" />
          </CircleBtn>
          <CircleBtn label="Copy" loading={busy === "copy"} onClick={handleCopy}>
            <Copy className="size-4" />
          </CircleBtn>
          <CircleBtn label="Share" loading={busy === "share"} onClick={handleShare}>
            <Share2 className="size-4" />
          </CircleBtn>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <ActionBtn
            icon={<Download className="size-3.5" />}
            label="Download"
            loading={busy === "download"}
            onClick={handleDownload}
          />
          <ActionBtn
            icon={<Copy className="size-3.5" />}
            label="Copy"
            loading={busy === "copy"}
            onClick={handleCopy}
          />
          <ActionBtn
            icon={<Share2 className="size-3.5" />}
            label="Share"
            loading={busy === "share"}
            onClick={handleShare}
          />
        </div>
      )}
    </div>
  );
}

function ActionBtn({
  icon,
  label,
  onClick,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-2 py-2 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-60"
    >
      {icon}
      {loading ? "…" : label}
    </button>
  );
}

function CircleBtn({
  children,
  label,
  onClick,
  loading,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      aria-label={label}
      title={label}
      className="inline-flex size-10 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-sm transition hover:bg-accent disabled:opacity-60"
    >
      {loading ? <span className="text-xs">…</span> : children}
    </button>
  );
}
