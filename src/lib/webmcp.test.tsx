import { fireEvent, renderHook, screen } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bentoRemoteMcpSetup,
  handleWebMcpFormSubmit,
  requireWebMcpUserConfirmation,
  safeWebMcpPathname,
  useWebMcpTools,
  webMcpResult,
  type WebMcpTool,
} from "./webmcp";

function formEvent(nativeEvent: Event): Parameters<typeof handleWebMcpFormSubmit>[0] {
  return {
    nativeEvent,
    preventDefault: vi.fn(),
  } as unknown as Parameters<typeof handleWebMcpFormSubmit>[0];
}

describe("requireWebMcpUserConfirmation", () => {
  it("uses an in-page dialog for cancellation and approval when supported", async () => {
    const originalShowModal = Object.getOwnPropertyDescriptor(
      HTMLDialogElement.prototype,
      "showModal",
    );
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
    const nativeConfirm = vi.spyOn(window, "confirm");

    try {
      const denied = requireWebMcpUserConfirmation("Publish this item", {
        id: "item-1",
        token: "private-token",
      });
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText(/\[redacted\]/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await expect(denied).rejects.toThrow("did not approve");

      const approved = requireWebMcpUserConfirmation("Open this workspace");
      fireEvent.click(screen.getByRole("button", { name: "Approve action" }));
      await expect(approved).resolves.toBeUndefined();
      expect(nativeConfirm).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
      nativeConfirm.mockRestore();
      if (originalShowModal) {
        Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
      } else {
        delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
      }
    }
  });
});

describe("handleWebMcpFormSubmit", () => {
  it("synchronously gives an agent-invoked submit a serializable response promise", async () => {
    const respondWith = vi.fn();
    const nativeEvent = Object.assign(new SubmitEvent("submit"), {
      agentInvoked: true,
      respondWith,
    });
    const event = formEvent(nativeEvent);
    const submit = vi.fn(() => ({ ok: true, message: "Search opened." }));

    const response = handleWebMcpFormSubmit(event, submit);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(respondWith).toHaveBeenCalledWith(response);
    expect(submit).not.toHaveBeenCalled();
    expect(JSON.stringify(await response)).toBe('{"ok":true,"message":"Search opened."}');
    expect(submit).toHaveBeenCalledOnce();
  });

  it("runs an ordinary UI submit without responding to an agent", async () => {
    const respondWith = vi.fn();
    const event = formEvent(
      Object.assign(new SubmitEvent("submit"), { agentInvoked: false, respondWith }),
    );

    await expect(
      handleWebMcpFormSubmit(event, () => ({ ok: true, message: "Submitted." })),
    ).resolves.toEqual({ ok: true, message: "Submitted." });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(respondWith).not.toHaveBeenCalled();
  });

  it("passes an agent-invoked submission failure through the response promise", async () => {
    const respondWith = vi.fn();
    const event = formEvent(
      Object.assign(new SubmitEvent("submit"), { agentInvoked: true, respondWith }),
    );

    const response = handleWebMcpFormSubmit(event, () => {
      throw new Error("Submission failed.");
    });

    expect(respondWith).toHaveBeenCalledWith(response);
    await expect(response).rejects.toThrow("Submission failed.");
  });
});

describe("useWebMcpTools", () => {
  afterEach(() => {
    delete (document as Document & { modelContext?: unknown }).modelContext;
  });

  it("registers tools and unregisters them when the owner unmounts", () => {
    const registerTool = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: { registerTool },
    });
    const tool: WebMcpTool = {
      name: "test_tool",
      description: "Test tool",
      execute: () => webMcpResult("Done."),
    };

    const { unmount } = renderHook(() => {
      const tools = useMemo(() => [tool], []);
      useWebMcpTools(tools);
    });

    expect(registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: tool.name, description: tool.description }),
      { signal: expect.any(AbortSignal) },
    );
    const signal = registerTool.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("does nothing in browsers without WebMCP", () => {
    expect(() => renderHook(() => useWebMcpTools([]))).not.toThrow();
  });

  it("does nothing when modelContext does not implement registerTool", () => {
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {},
    });

    expect(() => renderHook(() => useWebMcpTools([]))).not.toThrow();
  });

  it("keeps registrations stable while invoking the latest callback", async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: { registerTool },
    });
    const first = vi.fn(() => webMcpResult("First."));
    const second = vi.fn(() => webMcpResult("Second."));
    const { rerender } = renderHook(
      ({ execute }: { execute: WebMcpTool["execute"] }) =>
        useWebMcpTools([{ name: "live_tool", description: "Live tool", execute }]),
      { initialProps: { execute: first } },
    );
    rerender({ execute: second });

    expect(registerTool).toHaveBeenCalledOnce();
    const registered = registerTool.mock.calls[0][0] as WebMcpTool;
    await registered.execute({}, undefined as never);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("stops a pre-aborted invocation before the active tool runs", async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: { registerTool },
    });
    const execute = vi.fn(() => webMcpResult("Should not run."));
    renderHook(() =>
      useWebMcpTools([{ name: "abortable_tool", description: "Abortable tool", execute }]),
    );
    const registered = registerTool.mock.calls[0][0] as WebMcpTool;
    const controller = new AbortController();
    controller.abort();

    await expect(registered.execute({}, { signal: controller.signal })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("safeWebMcpPathname", () => {
  it.each([
    ["/access/access-token", "/access/[redacted]"],
    ["/review/review-token/details", "/review/[redacted]/details"],
    ["/payments/razorpay/session-secret", "/payments/razorpay/[redacted]"],
    ["/library/receipts/receipt-secret", "/library/receipts/[redacted]"],
    ["/home", "/home"],
  ])("redacts sensitive routes in %s", (pathname, expected) => {
    expect(safeWebMcpPathname(pathname)).toBe(expected);
  });
});

describe("Bento remote MCP setup", () => {
  it("returns the Codex Streamable HTTP command", () => {
    expect(bentoRemoteMcpSetup("codex", "https://mcp.bento.surf/mcp")).toBe(
      "codex mcp add bento --url https://mcp.bento.surf/mcp",
    );
  });
});
