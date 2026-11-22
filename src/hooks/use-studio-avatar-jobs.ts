import { useQueries } from "@tanstack/react-query";
import { reviewHeyGenGeneration } from "@/lib/external-tools.functions";
import type { StudioReel } from "@/lib/content-studio";

export type StudioAvatarJob = Awaited<ReturnType<typeof reviewHeyGenGeneration>>;

export const studioAvatarJobKey = (workspaceId: string, jobId: string) => [
  "studio-avatar-job",
  workspaceId,
  jobId,
];

export function useStudioAvatarJobs(workspaceId: string, document: StudioReel | null) {
  const jobIds = [
    ...new Set(
      document?.scenes.flatMap((scene) => [
        ...(scene.kind === "avatar" && !scene.mediaId && scene.avatarJobId
          ? [scene.avatarJobId]
          : []),
        ...(scene.narrationJobId ? [scene.narrationJobId] : []),
      ]) || [],
    ),
  ];
  const results = useQueries({
    queries: jobIds.map((jobId) => ({
      queryKey: studioAvatarJobKey(workspaceId, jobId),
      queryFn: () => reviewHeyGenGeneration({ data: { jobId } }),
      staleTime: 5 * 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    })),
  });
  const jobs = new Map<string, StudioAvatarJob>();
  const avatarUrls = new Map<string, string>();
  results.forEach(({ data }, index) => {
    if (data) jobs.set(jobIds[index], data);
    if (data?.assetUrl) avatarUrls.set(jobIds[index], data.assetUrl);
  });
  return { jobs, avatarUrls };
}
