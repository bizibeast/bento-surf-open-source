import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, Search, Sparkles } from "lucide-react";
import { z } from "zod";
import { getExploreProfiles, type ExploreProfile } from "@/lib/explore.functions";
import {
  EXPLORE_CATEGORIES,
  exploreCategoryLabel,
  exploreCategorySchema,
  type ExploreCategory,
} from "@/lib/explore";
import { configuredPublicOrigin, publicProfileUrl } from "@/lib/application-urls";
import { PublicAppChrome } from "@/components/PublicAppChrome";
import { DecodedImage } from "@/components/DecodedImage";
import { MobileTabSelect } from "@/components/MobileTabSelect";
import { handleWebMcpFormSubmit } from "@/lib/webmcp";

const publicOrigin = configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL);

const exploreSearchSchema = z.object({
  category: exploreCategorySchema.optional().catch(undefined),
  q: z.string().max(80).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(500).optional().catch(undefined),
});

export const Route = createFileRoute("/explore")({
  validateSearch: exploreSearchSchema,
  loaderDeps: ({ search }) => ({
    category: search.category,
    q: search.q ?? "",
    page: search.page ?? 1,
  }),
  loader: ({ deps }) =>
    getExploreProfiles({
      data: {
        category: deps.category ?? null,
        query: deps.q,
        page: deps.page,
      },
    }),
  head: () => ({
    meta: [
      { title: "Explore creator pages | bento.surf" },
      {
        name: "description",
        content:
          "Discover beautiful bento.surf pages from creators, designers, founders, artists, educators, and more.",
      },
      { property: "og:title", content: "Explore the world of bento.surf" },
      {
        property: "og:description",
        content: "Real creator pages, shared for inspiration.",
      },
    ],
    links: [{ rel: "canonical", href: `${publicOrigin}/explore` }],
  }),
  component: ExplorePage,
});

function ExplorePage() {
  const navigate = useNavigate();
  const rawSearch = Route.useSearch();
  const search = { ...rawSearch, q: rawSearch.q ?? "", page: rawSearch.page ?? 1 };
  const data = Route.useLoaderData();
  const [query, setQuery] = useState(search.q);
  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));

  useEffect(() => setQuery(search.q), [search.q]);

  const submitSearch = (event: FormEvent<HTMLFormElement>) =>
    handleWebMcpFormSubmit(event, async () => {
      const nextQuery = query.trim();
      await navigate({
        to: "/explore",
        search: { category: search.category, q: nextQuery, page: 1 },
      });
      return {
        ok: true,
        message: "Opened matching creator pages in Explore.",
        destination: {
          path: "/explore",
          query: nextQuery,
          category: search.category ?? null,
          page: 1,
        },
      };
    });

  return (
    <div className="auth-light min-h-screen overflow-hidden bg-[#f7f8fc] text-[#17213a] selection:bg-[#3478f6] selection:text-white">
      <PublicAppChrome>
        <main>
          <section className="relative px-4 pb-16 pt-32 sm:pb-20 sm:pt-36">
            <div className="pointer-events-none absolute -left-40 top-20 size-[30rem] rounded-full bg-[#dfeaff] blur-3xl" />
            <div className="pointer-events-none absolute -right-40 top-6 size-[28rem] rounded-full bg-[#ffe0e1]/75 blur-3xl" />

            <div className="relative mx-auto max-w-5xl text-center">
              <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-[#3478f6]/15 bg-[#dfeaff] px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#245fd0]">
                <Sparkles className="size-3.5" />
                Explore real Surfs
              </p>
              <h1 className="mx-auto mt-5 max-w-4xl text-balance text-5xl font-normal leading-[0.94] sm:text-7xl">
                Find new ideas
                <span className="font-display block font-normal">inside creator worlds.</span>
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-balance text-base leading-7 text-[#17213a]/62 sm:text-lg">
                Discover pages shared by the Bento community. Open a Surf, borrow the spark, then
                make it unmistakably yours.
              </p>

              <form
                onSubmit={submitSearch}
                toolname="bento_search_creator_pages"
                tooldescription="Searches public Bento creator pages by creator name or username."
                toolautosubmit="true"
                className="mx-auto mt-8 flex max-w-xl items-center rounded-full border border-[#17213a]/10 bg-white/88 p-1.5 pl-4 shadow-[0_22px_60px_-35px_rgba(23,33,58,0.42)] backdrop-blur-xl"
              >
                <Search className="size-4 shrink-0 text-[#17213a]/62" />
                <input
                  name="query"
                  toolparamdescription="Creator name or username to search for."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search a name or @username"
                  aria-label="Search creator pages"
                  className="h-11 min-w-0 flex-1 bg-transparent px-3 text-sm outline-none placeholder:text-[#17213a]/62"
                />
                <button
                  type="submit"
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-[#17213a] text-white transition hover:scale-[1.03]"
                  aria-label="Search Explore"
                >
                  <ArrowRight className="size-4" />
                </button>
              </form>
            </div>
          </section>

          <section className="relative border-t border-[#17213a]/7 bg-white/72 px-4 py-12 sm:py-16">
            <div className="mx-auto max-w-7xl">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#3478f6]">
                    Community showcase
                  </p>
                  <h2 className="mt-3 font-display text-4xl sm:text-5xl">
                    Surfs worth wandering through.
                  </h2>
                  <p className="mt-3 text-sm text-[#17213a]/62">
                    {data.total === 0
                      ? "No pages match this view yet."
                      : `${data.total} creator page${data.total === 1 ? "" : "s"} shared for inspiration.`}
                  </p>
                </div>

                <MobileTabSelect<"all" | ExploreCategory>
                  value={search.category ?? "all"}
                  options={[
                    { value: "all", label: "All" },
                    ...EXPLORE_CATEGORIES.map((category) => ({
                      value: category.id,
                      label: category.label,
                    })),
                  ]}
                  onChange={(category) =>
                    void navigate({
                      to: "/explore",
                      search: {
                        category: category === "all" ? undefined : category,
                        q: search.q,
                        page: 1,
                      },
                    })
                  }
                  ariaLabel="Explore category"
                />
                <div className="no-scrollbar -mx-4 hidden gap-2 overflow-x-auto px-4 pb-1 sm:flex lg:mx-0 lg:max-w-[62%] lg:px-0">
                  <CategoryLink
                    active={!search.category}
                    label="All"
                    category={undefined}
                    query={search.q}
                  />
                  {EXPLORE_CATEGORIES.map((category) => (
                    <CategoryLink
                      key={category.id}
                      active={search.category === category.id}
                      label={category.label}
                      category={category.id}
                      query={search.q}
                    />
                  ))}
                </div>
              </div>

              {data.items.length > 0 ? (
                <div className="mt-9 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                  {data.items.map((profile, index) => (
                    <ExploreCard key={profile.username} profile={profile} priority={index < 6} />
                  ))}
                </div>
              ) : (
                <div className="mt-9 flex min-h-72 flex-col items-center justify-center rounded-[32px] border border-dashed border-[#17213a]/15 bg-[#f7f8fc] px-6 text-center">
                  <div className="flex size-14 items-center justify-center rounded-2xl bg-[#dfeaff] text-[#245fd0]">
                    <Search className="size-5" />
                  </div>
                  <h3 className="mt-5 font-display text-3xl">Nothing here yet.</h3>
                  <p className="mt-2 max-w-sm text-sm leading-6 text-[#17213a]/62">
                    Try another category or a broader search. New Surfs appear as creators finish
                    their pages.
                  </p>
                  <Link
                    to="/explore"
                    search={{ q: "", page: 1 }}
                    className="mt-5 rounded-full bg-[#17213a] px-5 py-2.5 text-sm font-semibold text-white"
                  >
                    See every Surf
                  </Link>
                </div>
              )}

              {pageCount > 1 && (
                <nav
                  aria-label="Explore pages"
                  className="mt-10 flex items-center justify-center gap-3"
                >
                  <PageLink
                    disabled={data.page <= 1}
                    page={data.page - 1}
                    category={search.category}
                    query={search.q}
                    label="Previous page"
                  >
                    <ChevronLeft className="size-4" />
                  </PageLink>
                  <span className="rounded-full bg-[#f0f3fa] px-4 py-2 text-xs font-semibold text-[#17213a]/62">
                    {data.page} / {pageCount}
                  </span>
                  <PageLink
                    disabled={data.page >= pageCount}
                    page={data.page + 1}
                    category={search.category}
                    query={search.q}
                    label="Next page"
                  >
                    <ChevronRight className="size-4" />
                  </PageLink>
                </nav>
              )}
            </div>
          </section>
        </main>
      </PublicAppChrome>
    </div>
  );
}

function CategoryLink({
  active,
  label,
  category,
  query,
}: {
  active: boolean;
  label: string;
  category?: ExploreCategory;
  query: string;
}) {
  return (
    <Link
      to="/explore"
      search={{ category, q: query, page: 1 }}
      className={`shrink-0 rounded-full px-4 py-2.5 text-sm font-semibold transition ${
        active
          ? "bg-[#17213a] text-white"
          : "border border-[#17213a]/9 bg-[#f7f8fc] text-[#17213a]/62 hover:bg-white hover:text-[#17213a]"
      }`}
    >
      {label}
    </Link>
  );
}

function ExploreCard({ profile, priority }: { profile: ExploreProfile; priority: boolean }) {
  return (
    <a
      href={publicProfileUrl(profile.username, null, import.meta.env.VITE_PUBLIC_URL)}
      className="group overflow-hidden rounded-[30px] border border-[#17213a]/8 bg-white p-2 shadow-[0_24px_70px_-50px_rgba(23,33,58,0.55)] transition duration-300 hover:-translate-y-1.5 hover:shadow-[0_34px_80px_-46px_rgba(23,33,58,0.55)]"
    >
      <div className="relative aspect-[1200/630] overflow-hidden rounded-[24px] bg-gradient-to-br from-[#dfeaff] via-[#f7f8fc] to-[#ffe0e1]">
        <div className="absolute inset-0 flex items-center justify-center">
          <ProfileAvatar
            profile={profile}
            className="size-24 rounded-[30px] object-cover opacity-80 shadow-xl"
            fallbackClassName="flex size-24 items-center justify-center rounded-[30px] bg-white/80 font-display text-4xl text-[#245fd0] shadow-xl"
          />
        </div>
        <LazyPreviewBackground key={profile.previewUrl} profile={profile} priority={priority} />
        <span className="absolute right-3 top-3 flex size-9 items-center justify-center rounded-full bg-white/88 text-[#17213a] shadow-sm backdrop-blur">
          <ArrowRight className="size-4 -rotate-45 transition-transform group-hover:rotate-0" />
        </span>
      </div>
      <div className="flex items-start gap-3 p-3 pb-4 pt-4">
        <ProfileAvatar
          profile={profile}
          className="size-11 shrink-0 rounded-2xl object-cover"
          fallbackClassName="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[#dfeaff] font-display text-xl text-[#245fd0]"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold tracking-[-0.025em]">{profile.displayName}</div>
          <div className="truncate text-sm text-[#17213a]/62">@{profile.username}</div>
          {profile.bio && (
            <p className="mt-2 line-clamp-2 text-sm leading-5 text-[#17213a]/62">{profile.bio}</p>
          )}
        </div>
        <span className="shrink-0 rounded-full bg-[#f0f3fa] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#17213a]/62">
          {exploreCategoryLabel(profile.category)}
        </span>
      </div>
    </a>
  );
}

function LazyPreviewBackground({
  profile,
  priority,
}: {
  profile: ExploreProfile;
  priority: boolean;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const releaseQueueSlotRef = useRef<(() => void) | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [eligible, setEligible] = useState(priority);
  const [attempt, setAttempt] = useState(0);
  const [src, setSrc] = useState<string>();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (priority) return;
    const image = imageRef.current;
    if (!image || typeof IntersectionObserver === "undefined") {
      setEligible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setEligible(true);
        observer.disconnect();
      },
      { rootMargin: "700px 0px" },
    );
    observer.observe(image);
    return () => observer.disconnect();
  }, [priority]);

  useEffect(() => {
    if (!eligible || loaded) return;

    return enqueuePreviewLoad((release) => {
      releaseQueueSlotRef.current = release;
      const separator = profile.previewUrl.includes("?") ? "&" : "?";
      setLoaded(false);
      setSrc(`${profile.previewUrl}${separator}attempt=${attempt}`);
    });
  }, [attempt, eligible, loaded, profile.previewUrl]);

  useEffect(
    () => () => {
      releaseQueueSlotRef.current?.();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    },
    [],
  );

  const releaseQueueSlot = () => {
    releaseQueueSlotRef.current?.();
    releaseQueueSlotRef.current = null;
  };

  const handleError = () => {
    releaseQueueSlot();
    setLoaded(false);
    setSrc(undefined);
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(
      () => setAttempt((currentAttempt) => currentAttempt + 1),
      Math.min(2_000 * 2 ** Math.min(attempt, 4), 30_000),
    );
  };

  return (
    <img
      ref={imageRef}
      src={src}
      alt=""
      aria-hidden="true"
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
      decoding="async"
      onLoad={async (event) => {
        const image = event.currentTarget;
        if (image.naturalWidth === 0) {
          handleError();
          return;
        }
        try {
          await image.decode();
        } catch {
          // The completed resource can still be displayed if decode() is unavailable.
        }
        releaseQueueSlot();
        setLoaded(true);
      }}
      onError={handleError}
      className={`absolute inset-0 size-full bg-white object-cover object-top transition duration-300 group-hover:scale-[1.015] ${
        loaded ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    />
  );
}

// Keep cold screenshot generation bounded while allowing immutable R2/browser-cache hits
// to fill the visible grid immediately.
const MAX_CONCURRENT_PREVIEW_LOADS = 4;
let activePreviewLoads = 0;
const previewLoadQueue: Array<() => void> = [];

function flushPreviewLoadQueue() {
  while (activePreviewLoads < MAX_CONCURRENT_PREVIEW_LOADS) {
    const next = previewLoadQueue.shift();
    if (!next) return;
    next();
  }
}

function enqueuePreviewLoad(start: (release: () => void) => void) {
  let cancelled = false;
  let started = false;
  let released = false;

  const release = () => {
    if (!started || released) return;
    released = true;
    activePreviewLoads = Math.max(0, activePreviewLoads - 1);
    flushPreviewLoadQueue();
  };

  const queuedLoad = () => {
    if (cancelled) {
      flushPreviewLoadQueue();
      return;
    }
    started = true;
    activePreviewLoads += 1;
    start(release);
  };

  previewLoadQueue.push(queuedLoad);
  flushPreviewLoadQueue();

  return () => {
    cancelled = true;
    release();
  };
}

function ProfileAvatar({
  profile,
  className,
  fallbackClassName,
}: {
  profile: ExploreProfile;
  className: string;
  fallbackClassName: string;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  return (
    <span className={`${fallbackClassName} relative overflow-hidden`} aria-hidden="true">
      {profile.displayName.slice(0, 1).toUpperCase()}
      {profile.avatarUrl && !failed && (
        <DecodedImage
          src={profile.avatarUrl}
          alt=""
          width={160}
          height={160}
          loading="lazy"
          decoding="async"
          className={`${className} absolute inset-0 ${loaded ? "opacity-100" : "opacity-0"}`}
          onLoad={(event) => {
            if (event.currentTarget.naturalWidth > 0) setLoaded(true);
            else setFailed(true);
          }}
          onError={() => {
            setLoaded(false);
            setFailed(true);
          }}
        />
      )}
    </span>
  );
}

function PageLink({
  disabled,
  page,
  category,
  query,
  label,
  children,
}: {
  disabled: boolean;
  page: number;
  category?: ExploreCategory;
  query: string;
  label: string;
  children: ReactNode;
}) {
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className="inline-flex size-10 items-center justify-center rounded-full border border-[#17213a]/8 text-[#17213a]/20"
      >
        {children}
      </span>
    );
  }
  return (
    <Link
      to="/explore"
      search={{ category, q: query, page }}
      aria-label={label}
      className="inline-flex size-10 items-center justify-center rounded-full bg-[#17213a] text-white transition hover:scale-105"
    >
      {children}
    </Link>
  );
}
