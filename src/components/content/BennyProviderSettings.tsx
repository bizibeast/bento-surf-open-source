import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getBennyAiModels,
  removeBennyAiProvider,
  saveBennyAiProvider,
  updateBennyAiDefault,
  updateBennySearchKey,
} from "@/lib/benny-byok.functions";
import {
  bennyProviderKindLabels,
  type BennyModelOption,
  type BennyProvider,
  type BennyProviderKind,
  type BennyProviderPreferences,
} from "@/lib/benny-byok";

type BennyProviderFormProps = {
  preferences: BennyProviderPreferences;
  onChange: (defaultChanged?: boolean) => Promise<unknown>;
  searchConnected?: boolean;
  compatibleAvailable?: boolean;
};

export function BennyProviderSettings({
  onClose,
  ...props
}: BennyProviderFormProps & { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <div className="space-y-2">
          <DialogTitle>Benny AI providers</DialogTitle>
          <DialogDescription>Connect a model to use in Benny and Studio.</DialogDescription>
        </div>
        <BennyProviderForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

export function BennyProviderForm({
  preferences,
  onChange,
  searchConnected = false,
  compatibleAvailable = false,
}: BennyProviderFormProps) {
  const fieldId = useId();
  const [editing, setEditing] = useState<BennyProvider | null>(null);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [kind, setKind] = useState<BennyProviderKind>("openrouter");
  const [baseUrl, setBaseUrl] = useState("");
  const [otherModels, setOtherModels] = useState("");
  const [searchKey, setSearchKey] = useState("");
  const endpointChanged = Boolean(
    editing &&
    (kind !== (editing.provider_kind ?? "openrouter") ||
      (kind === "compatible" && baseUrl !== editing.base_url)),
  );
  const [models, setModels] = useState<BennyModelOption[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [makeDefault, setMakeDefault] = useState(() => preferences.providers.length === 0);

  function fill(provider: BennyProvider | null) {
    setEditing(provider);
    setName(provider?.name ?? "");
    setModel(provider?.model ?? "");
    setApiKey("");
    setKind(provider?.provider_kind ?? "openrouter");
    setBaseUrl(provider?.base_url ?? "");
    setOtherModels(provider?.additional_models?.join("\n") ?? "");
    setModels([]);
    setStatus("");
    setError("");
  }

  async function run(work: () => Promise<unknown>) {
    setPending(true);
    setError("");
    setStatus("");
    try {
      await work();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Benny provider settings could not be saved.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm leading-6 text-muted-foreground">
        Your selected provider receives the prompt and relevant creator context and bills your
        provider account. Bento encrypts your key. The connection is private to you in this
        workspace.
      </p>
      {preferences.providers.length > 0 && (
        <ul className="max-h-56 space-y-2 overflow-y-auto">
          {preferences.providers.map((provider) => (
            <li key={provider.id} className="rounded-lg border border-border p-3">
              <p className="truncate text-sm font-medium">{provider.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {bennyProviderKindLabels[provider.provider_kind ?? "openrouter"]} · {provider.model}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => fill(provider)}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending || preferences.defaultProviderId === provider.id}
                  onClick={() =>
                    void run(async () => {
                      await updateBennyAiDefault({ data: { id: provider.id } });
                      await onChange(true);
                    })
                  }
                >
                  {preferences.defaultProviderId === provider.id ? "Default" : "Set as default"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      await removeBennyAiProvider({ data: { id: provider.id } });
                      if (editing?.id === provider.id) fill(null);
                      await onChange();
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {preferences.defaultProviderId && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() =>
            void run(async () => {
              await updateBennyAiDefault({ data: { id: null } });
              await onChange(true);
            })
          }
        >
          Clear default model
        </Button>
      )}
      <form
        className="space-y-4 border-t border-border pt-5"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const saved = await saveBennyAiProvider({
              data: {
                id: editing?.id,
                name: name.trim() || bennyProviderKindLabels[kind],
                model,
                kind,
                ...(kind === "compatible" && baseUrl.trim() ? { baseUrl } : {}),
                additionalModels: otherModels
                  .split(/[\n,]/)
                  .map((value) => value.trim())
                  .filter(Boolean),
                ...(apiKey.trim() ? { apiKey } : {}),
              },
            });
            const shouldSetDefault = !editing && makeDefault;
            fill(null);
            setMakeDefault(false);
            try {
              if (shouldSetDefault) await updateBennyAiDefault({ data: { id: saved.id } });
            } catch {
              await onChange();
              setStatus("Connection saved. Select Set as default to use it automatically.");
              return;
            }
            await onChange(shouldSetDefault);
            setStatus(
              shouldSetDefault ? "Connection saved as your default model." : "Connection saved.",
            );
          });
        }}
      >
        <fieldset disabled={pending} className="space-y-4">
          <legend className="mb-3 text-sm font-semibold">
            {editing ? "Edit connection" : "Connect a model"}
          </legend>
          <div>
            <Label htmlFor={`${fieldId}-provider`}>Provider</Label>
            <select
              id={`${fieldId}-provider`}
              className="block h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as BennyProviderKind);
                setApiKey("");
                setModels([]);
              }}
            >
              {Object.entries(bennyProviderKindLabels)
                .filter(
                  ([value]) =>
                    value !== "compatible" || compatibleAvailable || kind === "compatible",
                )
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
          </div>
          {kind === "compatible" && (
            <div>
              <Label htmlFor={`${fieldId}-url`}>Approved API base URL</Label>
              <Input
                id={`${fieldId}-url`}
                type="url"
                required
                maxLength={300}
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setModels([]);
                }}
                placeholder="https://provider.example.com/v1/"
                autoComplete="off"
              />
            </div>
          )}
          <div>
            <Label htmlFor={`${fieldId}-key`}>{bennyProviderKindLabels[kind]} API key</Label>
            <Input
              id={`${fieldId}-key`}
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                setModels([]);
                setStatus("");
              }}
              type="password"
              maxLength={512}
              autoComplete="new-password"
              required={!editing || endpointChanged}
              placeholder={editing ? "Enter a new key to rotate it" : undefined}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!apiKey.trim() && (!editing || endpointChanged)}
            onClick={() =>
              void run(async () => {
                const list = await getBennyAiModels({
                  data: apiKey.trim()
                    ? {
                        apiKey,
                        kind,
                        ...(kind === "compatible" && baseUrl.trim() ? { baseUrl } : {}),
                      }
                    : { id: editing!.id },
                });
                setModels(list);
                setStatus("Connected. You can choose a model or enter an ID.");
              })
            }
          >
            Test key and load models
          </Button>
          <div>
            <Label htmlFor={`${fieldId}-model`}>Model ID</Label>
            <p id={`${fieldId}-model-help`} className="text-xs text-muted-foreground">
              Load the provider’s models above, or enter a model ID.
            </p>
            <Input
              aria-describedby={`${fieldId}-model-help`}
              id={`${fieldId}-model`}
              list={models.length ? `${fieldId}-models` : undefined}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              required
              maxLength={180}
              autoComplete="off"
              placeholder="provider/model"
            />
            <datalist id={`${fieldId}-models`}>
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.jsonMode ? " · JSON support" : ""}
                </option>
              ))}
            </datalist>
          </div>
          <details
            open={editing ? true : undefined}
            className="space-y-3 rounded-lg border border-border p-3"
          >
            <summary className="cursor-pointer text-sm font-medium">Connection options</summary>
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-name`}>Connection name (optional)</Label>
              <Input
                id={`${fieldId}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={60}
                placeholder={bennyProviderKindLabels[kind]}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-additional`}>Additional model IDs (optional)</Label>
              <textarea
                id={`${fieldId}-additional`}
                value={otherModels}
                onChange={(event) => setOtherModels(event.target.value)}
                rows={2}
                maxLength={1448}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder="One model ID per line, up to eight"
              />
            </div>
          </details>
          {!editing && (
            <Label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={makeDefault}
                onChange={(event) => setMakeDefault(event.target.checked)}
                className="size-4 accent-primary"
              />
              Use this as my default model in Benny and Studio
            </Label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              disabled={!model.trim() || ((!editing || endpointChanged) && !apiKey.trim())}
            >
              {editing ? "Save changes" : "Add connection"}
            </Button>
            {editing && (
              <Button type="button" variant="ghost" onClick={() => fill(null)}>
                Cancel edit
              </Button>
            )}
          </div>
        </fieldset>
      </form>
      <form
        className="space-y-2 border-t border-border pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await updateBennySearchKey({ data: { key: searchKey } });
            setSearchKey("");
            await onChange();
            setStatus("Brave Search key saved.");
          });
        }}
      >
        <Label htmlFor={`${fieldId}-search`}>Brave Search API key</Label>
        <p className="text-xs text-muted-foreground">
          Benny uses this key when you choose web search. Requests use your Brave account.
        </p>
        <Input
          id={`${fieldId}-search`}
          type="password"
          autoComplete="new-password"
          maxLength={512}
          value={searchKey}
          onChange={(event) => setSearchKey(event.target.value)}
          placeholder={searchConnected ? "Connected · enter a new key to rotate" : undefined}
          disabled={pending}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" variant="outline" disabled={pending || !searchKey.trim()}>
            Save search key
          </Button>
          {searchConnected && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await updateBennySearchKey({ data: { key: null } });
                  setSearchKey("");
                  await onChange();
                })
              }
            >
              Remove search key
            </Button>
          )}
        </div>
      </form>
      {status && (
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
