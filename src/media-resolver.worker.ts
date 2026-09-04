import mediaResolver, {
  releaseWhenStreamEnds,
  StreamConcurrencyGate,
} from "./lib/media-resolver.worker-core";

const tunnelGate = new StreamConcurrencyGate(4);

export default {
  async fetch(request: Request, env: Parameters<typeof mediaResolver.fetch>[1]) {
    const pathname = new URL(request.url).pathname;
    if (
      pathname !== "/image" &&
      !/^(?:\/(?:youtube-session|webshare))?\/tunnel(?:\/|$)/u.test(pathname)
    ) {
      return mediaResolver.fetch(request, env);
    }

    const release = tunnelGate.acquire();
    if (!release) {
      return Response.json(
        { error: "The media service is busy. Please wait for an active download to finish." },
        {
          status: 429,
          headers: {
            "cache-control": "private, no-store",
            "retry-after": "15",
            "x-content-type-options": "nosniff",
          },
        },
      );
    }
    try {
      return releaseWhenStreamEnds(await mediaResolver.fetch(request, env), release);
    } catch (error) {
      release();
      throw error;
    }
  },
};
