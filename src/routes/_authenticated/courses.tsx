import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BookOpen, ExternalLink, GraduationCap, Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AppHeader } from "@/components/AppHeader";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { WorkspaceProductComposer } from "@/components/commerce/WorkspaceProductComposer";
import { publicProductPath } from "@/lib/application-urls";
import { pricingLabel, type CommerceProductRecord } from "@/lib/commerce";
import { getMyCommerce, setCommerceProductStatus } from "@/lib/commerce.functions";
import { getMyProfile } from "@/lib/profile.functions";
import { micro } from "@/lib/micro-app-ui";

export const Route = createFileRoute("/_authenticated/courses")({
  head: () => ({ meta: [{ title: "E-courses | bento.surf" }] }),
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery({
      queryKey: ["my-commerce"],
      queryFn: () => getMyCommerce(),
    });
  },
  component: CoursesWorkspace,
});

function CoursesWorkspace() {
  const queryClient = useQueryClient();
  const commerce = useQuery({ queryKey: ["my-commerce"], queryFn: () => getMyCommerce() });
  const profile = useQuery({ queryKey: ["my-profile"], queryFn: () => getMyProfile() });
  const [composer, setComposer] = useState<{ productId?: string } | null>(null);
  const [archived, setArchived] = useState(false);
  const courses = (commerce.data?.products ?? []).filter(
    (product: CommerceProductRecord) => product.kind === "course",
  ) as CommerceProductRecord[];
  const visible = courses.filter((course) =>
    archived ? course.status === "archived" : course.status !== "archived",
  );
  const locked = Boolean(commerce.data?.locked);
  const status = useMutation({
    mutationFn: (input: { id: string; status: "published" | "archived" }) =>
      setCommerceProductStatus({ data: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["my-commerce"] });
      toast.success("Course updated");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Course could not be updated"),
  });
  return (
    <main className={micro.shell}>
      <AppHeader
        title="E-courses"
        actions={
          <button
            type="button"
            disabled={locked || !commerce.data}
            className={micro.btnPrimaryCompact}
            onClick={() => setComposer({})}
          >
            <Plus className="size-4" /> New course
          </button>
        }
      />
      <div className={micro.main}>
        <div className="mb-6 flex items-start gap-4">
          <span className={`${micro.iconWellAmber} size-12 shrink-0`}>
            <GraduationCap className="size-6" />
          </span>
          <div>
            <h1 className="font-ui-display text-3xl">Teach at your own pace</h1>
            <p className={`mt-1 ${micro.muted}`}>
              Create a course, organize its lessons, and manage access from this workspace.
            </p>
          </div>
        </div>
        {locked && (
          <div className={`${micro.card} mb-5 p-5`}>
            <p className="mb-3 text-sm">
              Your courses and student access are safe. The Store plan is required to create or edit
              courses.
            </p>
            <UpgradeDialog feature="courses" />
          </div>
        )}
        {commerce.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading courses…
          </p>
        ) : commerce.isError ? (
          <div role="alert">
            <p>Courses could not be loaded.</p>
            <button
              type="button"
              onClick={() => void commerce.refetch()}
              className={micro.btnPrimaryCompact}
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            <div className="mb-5 flex gap-2" aria-label="Course status">
              {[false, true].map((value) => (
                <button
                  key={String(value)}
                  type="button"
                  aria-pressed={archived === value}
                  onClick={() => setArchived(value)}
                  className={`rounded-xl px-4 py-2 text-sm font-semibold ${archived === value ? "bg-[#17213a] text-white" : "bg-white text-muted-foreground"}`}
                >
                  {value ? "Archived" : "Active"}
                </button>
              ))}
            </div>
            {visible.length ? (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {visible.map((course) => (
                  <article key={course.id} className={`${micro.card} p-5`}>
                    <div className="flex items-start justify-between gap-3">
                      <BookOpen className="size-6 text-amber-700" />
                      <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium capitalize">
                        {course.status}
                      </span>
                    </div>
                    <h2 className="mt-5 font-ui-display text-2xl">{course.title}</h2>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {course.settings.lessons?.length || 0} lessons · {course.sales_count || 0}{" "}
                      enrolled
                    </p>
                    <p className="mt-3 text-sm font-semibold">
                      {pricingLabel(
                        course.pricing_type,
                        course.price_amount,
                        course.currency,
                        course.billing_interval,
                      )}
                    </p>
                    <div className="mt-5 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => setComposer({ productId: course.id })}
                        className={micro.btnPrimaryCompact}
                      >
                        Manage lessons
                      </button>
                      {course.status === "published" && profile.data?.username && (
                        <a
                          href={publicProductPath(profile.data.username, course.public_slug)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-xs font-semibold"
                        >
                          View page <ExternalLink className="size-3.5" />
                        </a>
                      )}
                      <button
                        type="button"
                        disabled={locked || status.isPending}
                        onClick={() =>
                          status.mutate({
                            id: course.id,
                            status: course.status === "archived" ? "published" : "archived",
                          })
                        }
                        className="rounded-lg px-3 py-2 text-xs font-semibold text-muted-foreground"
                      >
                        {course.status === "archived" ? "Restore course" : "Archive course"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className={`${micro.card} p-10 text-center`}>
                <h2 className="font-ui-display text-2xl">
                  {archived ? "No archived courses" : "Create your first course"}
                </h2>
                <p className={`mt-2 ${micro.muted}`}>
                  {archived
                    ? "Archived courses keep existing student records."
                    : "Add lessons, choose free or paid access, and design your course page."}
                </p>
                {!archived && (
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => setComposer({})}
                    className={`${micro.btnPrimaryCompact} mt-5`}
                  >
                    Create first course
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <WorkspaceProductComposer
        kind="course"
        productId={composer?.productId}
        open={Boolean(composer)}
        onOpenChange={(open) => {
          if (!open) setComposer(null);
        }}
      />
    </main>
  );
}
