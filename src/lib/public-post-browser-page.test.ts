import { afterEach, describe, expect, it } from "vitest";
import { extractPublicPostPage } from "./public-post-browser-page";

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});
describe("direct browser post evidence", () => {
  it("captures late post JSON without returning unrelated bootstrap blocks", () => {
    document.head.innerHTML = '<link rel="canonical" href="https://facebook.com/reel/12345">';
    document.body.innerHTML =
      Array.from(
        { length: 90 },
        () => '<script type="application/json">{"bootstrap":true}</script>',
      ).join("") +
      '<script type="application/json">{"video":{"id":"12345"},"feedback":{"total_comment_count":121,"share_count_reduced":"262"}}</script>';
    const result = extractPublicPostPage({ platform: "Facebook", id: "12345" });
    expect(result.ready).toBe(true);
    expect(result.value).toContain("total_comment_count");
    expect(result.value).not.toContain("bootstrap");
  });
  it("uses only the target Thread's action bar, excluding its quoted post", () => {
    document.body.innerHTML = `<div data-pressable-container="true"><a href="https://threads.com/@creator/post/ExactPost"><time>now</time></a><div data-pressable-container="true"><a href="https://threads.com/@quoted/post/OtherPost"><time>old</time></a><button><svg><title>Like</title></svg>999</button><button><svg><title>Share</title></svg>888</button></div><button><svg><title>Like</title></svg>470</button><button><svg><title>Comment</title></svg>79</button><button><svg><title>Repost</title></svg>13</button><button><svg><title>Share</title></svg>5</button></div>`;
    const result = extractPublicPostPage({ platform: "Threads", id: "ExactPost" });
    expect(result.visibleCounts).toEqual({
      likes: "470",
      comments: "79",
      reshares: "13",
      shares: "5",
    });
    expect(result.ready).toBe(true);
  });
  it("does not infer a zero from an action button without a visible count", () => {
    document.body.innerHTML =
      '<div data-pressable-container="true"><a href="https://threads.com/@creator/post/ExactPost"><time>now</time></a><button><svg><title>Share</title></svg></button></div>';
    expect(extractPublicPostPage({ platform: "Threads", id: "ExactPost" }).visibleCounts).toEqual(
      {},
    );
  });
  it("captures only the requested Reddit post attributes", () => {
    document.body.innerHTML =
      '<shreddit-post id="t3_other" score="9999" comment-count="999"></shreddit-post><shreddit-post post-id="t3_abc123" score="17" comment-count="3"></shreddit-post>';
    const result = extractPublicPostPage({ platform: "Reddit", id: "abc123" });
    expect(result.value).toContain('score="17"');
    expect(result.value).not.toContain("9999");
  });
  it("serializes without closures for execution inside the remote browser", () => {
    document.body.innerHTML =
      '<script type="application/json">{"code":"ExactPost","reshare_count":88,"media_repost_count":8}</script>';
    const run = new Function(
      "document",
      `return (${extractPublicPostPage.toString()})({platform:"Instagram",id:"ExactPost"})`,
    );
    expect(run(document).ready).toBe(true);
  });
  it("does not let unrelated bootstrap data consume the target-post parsing allowance", () => {
    document.body.innerHTML =
      Array.from(
        { length: 4 },
        () =>
          '<script type="application/json">' +
          JSON.stringify({ bootstrap: "x".repeat(900_000) }) +
          "</script>",
      ).join("") +
      '<script type="application/json">' +
      JSON.stringify({ code: "ExactPost", like_count: 145, padding: "x".repeat(500_000) }) +
      "</script>";
    const result = extractPublicPostPage({
      platform: "Instagram",
      id: "ExactPost",
      wanted: ["likes"],
    });
    expect(result.ready).toBe(true);
    expect(result.value.length).toBeLessThan(1000);
  });
});
