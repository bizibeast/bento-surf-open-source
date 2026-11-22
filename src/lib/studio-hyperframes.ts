import { colorOn } from "./content-agent-branding";
import { reelSceneDirection } from "./content-creation-harness";
import { studioReelRequestSchema, type StudioReelRequest } from "./studio-reel-host";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

/** Compile validated Studio data into fixed renderer code; never execute model-authored HTML. */
export function studioHyperframesComposition(
  value: StudioReelRequest,
  extensions: Record<string, string> = {},
  avatarBounds: Record<string, { top: number; bottom: number }> = {},
) {
  const { document, assets } = studioReelRequestSchema.parse(value);
  const available = new Map(assets.map((asset) => [asset.id, asset.kind]));
  const source = (id: string, kind?: "audio") => {
    if (!available.has(id) || (kind && available.get(id) !== kind))
      throw new Error("Choose owned, ready audio.");
    const extension = extensions[id] ?? "";
    if (!["", ".jpg", ".png", ".webp", ".gif", ".mp4", ".webm", ".wav", ".mp3"].includes(extension))
      throw new Error("Unsupported media extension.");
    return `assets/${id}${extension}`;
  };
  let start = 0;
  const animation: string[] = [];
  const scenes = document.scenes
    .map((scene, index) => {
      const at = start;
      start += scene.duration;
      const id = `scene-${scene.id}`;
      const direction = reelSceneDirection(document, scene, index);
      const bounds =
        scene.kind === "avatar" && scene.mediaId ? avatarBounds[scene.mediaId] : undefined;
      if (
        bounds &&
        (!Number.isFinite(bounds.top) ||
          !Number.isFinite(bounds.bottom) ||
          bounds.top < 0 ||
          bounds.bottom > 1 ||
          bounds.bottom - bounds.top < 0.24)
      )
        throw new Error("Invalid avatar framing.");
      const framing = bounds
        ? ` style="transform:scale(${Number((1 / (bounds.bottom - bounds.top)).toFixed(5))}) translateY(${(0.5 - (bounds.top + bounds.bottom) / 2) * 100}%);transform-origin:center"`
        : "";
      const footageClass = scene.kind === "avatar" ? "footage avatar-footage" : "footage";
      const timing = `data-start="${at}" data-duration="${scene.duration}"`;
      let media = "";
      if (scene.kind !== "card") {
        const kind = scene.mediaId && available.get(scene.mediaId);
        if (!kind || kind === "audio" || (scene.kind === "avatar" && kind !== "video"))
          throw new Error("Each scene needs an owned, ready media asset.");
        const src = source(scene.mediaId!);
        media =
          kind === "image"
            ? `<img id="${id}-media" ${timing} data-track-index="${index * 3}" class="${footageClass}"${framing} src="${src}" alt="">`
            : `<video id="${id}-media" ${timing} data-track-index="${index * 3}" data-media-start="${scene.sourceStart}" class="${footageClass}"${framing} src="${src}" muted playsinline></video>${scene.mute || scene.narrationJobId || document.audio?.narrationMediaId ? "" : `<audio id="${id}-audio" ${timing} data-track-index="${index * 3 + 1}" data-media-start="${scene.sourceStart}" data-volume="1" src="${src}"></audio>`}`;
      }
      if (scene.narrationJobId && !document.audio?.narrationMediaId)
        media += `<audio id="${id}-narration" ${timing} data-track-index="${index * 3 + 1}" data-volume="1" src="${source(scene.narrationJobId, "audio")}"></audio>`;
      const movement =
        direction.motion === "slide"
          ? "x:72"
          : direction.motion === "punch"
            ? "scale:.86,y:24"
            : "y:56";
      animation.push(
        `tl.from("#${id} .scene-label",{x:-24,opacity:0,duration:.25,ease:"power2.out"},${at + 0.08});`,
        // The headline is readable from frame zero; motion must not hide the hook.
        `tl.from("#${id} .title-word",{${movement},duration:.38,stagger:.055,ease:"power3.out"},${at});`,
      );
      if (scene.caption.trim())
        animation.push(
          `tl.from("#${id} .card-item${scene.title.trim() ? "" : ":not(:first-child)"}",{x:${direction.motion === "slide" ? 100 : 28},opacity:0,duration:.35,stagger:.14,ease:"expo.out"},${at + 0.4});`,
        );
      // A wipe covers the scene boundary; the outgoing scene remains visible until the cut.
      const transition = index
        ? `<div id="wipe-${index}" data-start="${at - 0.2}" data-duration=".4" data-track-index="${100 + index}" class="clip wipe"></div>`
        : "";
      if (index)
        animation.push(
          `tl.fromTo("#wipe-${index}",{x:-1080},{x:1080,duration:.4,ease:"power1.inOut"},${at - 0.2});`,
        );
      const items = scene.caption
        .split(/\n|\s+[•→/]\s+/u)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 6);
      const titleWords = scene.title
        .split(/\s+/u)
        .map((word) => `<span class="title-word">${escape(word)}</span>`)
        .join(" ");
      const label = `${String(index + 1).padStart(2, "0")} / ${String(document.scenes.length).padStart(2, "0")}`;
      return `${media}<div id="${id}" ${timing} data-track-index="${index * 3 + 2}" data-layout="${direction.layout}" class="clip scene ${scene.kind === "card" ? "card" : "overlay"} scene-${index % 2}"><div class="scene-content"><span class="scene-label">${label}</span><h1>${titleWords}</h1><div class="scene-items">${items.map((item, n) => `<p class="card-item"><span class="item-number">${String(n + 1).padStart(2, "0")}</span><span>${escape(item)}</span></p>`).join("")}</div></div></div>${transition}`;
    })
    .join("\n");
  const brand = document.brand;
  const audio = document.audio;
  const tracks = [
    audio?.narrationMediaId
      ? `<audio id="voiceover" data-start="0" data-duration="${start}" data-track-index="200" data-media-start="${audio.sourceStart}" data-volume="${audio.narrationVolume}" src="${source(audio.narrationMediaId)}"></audio>`
      : "",
    audio?.musicMediaId
      ? `<audio id="music" data-start="0" data-duration="${start}" data-track-index="201" data-media-start="${audio.sourceStart}" data-volume="${audio.musicVolume}" src="${source(audio.musicMediaId)}"></audio>`
      : "",
  ].join("");
  const subtitles = (document.subtitles || [])
    .map((cue, index) => {
      animation.push(
        `tl.from("#caption-${index}",{y:12,scale:.96,opacity:0,duration:.12,ease:"back.out(1.2)"},${cue.start});`,
      );
      return `<div id="caption-${index}" class="clip subtitle" data-start="${cue.start}" data-duration="${cue.end - cue.start}" data-track-index="202">${escape(cue.text)}</div>`;
    })
    .join("");
  const accentText = colorOn(brand.accentColor);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bento Studio export</title>
<style>
@font-face{font-family:Inter;src:url("Inter.ttf")}*{box-sizing:border-box}html,body{margin:0;width:1080px;height:1920px;overflow:hidden;background:${brand.backgroundColor};color:${brand.textColor};font-family:Inter,sans-serif}
.scene{position:absolute;inset:0;width:100%;height:100%}.scene-content{display:flex;flex-direction:column;justify-content:center;width:100%;height:100%;padding:150px 96px 380px;gap:52px}
.scene-label{font-size:30px;letter-spacing:.16em;font-weight:700;font-variant-numeric:tabular-nums;opacity:.7}.scene h1{font-size:118px;font-weight:900;letter-spacing:-.035em;line-height:1.02;margin:0;overflow-wrap:anywhere}.title-word{display:inline-block;max-width:100%;margin-right:.1em}.title-word:last-child{margin-right:0}.scene p{font-size:48px;line-height:1.2;margin:0;overflow-wrap:anywhere}.scene-items{display:flex;flex-direction:column;gap:24px}.card-item{display:flex;align-items:center;gap:28px}.item-number{display:none;font-size:28px;opacity:.55;font-variant-numeric:tabular-nums}
.card{background:${brand.backgroundColor}}.style-kinetic .card.scene-1,.style-jump-cut .card{background:${brand.accentColor};color:${accentText}}.style-kinetic .scene h1{font-size:132px}.style-interview .scene h1{font-size:92px}.style-product .card .scene-content{border:28px solid ${brand.accentColor}}
[data-layout="stack"] .scene-content{justify-content:center}[data-layout="stack"] h1{font-size:86px;line-height:1.08}[data-layout="stack"] .card-item{padding:30px 34px;border:2px solid currentColor;border-radius:20px;font-weight:700}[data-layout="stack"] .item-number{display:block}
.overlay{background:linear-gradient(transparent 48%,#000c);color:white}.overlay .scene-content{justify-content:flex-end;padding-bottom:490px}.overlay h1{font-size:76px;line-height:1.08}.overlay .scene-label{display:none}.overlay p{font-size:40px}.footage{position:absolute;inset:0;width:1080px;height:1920px;object-fit:cover}.avatar-footage{object-position:50% 50%}.scene[data-layout="split"]{background:linear-gradient(transparent 47%,${brand.backgroundColor} 47%);color:${brand.textColor}}.scene[data-layout="split"] .scene-content{padding-top:1020px;padding-bottom:350px;justify-content:center}.scene[data-layout="split"] h1{font-size:76px}
.wipe{position:absolute;inset:0;z-index:100;background:${brand.accentColor}}.subtitle{position:absolute;bottom:230px;left:110px;right:110px;z-index:150;text-align:center;padding:20px 28px;border-radius:18px;background:#111e;color:#fff;font-size:62px;letter-spacing:-.025em;font-weight:900;line-height:1.18;overflow-wrap:anywhere}
</style></head>
<body data-editing-style="${document.style}" class="${document.subtitles?.length ? "with-subtitles" : ""}"><div id="bento" class="style-${document.style}" data-composition-id="bento" data-start="0" data-duration="${start}" data-width="1080" data-height="1920">${scenes}${tracks}${subtitles}</div>
<script src="gsap.min.js"></script><script>window.__timelines={};const tl=gsap.timeline({paused:true});${animation.join("\n")}window.__timelines.bento=tl;</script></body></html>`;
}
