export function closeOpenMarketingMenus(root: HTMLElement | null) {
  root?.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((menu) => {
    menu.open = false;
  });
}

export function closeMarketingMenusOnOutsidePress(
  root: HTMLElement | null,
  target: EventTarget | null,
) {
  if (!root || !target || root.contains(target as Node)) return false;
  closeOpenMarketingMenus(root);
  return true;
}
