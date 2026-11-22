import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BennyMemory as Memory } from "./BennyMemory";
import { ContentBrain } from "./ContentBrain";
import { contentProfileSchema } from "@/lib/content-brain";
import type { ComponentProps, ReactElement } from "react";
function BennyMemory({
  children,
  ...props
}: Omit<ComponentProps<typeof Memory>, "children"> & {
  children: ReactElement<{ children: string }>;
}) {
  return (
    <Memory {...props}>
      {(panels, initialSection) => (
        <ContentBrain
          profile={contentProfileSchema.parse({})}
          items={props.items}
          sources={[]}
          panels={panels}
          initialSection={initialSection}
          humanSummary={children.props.children}
          onSaveItem={props.onSave}
          onSaveProfile={vi.fn()}
          onConfirm={vi.fn()}
          onLock={vi.fn()}
          onDelete={vi.fn()}
          onUpload={vi.fn()}
        />
      )}
    </Memory>
  );
}
import { BENNY_EDITING_PLAYBOOKS, editingPlaybookMemory } from "@/lib/benny-editing-playbooks";
import type { BrainItem } from "@/lib/content-brain";

describe("Benny creative memory", () => {
  it("saves a creator-confirmed editing style through the existing memory API", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <BennyMemory items={[]} onSave={save} onOpenProjects={vi.fn()} onOpenBranding={vi.fn()}>
        <p>Existing creator memory</p>
      </BennyMemory>,
    );
    expect(screen.getByText("Existing creator memory")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Styles & avatars" }));
    await user.click(screen.getByRole("button", { name: "Add preference" }));
    await user.type(screen.getByLabelText("Name"), "My educational Reels");
    await user.selectOptions(screen.getByLabelText("Preference type"), "reel");
    await user.type(
      screen.getByLabelText("Editing instructions"),
      "Use readable captions and calm pacing.",
    );
    await user.click(screen.getByRole("button", { name: "Save preference" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        kind: "instruction",
        title: "My educational Reels",
        content: "Use readable captions and calm pacing.",
        provenance: "creator",
        status: "confirmed",
        locked: false,
        tags: ["creative-preference", "reel"],
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Saved to Benny");
  });

  it("reopens styles and avatars without creating a duplicate record", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const item = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "instruction" as const,
      title: "My avatar",
      content: "Use my authorized avatar in the opening scene.",
      provenance: "creator" as const,
      status: "confirmed" as const,
      locked: false,
      tags: ["creative-preference", "avatar"],
      sourceUrl: null,
      sourceRef: null,
      createdAt: "",
      updatedAt: "",
    };
    render(
      <BennyMemory items={[item]} onSave={save} onOpenProjects={vi.fn()} onOpenBranding={vi.fn()}>
        <p>Memory</p>
      </BennyMemory>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Styles & avatars" }));
    fireEvent.click(screen.getByRole("button", { name: /My avatar/ }));
    expect(screen.getByLabelText("Preference type")).toHaveValue("avatar");
    expect(screen.getByLabelText("Avatar, voice & usage preferences")).toHaveValue(item.content);
    fireEvent.click(screen.getByRole("button", { name: "Save preference" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: item.id })),
    );
  });
});

it("keeps assistant preferences inside the Memory sections", async () => {
  const user = userEvent.setup();
  render(
    <BennyMemory
      items={[]}
      onSave={vi.fn()}
      onOpenProjects={vi.fn()}
      preferencesPanel={<p>Existing assistant preferences</p>}
    >
      <p>Creator knowledge</p>
    </BennyMemory>,
  );
  await user.click(screen.getByRole("button", { name: "Preferences" }));
  expect(screen.getByText("Existing assistant preferences")).toBeVisible();
  expect(screen.queryByText("Creator knowledge")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "About You" }));
  expect(screen.getByText("Creator knowledge")).toBeVisible();
});

it("saves a playbook and edits an existing customization without making another record", async () => {
  const user = userEvent.setup();
  const save = vi.fn().mockResolvedValue(undefined);
  const values = { onSave: save, onOpenProjects: vi.fn() };
  const view = render(
    <BennyMemory {...values} items={[]}>
      <p>Knowledge</p>
    </BennyMemory>,
  );
  await user.click(screen.getByRole("button", { name: "Styles & avatars" }));
  await user.click(screen.getByRole("button", { name: "Preferences" }));
  await user.click(screen.getByRole("button", { name: "Save Doodle" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(editingPlaybookMemory(BENNY_EDITING_PLAYBOOKS[0])),
  );
  const stored = editingPlaybookMemory(BENNY_EDITING_PLAYBOOKS[0]);
  const item: BrainItem = {
    ...stored,
    id: "11111111-1111-4111-8111-111111111111",
    content: "Use my quiet, minimal illustrations.",
    sourceRef: stored.sourceRef ?? null,
    sourceUrl: null,
    createdAt: "",
    updatedAt: "",
  };
  save.mockClear();
  view.rerender(
    <BennyMemory {...values} items={[item]}>
      <p>Knowledge</p>
    </BennyMemory>,
  );
  await user.click(screen.getByRole("button", { name: "Customize Doodle" }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Editing instructions")).toHaveValue(item.content);
  await user.click(screen.getByRole("button", { name: "Save preference" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: item.id,
        content: item.content,
        sourceRef: item.sourceRef,
        tags: expect.arrayContaining(["creative-preference", "reel", "playbook:doodle"]),
      }),
    ),
  );
});
