import { colorOn } from "./content-agent-branding";
import type { ReelScene, StudioReel } from "./content-studio";
import { reelSceneDirection } from "./content-creation-harness";

export const REEL_WIDTH = 720;
export const REEL_HEIGHT = 1280;
type Frame = { image: CanvasImageSource; width: number; height: number };

export function drawStudioReelScene(
  context: CanvasRenderingContext2D,
  document: StudioReel,
  scene: ReelScene,
  index: number,
  seconds: number,
  media?: Frame,
) {
  const W = REEL_WIDTH,
    H = REEL_HEIGHT;
  const brand = document.brand;
  const progress = Math.max(0, Math.min(1, seconds / scene.duration));
  const enter = Math.min(1, seconds / 0.35);
  const accentText = colorOn(brand.accentColor);

  function box(x: number, y: number, w: number, h: number, color: string | CanvasGradient) {
    context.fillStyle = color;
    context.fillRect(x, y, w, h);
  }

  function type(
    text: string,
    x: number,
    y: number,
    w: number,
    size: number,
    color: string,
    bold = true,
  ) {
    context.fillStyle = color;
    context.textBaseline = "top";
    context.font = `${bold ? "700" : "500"} ${size}px Inter, Arial, sans-serif`;
    const lineHeight = size * 1.14;
    for (const paragraph of text.split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (line && context.measureText(next).width > w) {
          context.fillText(line, x, y, w);
          y += lineHeight;
          line = word;
        } else {
          line = next;
        }
      }
      context.fillText(line, x, y, w);
      y += lineHeight;
    }
  }

  function shot(x: number, y: number, w: number, h: number, zoom = 1) {
    if (!media) return;
    context.save();
    context.beginPath();
    context.rect(x, y, w, h);
    context.clip();
    const scale = Math.max(w / media.width, h / media.height) * zoom;
    const dw = media.width * scale,
      dh = media.height * scale;
    context.drawImage(media.image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    context.restore();
  }

  function shade(strength: number) {
    const gradient = context.createLinearGradient(0, H * 0.4, 0, H);
    gradient.addColorStop(0, "rgba(10, 13, 27, 0)");
    gradient.addColorStop(1, `rgba(10, 13, 27, ${strength})`);
    box(0, 0, W, H, gradient);
  }

  const commonText = (x: number, y: number, titleColor: string, captionColor = titleColor) => {
    type(scene.title, x, y, W - 2 * x, 51, titleColor);
    type(scene.caption, x, y + 160, W - 2 * x, 28, captionColor, false);
  };

  context.save();
  box(0, 0, W, H, brand.backgroundColor);

  const direction = reelSceneDirection(document, scene, index);
  if (scene.kind === "card" && scene.direction) {
    const alternate = document.style === "kinetic" && index % 2 === 1;
    const color = alternate ? accentText : brand.textColor;
    box(0, 0, W, H, alternate ? brand.accentColor : brand.backgroundColor);
    const x = 64 + (direction.motion === "slide" ? (1 - enter) * 48 : 0);
    type(
      `${String(index + 1).padStart(2, "0")} / ${String(document.scenes.length).padStart(2, "0")}`,
      x,
      185,
      500,
      20,
      color,
    );
    const items = scene.caption
      .split(/\n|\s+[•→/]\s+/u)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6);
    const titleSize = direction.layout === "stack" ? 57 : 82;
    type(scene.title, x, 270, W - x - 64, titleSize, color);
    items.forEach((item, itemIndex) => {
      const y = 545 + itemIndex * 116;
      if (y > 1040) return;
      if (direction.layout === "stack") {
        context.strokeStyle = color;
        context.lineWidth = 1.5;
        context.strokeRect(x, y, W - x - 64, 94);
        type(item, x + 24, y + 27, W - x - 112, 32, color);
      } else type(item, x, y, W - x - 64, 32, color, false);
    });
  } else
    switch (document.style) {
      case "jump-cut": {
        box(0, 0, W, H, brand.accentColor);
        shot(0, 0, W, H, index % 2 === 0 ? 1 : 1.16);
        if (media) shade(0.98);
        box(46, 735, 65, 10, media ? "white" : accentText);
        commonText(46, 785, media ? "white" : accentText);
        break;
      }
      case "montage": {
        box(0, 0, W, H, "#151726");
        shot(0, 0, W, H, 1 + 0.15 * progress);
        shade(0.9);
        commonText(54, 840, "white");
        const dip = Math.max(
          0,
          1 - Math.min(1, Math.min(seconds, scene.duration - seconds) / 0.24),
        );
        box(0, 0, W, H, `rgba(0, 0, 0, ${dip * 0.78})`);
        break;
      }
      case "split-screen": {
        box(0, 0, W, 660, brand.accentColor);
        shot(0, 0, W, 660);
        if (!media) type(scene.caption, 48, 300, 624, 75, accentText);
        box(0, 654, W, 10, brand.textColor);
        type(scene.title, 48, 772, 624, 59, brand.textColor);
        type(scene.caption, 48, 962, 624, 34, brand.textColor, false);
        break;
      }
      case "captions": {
        box(0, 0, W, H, brand.accentColor);
        shot(0, 0, W, H);
        if (media) box(0, 0, W, H, "rgba(0, 0, 0, 0.57)");
        if (document.subtitles?.length) {
          if (scene.title) type(scene.title, 54, 128, 610, 44, media ? "white" : accentText);
          break;
        }
        const cues = scene.caption.split("\n").filter((cue) => cue.trim());
        const caption =
          cues[Math.min(cues.length - 1, Math.floor(progress * cues.length))] || scene.title;
        box(44, 780, 632, 330, "rgba(0, 0, 0, 0.58)");
        type(caption, 72, 823, 575, 45, "white");
        if (scene.title && caption !== scene.title) type(scene.title, 54, 128, 610, 30, accentText);
        break;
      }
      case "slideshow": {
        const x = 53 + (1 - enter) * 254;
        box(x, 136, 615, 727, brand.accentColor);
        box(x + 12, 148, 591, 703, brand.backgroundColor);
        shot(x + 25, 161, 565, 677);
        if (!media) type(scene.title, x + 40, 426, 530, 52, brand.textColor);
        commonText(65, 900, brand.textColor);
        break;
      }
      case "tutorial": {
        type(String(index + 1).padStart(2, "0"), 50, 115, 160, 94, brand.textColor);
        box(50, 240, 620, 495, brand.accentColor);
        shot(55, 245, 610, 485);
        type(scene.title, 52, 790, 616, 52, brand.textColor);
        type(scene.caption, 52, 930, 616, 29, brand.textColor, false);
        box(50, 1170, 620, 10, brand.accentColor + "40");
        box(50, 1170, (620 * (index + progress)) / document.scenes.length, 10, brand.accentColor);
        break;
      }
      case "kinetic": {
        const alternate = index % 2 === 0;
        box(0, 0, W, H, alternate ? brand.accentColor : brand.backgroundColor);
        if (media) {
          shot(0, 0, W, H, 1.1);
          box(0, 0, W, H, "rgba(0, 0, 0, 0.68)");
        }
        const color = media ? "#ffffff" : alternate ? accentText : brand.textColor;
        const words = scene.title.split(/\s+/).filter(Boolean);
        const reveal = Math.min(words.length, Math.max(1, Math.ceil(progress * words.length * 3)));
        type(words.slice(0, reveal).join(" "), 48 + (1 - enter) * 36, 420, 620, 77, color);
        type(scene.caption, 51, 930, 618, 34, color, false);
        break;
      }
      case "interview": {
        box(42, 85, 636, 752, brand.accentColor);
        shot(42, 85, 636, 752);
        if (!media) {
          type("“", 75, 195, 180, 195, accentText);
          type(scene.caption || scene.title, 82, 390, 554, 51, accentText);
        }
        box(42, 850, 636, 323, brand.textColor);
        commonText(70, 900, colorOn(brand.textColor));
        break;
      }
      case "product": {
        box(0, 0, W, 790, brand.accentColor);
        shot(110, 152, 500, 530, 1 + (1 - enter) * 0.12);
        if (!media) {
          context.strokeStyle = accentText;
          context.lineWidth = 3;
          context.strokeRect(110, 152, 500, 530);
          type(scene.title, 145, 368, 430, 50, accentText);
        }
        box(36, 730, 648, 480, brand.backgroundColor);
        box(66, 802, 60, 7, brand.accentColor);
        commonText(66, 843, brand.textColor);
        break;
      }
    }

  context.restore();
  const timelineStart = document.scenes
    .slice(0, index)
    .reduce((sum, scene) => sum + scene.duration, 0);
  const cue = document.subtitles?.find(
    (cue) => cue.start <= timelineStart + seconds && cue.end > timelineStart + seconds,
  );
  if (cue) {
    context.save();
    context.font = "700 36px Inter, Arial, sans-serif";
    const lines: string[] = [];
    let line = "";
    for (const word of cue.text.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && context.measureText(next).width > W - 140) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    const top = H - 120 - lines.length * 44;
    context.fillStyle = "rgba(0,0,0,.88)";
    context.fillRect(60, top - 16, W - 120, lines.length * 44 + 32);
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillStyle = "white";
    lines.forEach((line, index) => context.fillText(line, W / 2, top + index * 44, W - 140));
    context.restore();
  }
}
