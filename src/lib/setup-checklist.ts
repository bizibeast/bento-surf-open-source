export type SetupChecklistProfile = {
  display_name?: string | null;
  bio?: string | null;
  avatar_url?: string | null;
  theme?: string | null;
  accent_color?: string | null;
  header_mode?: string | null;
  pattern?: string | null;
  primary_font?: string | null;
  secondary_font?: string | null;
};

export type SetupChecklistBlock = {
  type?: string | null;
};

export type SetupChecklistStepId = "profile" | "photo" | "social" | "content" | "design" | "share";

export type SetupChecklistStep = {
  id: SetupChecklistStepId;
  title: string;
  description: string;
  action: string;
  complete: boolean;
};

export function getSetupChecklistSteps(
  profile: SetupChecklistProfile | null | undefined,
  blocks: readonly SetupChecklistBlock[],
  hasPreviewedOrShared: boolean,
): SetupChecklistStep[] {
  const hasProfile = Boolean(profile?.display_name?.trim() && profile?.bio?.trim());
  const hasPhoto = Boolean(profile?.avatar_url?.trim());
  const hasSocial = blocks.some((block) => block.type === "social_link");
  const hasContent = blocks.some((block) => block.type && block.type !== "social_link");
  const hasCustomDesign = Boolean(
    (profile?.theme && profile.theme !== "system") ||
    (profile?.accent_color && profile.accent_color !== "sky") ||
    (profile?.header_mode && profile.header_mode !== "with_photo") ||
    (profile?.pattern && profile.pattern !== "none") ||
    profile?.primary_font ||
    profile?.secondary_font,
  );

  return [
    {
      id: "profile",
      title: "Add your name and bio",
      description: "Tell visitors who you are and what they can find on your Bento.",
      action: "Edit profile",
      complete: hasProfile,
    },
    {
      id: "photo",
      title: "Add your profile photo",
      description: "Use a clear photo or logo so your page feels recognizable.",
      action: "Upload photo",
      complete: hasPhoto,
    },
    {
      id: "social",
      title: "Add a social",
      description: "Help your audience find you on the platforms you already use.",
      action: "Add social",
      complete: hasSocial,
    },
    {
      id: "content",
      title: "Add something important",
      description: "Feature a link, video, product, booking, image, or anything else you make.",
      action: "Add a block",
      complete: hasContent,
    },
    {
      id: "design",
      title: "Customize your design",
      description: "Choose a color, background, layout, or font that feels like you.",
      action: "Open design",
      complete: hasCustomDesign,
    },
    {
      id: "share",
      title: "Preview and share your Bento",
      description:
        "Check the live page, then put your Bento link everywhere your audience finds you.",
      action: "Open live page",
      complete: hasPreviewedOrShared,
    },
  ];
}

export function setupChecklistProgress(steps: readonly SetupChecklistStep[]) {
  const completed = steps.filter((step) => step.complete).length;
  const total = steps.length;
  return {
    completed,
    total,
    percentage: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}
