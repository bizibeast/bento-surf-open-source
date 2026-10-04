import { useState, type FormEvent } from "react";
import { beginAdditionalWorkspaceCheckout } from "@/lib/billing.functions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function AddWorkspaceDialog({
  open,
  onOpenChange,
  onCheckout = (url) => window.location.assign(url),
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCheckout?: (url: string) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await beginAdditionalWorkspaceCheckout({
        data: { displayName, username },
      });
      onCheckout(result.checkoutUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start checkout.");
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-[24px]">
        <DialogHeader>
          <DialogTitle>Add another profile</DialogTitle>
          <DialogDescription>
            This creates a separate Bento workspace with its own subscription and data.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <label className="grid gap-1.5 text-sm font-medium">
            Profile name
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              maxLength={60}
              className="h-10 rounded-lg border border-border bg-background px-3"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Username
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value.toLowerCase())}
              required
              minLength={3}
              maxLength={24}
              pattern="[a-z0-9_]+"
              className="h-10 rounded-lg border border-border bg-background px-3"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="h-10 w-full rounded-lg bg-[#17213a] px-4 text-sm font-medium text-white disabled:opacity-60"
          >
            {submitting ? "Opening checkout…" : "Continue to payment"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
