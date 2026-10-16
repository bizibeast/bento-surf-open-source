import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { SchedulerRewrite } from "./SchedulerRewrite";
import type { SchedulerConnection } from "@/lib/social-scheduler";
const rewrite = vi.hoisted(() => vi.fn());
vi.mock("@/lib/scheduler-assist.functions", () => ({ rewriteSchedulerText: rewrite }));
const connection: SchedulerConnection = {
  id: "account",
  provider: "linkedin",
  handle: "alex",
  displayName: "Alex",
  avatarUrl: null,
  status: "active",
  connectedAt: "",
  canPublish: true,
  publishBlockReason: null,
};
beforeEach(() => rewrite.mockResolvedValue({ body: "A more useful post." }));
it("requires review before applying a network rewrite", async () => {
  const onApply = vi.fn();
  render(<SchedulerRewrite connection={connection} body="My original copy." onApply={onApply} />);
  fireEvent.click(screen.getByRole("button", { name: "Rewrite for LinkedIn" }));
  expect(await screen.findByText("A more useful post.")).toBeVisible();
  expect(onApply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use this version" }));
  expect(onApply).toHaveBeenCalledWith("A more useful post.");
});
it("protects edits made while the rewrite was running", async () => {
  const onApply = vi.fn();
  const view = render(
    <SchedulerRewrite connection={connection} body="My original copy." onApply={onApply} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Rewrite for LinkedIn" }));
  await screen.findByText("A more useful post.");
  view.rerender(
    <SchedulerRewrite connection={connection} body="A newer version I wrote." onApply={onApply} />,
  );
  expect(screen.getByRole("button", { name: "Use this version" })).toBeDisabled();
  expect(onApply).not.toHaveBeenCalled();
});
