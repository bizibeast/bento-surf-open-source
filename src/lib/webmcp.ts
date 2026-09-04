import { useEffect, useRef, type FormEvent } from "react";

declare module "react" {
  interface FormHTMLAttributes<T> {
    toolname?: string;
    tooldescription?: string;
    toolautosubmit?: "" | "true";
  }

  interface InputHTMLAttributes<T> {
    toolparamdescription?: string;
  }

  interface SelectHTMLAttributes<T> {
    toolparamdescription?: string;
  }

  interface TextareaHTMLAttributes<T> {
    toolparamdescription?: string;
  }
}

export type WebMcpTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute(
    input: Record<string, unknown>,
    options: { signal: AbortSignal },
  ): unknown | Promise<unknown>;
};

type WebMcpJson = null | boolean | number | string | WebMcpJson[] | { [key: string]: WebMcpJson };

type WebMcpSubmitEvent = SubmitEvent & {
  readonly agentInvoked?: boolean;
  respondWith?(response: Promise<WebMcpJson>): void;
};

type WebMcpModelContext = {
  registerTool?(tool: WebMcpTool, options?: { signal?: AbortSignal }): Promise<void>;
};

export function webMcpResult(message: string, data: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: data,
  };
}

export function handleWebMcpFormSubmit<T extends WebMcpJson>(
  event: FormEvent<HTMLFormElement>,
  submit: () => T | Promise<T>,
) {
  event.preventDefault();
  const response = Promise.resolve().then(submit);
  const nativeEvent = event.nativeEvent as WebMcpSubmitEvent;
  if (nativeEvent.agentInvoked && typeof nativeEvent.respondWith === "function") {
    nativeEvent.respondWith(response);
  }
  return response;
}

export function bentoRemoteMcpSetup(client: string, endpoint: string) {
  if (client === "claude_code") return `claude mcp add --transport http bento ${endpoint}`;
  if (client === "codex") return `codex mcp add bento --url ${endpoint}`;
  if (client === "chatgpt" || client === "claude") return endpoint;
  return JSON.stringify({ mcpServers: { bento: { url: endpoint } } }, null, 2);
}

function showWebMcpConfirmation(action: string, preview: string) {
  if (
    typeof HTMLDialogElement === "undefined" ||
    typeof HTMLDialogElement.prototype.showModal !== "function"
  ) {
    return Promise.resolve(
      window.confirm(
        `Bento WebMCP request\n\n${action}${preview === "{}" ? "" : `\n\n${preview}`}\n\nChoose OK to approve this action.`,
      ),
    );
  }
  if (document.querySelector("[data-bento-webmcp-confirmation]")) {
    throw new Error("Another WebMCP action is awaiting confirmation.");
  }

  const dialog = document.createElement("dialog");
  dialog.dataset.bentoWebmcpConfirmation = "";
  dialog.setAttribute("aria-labelledby", "bento-webmcp-confirmation-title");
  dialog.style.cssText =
    "max-width:min(34rem,calc(100vw - 2rem));max-height:calc(100dvh - 2rem);overflow:auto;border:1px solid rgba(23,33,58,.12);border-radius:24px;padding:0;background:#fff;color:#17213a;box-shadow:0 30px 100px rgba(23,33,58,.28)";

  const content = document.createElement("div");
  content.style.cssText = "display:grid;gap:16px;padding:24px";

  const title = document.createElement("h2");
  title.id = "bento-webmcp-confirmation-title";
  title.textContent = "Approve Bento WebMCP request";
  title.style.cssText = "margin:0;font:600 24px/1.2 system-ui,sans-serif";

  const actionText = document.createElement("p");
  actionText.textContent = action;
  actionText.style.cssText = "margin:0;font:500 15px/1.5 system-ui,sans-serif";

  const details = document.createElement("pre");
  details.textContent = preview;
  details.style.cssText =
    "display:block;max-height:18rem;overflow:auto;margin:0;padding:14px;border-radius:14px;background:#f5f7fb;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace";

  const note = document.createElement("p");
  note.textContent = "Review the action above. Nothing runs unless you approve it.";
  note.style.cssText = "margin:0;color:#5f6778;font:13px/1.5 system-ui,sans-serif";

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;justify-content:flex-end;gap:10px";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.style.cssText =
    "border:1px solid rgba(23,33,58,.14);border-radius:999px;padding:10px 16px;background:#fff;color:#17213a;font:600 14px system-ui,sans-serif;cursor:pointer";
  const approve = document.createElement("button");
  approve.type = "button";
  approve.textContent = "Approve action";
  approve.style.cssText =
    "border:0;border-radius:999px;padding:10px 16px;background:#17213a;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer";
  actions.appendChild(cancel);
  actions.appendChild(approve);
  content.appendChild(title);
  content.appendChild(actionText);
  if (preview !== "{}") content.appendChild(details);
  content.appendChild(note);
  content.appendChild(actions);
  dialog.appendChild(content);
  document.body.appendChild(dialog);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      dialog.remove();
      resolve(approved);
    };
    cancel.addEventListener("click", () => finish(false), { once: true });
    approve.addEventListener("click", () => finish(true), { once: true });
    dialog.addEventListener(
      "cancel",
      (event) => {
        event.preventDefault();
        finish(false);
      },
      { once: true },
    );
    dialog.showModal();
    cancel.focus();
  });
}

export async function requireWebMcpUserConfirmation(
  action: string,
  input: Record<string, unknown> = {},
) {
  if (typeof window === "undefined") throw new Error("This action requires browser confirmation.");
  const priority = [
    "action",
    "mode",
    "id",
    "productId",
    "pageId",
    "connectionId",
    "grantId",
    "postId",
    "commentId",
    "contentId",
    "enabled",
    "status",
    "email",
  ];
  const orderedInput = Object.fromEntries(
    Object.entries(input).sort(
      ([left], [right]) =>
        (priority.indexOf(left) < 0 ? priority.length : priority.indexOf(left)) -
        (priority.indexOf(right) < 0 ? priority.length : priority.indexOf(right)),
    ),
  );
  const details = JSON.stringify(
    orderedInput,
    (key, value) => {
      if (/base64|password|secret|token/i.test(key)) return "[redacted]";
      if (typeof value === "string" && value.length > 240) return `${value.slice(0, 240)}…`;
      if (Array.isArray(value) && value.length > 10) return [...value.slice(0, 10), "…"];
      return value;
    },
    2,
  );
  const preview = details.length > 1_800 ? `${details.slice(0, 1_800)}\n…` : details;
  const approved = await showWebMcpConfirmation(action, preview);
  if (!approved) throw new Error("The user did not approve this WebMCP action.");
}

type PublicWebMcpPage = {
  name?: string | null;
  slug?: string | null;
  url?: string | null;
};

export async function openPublicCreatorPageFromWebMcp(
  input: Record<string, unknown>,
  pages: readonly PublicWebMcpPage[],
  signal: AbortSignal,
  openPage: (page: { name?: string | null; slug: string } | null) => unknown | Promise<unknown>,
) {
  signal.throwIfAborted();
  const slug = input.slug;
  const match =
    typeof slug === "string" && slug !== "home"
      ? pages.find((candidate) => !candidate.url && candidate.slug === slug)
      : null;
  if (slug !== "home" && !match) throw new Error("Choose a visible Bento page.");
  const page = match?.slug ? { name: match.name, slug: match.slug } : null;
  await requireWebMcpUserConfirmation("Open this public Bento page", {
    name: page?.name || "Home",
    slug: page?.slug || "home",
  });
  signal.throwIfAborted();
  await openPage(page);
  signal.throwIfAborted();
  return webMcpResult(`Opened ${page?.name || "Home"}.`, { slug: page?.slug || "home" });
}

export function safeWebMcpPathname(pathname: string) {
  return pathname.replace(
    /^\/(access|review|payments\/razorpay|library\/receipts)\/[^/]+/,
    "/$1/[redacted]",
  );
}

export function useWebMcpTools(tools: readonly WebMcpTool[]) {
  const latestToolsRef = useRef(tools);
  latestToolsRef.current = tools;
  const definitionSignature = JSON.stringify(
    tools.map(({ execute: _execute, ...definition }) => definition),
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const modelContext = (document as Document & { modelContext?: WebMcpModelContext })
      .modelContext;
    if (typeof modelContext?.registerTool !== "function") return;
    const registerTool = modelContext.registerTool.bind(modelContext);

    const controller = new AbortController();
    const definitions = JSON.parse(definitionSignature) as Array<Omit<WebMcpTool, "execute">>;
    void Promise.all(
      definitions.map((definition) =>
        registerTool(
          {
            ...definition,
            async execute(input, options) {
              const signal = options?.signal ?? new AbortController().signal;
              signal.throwIfAborted();
              const activeTool = latestToolsRef.current.find(
                (tool) => tool.name === definition.name,
              );
              if (!activeTool) throw new Error(`WebMCP tool ${definition.name} is unavailable.`);
              return activeTool.execute(input, { signal });
            },
          },
          { signal: controller.signal },
        ),
      ),
    ).catch((error) => {
      if (!controller.signal.aborted) console.error("[WebMCP] Tool registration failed.", error);
    });

    return () => controller.abort();
  }, [definitionSignature]);
}
