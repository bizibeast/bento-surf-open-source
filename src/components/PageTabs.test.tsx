import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PageTabs } from "./PageTabs";

describe("PageTabs system pages", () => {
  it("offers Calendar and social stats from the profile add button", () => {
    const onCreateCalendar = vi.fn();
    const onCreateInsights = vi.fn();
    render(
      <PageTabs
        pages={[]}
        activeId={null}
        mode="editor"
        onSelect={() => undefined}
        onCreateCalendar={onCreateCalendar}
        onCreateInsights={onCreateInsights}
        menuStyle={{ backgroundColor: "rgb(255, 244, 238)" }}
      />,
    );

    const addButton = screen.getByRole("button", {
      name: "Add page, link, calendar, social stats or newsletter",
    });
    fireEvent.click(addButton);
    expect(screen.getByText("New page").parentElement).toHaveClass(
      "border-border",
      "bg-card",
      "text-foreground",
    );
    expect(screen.getByText("New page").parentElement).toHaveStyle({
      backgroundColor: "rgb(255, 244, 238)",
    });
    fireEvent.click(screen.getByRole("button", { name: "Calendar page" }));

    expect(onCreateCalendar).toHaveBeenCalledOnce();
    fireEvent.click(addButton);
    fireEvent.click(screen.getByRole("button", { name: "Social stats page" }));
    expect(onCreateInsights).toHaveBeenCalledOnce();
  });

  it("lets creators rename and remove the Calendar page", () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    const onRename = vi.fn();
    const calendarId = "11111111-1111-4111-8111-111111111111";
    render(
      <PageTabs
        pages={[
          {
            id: calendarId,
            name: "Calendar",
            slug: "calendar",
            href: "/bizibeast/calendar",
            system: "calendar",
          },
        ]}
        activeId={calendarId}
        mode="editor"
        onSelect={onSelect}
        onCreateCalendar={() => undefined}
        onRename={onRename}
        onDelete={onDelete}
      />,
    );

    expect(screen.queryByRole("link", { name: "Calendar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    expect(onSelect).toHaveBeenCalledWith(calendarId);
    fireEvent.click(screen.getByRole("button", { name: "Rename page" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Book a call" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith(calendarId, "Book a call");

    fireEvent.click(screen.getByRole("button", { name: "Delete page" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete page" }));

    expect(onDelete).toHaveBeenCalledWith(calendarId);
  });

  it("lets creators rename external links", () => {
    const onRename = vi.fn();
    render(
      <PageTabs
        pages={[{ id: "link-1", name: "Example", slug: "example", url: "https://example.com" }]}
        activeId={null}
        mode="editor"
        onSelect={() => undefined}
        onRename={onRename}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename page" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My link" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("link-1", "My link");
  });

  it("signals navigation intent so public routes can preload before a click", () => {
    const onIntent = vi.fn();
    render(
      <PageTabs
        pages={[
          {
            id: "__calendar",
            name: "Calendar",
            slug: "calendar",
            system: "calendar",
          },
        ]}
        activeId={null}
        mode="public"
        onSelect={() => undefined}
        onIntent={onIntent}
      />,
    );

    fireEvent.pointerEnter(screen.getByRole("button", { name: "Calendar" }));

    expect(onIntent).toHaveBeenCalledWith("__calendar");
  });
});

describe("PageTabs editor reordering", () => {
  it("exposes a keyboard-operable drag handle for each editor page", () => {
    render(
      <PageTabs
        pages={[
          { id: "11111111-1111-4111-8111-111111111111", name: "About", slug: "about" },
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Calendar",
            slug: "calendar",
            system: "calendar",
          },
        ]}
        activeId={null}
        mode="editor"
        onSelect={() => undefined}
        onReorder={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Reorder Calendar" })).toHaveAttribute(
      "aria-roledescription",
      "sortable",
    );
  });
});

describe("PageTabs phone editor interaction", () => {
  const page = { id: "page-1", name: "About", slug: "about" };

  it("reveals page actions on the first tap and opens the page on the second", () => {
    const onSelect = vi.fn();
    render(
      <PageTabs
        pages={[page]}
        activeId={null}
        mode="editor"
        phoneEditor
        onSelect={onSelect}
        onDelete={() => undefined}
        onRename={() => undefined}
      />,
    );

    expect(screen.queryByRole("button", { name: "Rename page" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete page" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "About" }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Rename page" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete page" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "About" }));

    expect(onSelect).toHaveBeenCalledWith("page-1");
    expect(screen.queryByRole("button", { name: "Rename page" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete page" })).toBeNull();
  });

  it("keeps visitor pages on single-tap navigation", () => {
    const onSelect = vi.fn();
    render(
      <PageTabs pages={[page]} activeId={null} mode="public" phoneEditor onSelect={onSelect} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "About" }));

    expect(onSelect).toHaveBeenCalledWith("page-1");
  });

  it("renders crawlable visitor links when canonical paths are provided", () => {
    render(
      <PageTabs
        pages={[{ ...page, href: "/@creator/about" }]}
        activeId={null}
        homeHref="/@creator"
        mode="public"
        onSelect={() => undefined}
      />,
    );

    expect(screen.getByRole("link", { name: "Home page" })).toHaveAttribute("href", "/@creator");
    expect(screen.getByRole("link", { name: "About" })).toHaveAttribute("href", "/@creator/about");
    expect(screen.getByRole("link", { name: "About" })).not.toHaveAttribute("target");
  });
});
