/** Offline 45-second export proof. Synthetic provider fixtures; never calls HeyGen or spends API credits. */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, copyFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { studioHyperframesComposition } from "../../src/lib/studio-hyperframes";
import { newReelScene, studioReelSchema } from "../../src/lib/content-studio";
import { DEFAULT_AGENT_BRANDING } from "../../src/lib/content-agent-branding";
import type { StudioReelRequest } from "../../src/lib/studio-reel-host";

async function command(
  binary: string,
  args: string[],
  cwd: string,
  env = process.env,
  timeout = 300_000,
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      signal: AbortSignal.timeout(timeout),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output = (output + data.toString()).slice(-2_000_000);
    });
    child.stderr.on("data", (data) => {
      output = (output + data.toString()).slice(-2_000_000);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${binary} exited ${code}: ${output.slice(-1500)}`)),
    );
  });
}

const root = await mkdtemp(join(tmpdir(), "benny-45-second-proof-"));
await mkdir(join(root, "assets"));
const duration = [8, 15, 15, 7];
const scripts = [
  "Keep your avatar on screen for the moments that really matter. Start with a clear hook.",
  "Use the middle of your reel to show the idea. Add useful screenshots, practical examples, and clear captions while the narration continues.",
  "Reuse your finished avatar footage when you change the visuals. A new caption or a different music track does not need another avatar generation.",
  "Return to your avatar for a clear closing action. Preview the result before publishing.",
];
const assets: StudioReelRequest["assets"] = [];
const extensions: Record<string, string> = {};
const document = studioReelSchema.parse({
  schemaVersion: 1,
  format: "reel",
  style: "captions",
  brand: DEFAULT_AGENT_BRANDING,
  avatarId: "offline_fixture",
  voiceId: "offline_flite_fixture",
  scenes: duration.map((duration, index) =>
    newReelScene({
      duration,
      kind: index === 0 || index === 3 ? "avatar" : "media",
      title: [
        "Start with the hook",
        "Show the useful part",
        "Revise without regeneration",
        "Preview, approve, publish",
      ][index],
      caption: "",
      avatarScript: scripts[index],
      mute: true,
    }),
  ),
  subtitles: [],
});
for (const [index, scene] of document.scenes.entries()) {
  const speechId = crypto.randomUUID();
  const mediaId = crypto.randomUUID();
  scene.mediaId = mediaId;
  scene.narrationJobId = speechId;
  const scriptPath = join(root, `script-${index}.txt`);
  await writeFile(scriptPath, scripts[index]);
  await command(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `flite=textfile=${scriptPath}:voice=slt`,
      "-af",
      `apad,atrim=duration=${scene.duration}`,
      "-ar",
      "44100",
      "-ac",
      "1",
      join(root, "assets", `${speechId}.wav`),
    ],
    root,
  );
  assets.push({ id: speechId, kind: "audio" });
  extensions[speechId] = ".wav";
  const label = index === 0 || index === 3 ? "AVATAR SEGMENT FIXTURE" : "B ROLL FIXTURE";
  const output = join(root, "assets", mediaId + (scene.kind === "avatar" ? ".mp4" : ".png"));
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${index % 2 ? "0x163847" : "0x204d61"}:s=720x1280:r=30`,
    "-vf",
    `drawtext=text='${label}':fontsize=34:fontcolor=white:x=(w-text_w)/2:y=280`,
  ];
  if (scene.kind === "avatar")
    args.push(
      "-t",
      String(scene.duration),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
    );
  else args.push("-frames:v", "1", "-threads", "1");
  await command("ffmpeg", [...args, output], root);
  assets.push({ id: mediaId, kind: scene.kind === "avatar" ? "video" : "image" });
  extensions[mediaId] = scene.kind === "avatar" ? ".mp4" : ".png";
  const start = duration.slice(0, index).reduce((a, b) => a + b, 0);
  document.subtitles!.push({
    start: start + 0.1,
    end: start + Math.min(scene.duration - 0.1, 7),
    text: scripts[index].slice(0, 120),
  });
}
const musicId = crypto.randomUUID();
await command(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=16x16:r=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=44100",
    "-t",
    "45",
    "-af",
    "volume=0.12",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-pix_fmt",
    "yuv420p",
    join(root, "assets", `${musicId}.mp4`),
  ],
  root,
);
assets.push({ id: musicId, kind: "video" });
extensions[musicId] = ".mp4";
document.audio = { musicMediaId: musicId, musicVolume: 0.12, narrationVolume: 1, sourceStart: 0 };
await writeFile(
  join(root, "index.html"),
  studioHyperframesComposition({ document, assets }, extensions),
);
await writeFile(join(root, "request.json"), JSON.stringify({ document, assets }));
await copyFile(
  process.env.HYPERFRAMES_GSAP || "/opt/hyperframes/node_modules/gsap/dist/gsap.min.js",
  join(root, "gsap.min.js"),
);
await copyFile(resolve("src/assets/carousel/Inter.ttf"), join(root, "Inter.ttf"));
const binary = process.env.HYPERFRAMES_BINARY || "/opt/hyperframes/node_modules/.bin/hyperframes";
const childEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  HYPERFRAMES_CACHE_DIR: process.env.HYPERFRAMES_CACHE_DIR,
  HYPERFRAMES_BROWSER_PATH: process.env.HYPERFRAMES_BROWSER_PATH,
  HYPERFRAMES_CHROME_SANDBOX: process.env.HYPERFRAMES_CHROME_SANDBOX,
  DO_NOT_TRACK: "1",
};
const output = resolve(process.env.HYPERFRAMES_SMOKE_OUTPUT || join(root, "proof.mp4"));
const started = Date.now();
const log = await command(
  binary,
  ["render", root, "--output", output, "--workers", "1", "--quality", "draft"],
  root,
  childEnv,
);
await writeFile(join(root, "render.log"), log);
const probe = JSON.parse(
  await command(
    "ffprobe",
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", output],
    root,
  ),
);
const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
const audio = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
if (
  video?.codec_name !== "h264" ||
  video.width !== 1080 ||
  video.height !== 1920 ||
  video.r_frame_rate !== "30/1" ||
  audio?.codec_name !== "aac" ||
  Math.abs(Number(probe.format.duration) - 45) > 0.1 ||
  Number(probe.format.size) > 32 * 1024 * 1024
)
  throw new Error("Export did not match the required video contract.");
await readFile(output); // Ensure the output exists and is readable after the CLI exits.
console.log(
  JSON.stringify({
    passed: true,
    root,
    output,
    providerMode: "offline fixtures",
    durationSeconds: probe.format.duration,
    avatarFootageSeconds: 15,
    narrationSegments: 4,
    avatarSegments: 2,
    elapsedMs: Date.now() - started,
    codecs: [video.codec_name, audio.codec_name],
    width: video.width,
    height: video.height,
    fps: video.r_frame_rate,
  }),
);
