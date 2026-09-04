/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PatternId } from "@/lib/patterns/registry";

export type CanvasCtx = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
  time: number;
  intensity: number; // 0..1
  color: string;
  theme: "light" | "dark";
  mouse: { x: number; y: number; vx: number; vy: number; down: boolean };
  events: { clicks: { x: number; y: number; t: number }[] };
};

export type CanvasStore = Record<string, any>;

type Drawer = {
  init?: (c: CanvasCtx, store: CanvasStore) => void;
  draw: (c: CanvasCtx, store: CanvasStore) => void;
};

export const CANVAS_DRAWERS: Partial<Record<PatternId, Drawer>> = {
  flicker: {
    init(c, s) {
      s.cell = 6;
      s.cols = Math.ceil(c.width / s.cell);
      s.rows = Math.ceil(c.height / s.cell);
      s.grid = new Float32Array(s.cols * s.rows);
    },
    draw(c, s) {
      const { ctx, width, height, theme } = c;
      ctx.fillStyle = theme === "dark" ? "rgba(8,10,20,0.18)" : "rgba(245,247,252,0.18)";
      ctx.fillRect(0, 0, width, height);
      const seedsPerFrame = Math.floor(40 + c.intensity * 200);
      for (let i = 0; i < seedsPerFrame; i++) {
        const idx = Math.floor(Math.random() * s.grid.length);
        s.grid[idx] = Math.min(1, s.grid[idx] + Math.random() * 0.8);
      }
      // very subtle grid lines
      ctx.strokeStyle = theme === "dark" ? "rgba(120,140,200,0.04)" : "rgba(20,30,60,0.04)";
      ctx.lineWidth = 1;
      for (let x = 0; x < s.cols; x += 4) {
        ctx.beginPath();
        ctx.moveTo(x * s.cell, 0);
        ctx.lineTo(x * s.cell, height);
        ctx.stroke();
      }
      // cells
      for (let i = 0; i < s.grid.length; i++) {
        const v = s.grid[i];
        if (v < 0.03) continue;
        const col = i % s.cols,
          row = (i / s.cols) | 0;
        ctx.fillStyle =
          c.color +
          Math.round(v * 200)
            .toString(16)
            .padStart(2, "0");
        ctx.fillRect(col * s.cell, row * s.cell, s.cell - 1, s.cell - 1);
        s.grid[i] = v * 0.92;
      }
    },
  },

  grid: {
    init(_c, s) {
      s.cell = 48;
      s.flashes = [];
      s.lastSpawn = 0;
    },
    draw(c, s) {
      const { ctx, width, height, theme } = c;
      ctx.fillStyle = theme === "dark" ? "#08080f" : "#fafafa";
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = theme === "dark" ? "rgba(120,140,200,0.1)" : "rgba(20,30,60,0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= width; x += s.cell) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let y = 0; y <= height; y += s.cell) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();
      if (c.time - s.lastSpawn > 0.05 / (0.5 + c.intensity)) {
        s.lastSpawn = c.time;
        s.flashes.push({
          x: Math.floor(Math.random() * (width / s.cell)) * s.cell,
          y: Math.floor(Math.random() * (height / s.cell)) * s.cell,
          life: 1,
        });
      }
      s.flashes = s.flashes.filter((f: any) => {
        f.life -= 0.02;
        ctx.fillStyle =
          c.color +
          Math.round(Math.max(f.life, 0) * 100)
            .toString(16)
            .padStart(2, "0");
        ctx.fillRect(f.x, f.y, s.cell, s.cell);
        return f.life > 0;
      });
    },
  },

  waves: {
    init(c, s) {
      s.cols = Math.floor(c.width / 4);
    },
    draw(c, s) {
      const { ctx, width, height, theme } = c;
      ctx.fillStyle = theme === "dark" ? "rgba(8,10,20,0.18)" : "rgba(248,250,255,0.18)";
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = c.color + "55";
      ctx.lineWidth = 1;
      const t = c.time * (0.4 + c.intensity * 0.8);
      for (let i = 0; i < s.cols; i++) {
        const x = (i / s.cols) * width;
        ctx.beginPath();
        const phase = i * 0.08;
        const mouseInf = Math.exp(-Math.abs(x - c.mouse.x) / 180) * 80;
        for (let y = 0; y < height; y += 6) {
          const dy =
            Math.sin(t + y * 0.01 + phase) * (20 + mouseInf) + Math.sin(t * 0.5 + y * 0.005) * 10;
          if (y === 0) ctx.moveTo(x + dy, y);
          else ctx.lineTo(x + dy, y);
        }
        ctx.stroke();
      }
    },
  },

  particles: {
    init(c, s) {
      s.p = Array.from({ length: 120 }, () => ({
        x: Math.random() * c.width,
        y: Math.random() * c.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        r: 1 + Math.random() * 2,
        life: 1,
      }));
    },
    draw(c, s) {
      const { ctx, width, height, theme } = c;
      ctx.fillStyle = theme === "dark" ? "rgba(8,10,20,0.18)" : "rgba(248,250,255,0.18)";
      ctx.fillRect(0, 0, width, height);
      for (const click of c.events.clicks) {
        for (let i = 0; i < 30; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 1 + Math.random() * 4;
          s.p.push({
            x: click.x,
            y: click.y,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp,
            r: 2,
            life: 1,
          });
        }
      }
      c.events.clicks.length = 0;
      ctx.fillStyle = c.color;
      s.p = s.p.filter((p: any) => {
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.985;
        p.vy *= 0.985;
        if (p.x < 0) p.x = width;
        if (p.x > width) p.x = 0;
        if (p.y < 0) p.y = height;
        if (p.y > height) p.y = 0;
        p.life -= 0.002;
        ctx.globalAlpha = Math.max(0, p.life) * (0.6 + c.intensity * 0.4);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        return p.life > 0;
      });
      ctx.globalAlpha = 1;
    },
  },

  dots: {
    init(_c, s) {
      s.dots = [];
      s.lastSpawn = 0;
    },
    draw(c, s) {
      const { ctx, width, height, theme } = c;
      ctx.fillStyle = theme === "dark" ? "#08080f" : "#fafafa";
      ctx.fillRect(0, 0, width, height);
      if (c.time - s.lastSpawn > 0.08 / (0.3 + c.intensity)) {
        s.lastSpawn = c.time;
        if (s.dots.length < 80)
          s.dots.push({
            x: Math.random() * width,
            y: Math.random() * height,
            life: 0,
            max: 0.4 + Math.random() * 0.6,
            r: 1 + Math.random() * 2,
          });
      }
      s.dots = s.dots.filter((d: any) => {
        d.life += 0.008;
        const a = d.life < d.max ? d.life / d.max : 1 - (d.life - d.max) / d.max;
        ctx.fillStyle = c.color;
        ctx.globalAlpha = Math.max(0, a);
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
        return d.life < d.max * 2;
      });
      ctx.globalAlpha = 1;
    },
  },

  glitch: {
    init(c, s) {
      s.cols = Math.floor(c.width / 14);
      s.drops = new Array(s.cols).fill(0).map(() => Math.random() * c.height);
      s.chars = "01アイウエオカキクケコ@#$%&*+=<>?";
    },
    draw(c, s) {
      const { ctx, width, height } = c;
      ctx.fillStyle = "rgba(0,8,4,0.12)";
      ctx.fillRect(0, 0, width, height);
      ctx.font = "13px ui-monospace, monospace";
      for (let i = 0; i < s.cols; i++) {
        const x = i * 14;
        const y = s.drops[i];
        const ch = s.chars[(Math.random() * s.chars.length) | 0];
        ctx.fillStyle = `rgba(140,255,180,${0.5 + Math.random() * 0.5})`;
        ctx.fillText(ch, x, y);
        ctx.fillStyle = "rgba(80,200,255,0.4)";
        ctx.fillText(ch, x, y - 16);
        s.drops[i] = y > height + Math.random() * 200 ? 0 : y + 14 * (0.4 + c.intensity * 0.8);
      }
    },
  },

  pixels: {
    init(_c, s) {
      s.clusters = [];
      s.lastSpawn = 0;
    },
    draw(c, s) {
      const { ctx, width, height, theme } = c;
      ctx.fillStyle = theme === "dark" ? "#08080f" : "#fafafa";
      ctx.fillRect(0, 0, width, height);
      if (c.time - s.lastSpawn > 0.5 / (0.5 + c.intensity)) {
        s.lastSpawn = c.time;
        if (s.clusters.length < 12) {
          const cx = Math.random() * width,
            cy = Math.random() * height;
          const cells: any[] = [];
          for (let i = 0; i < 12 + Math.random() * 16; i++) {
            cells.push({ x: cx + (Math.random() - 0.5) * 40, y: cy + (Math.random() - 0.5) * 40 });
          }
          s.clusters.push({ cells, life: 0, max: 1.2 + Math.random() });
        }
      }
      s.clusters = s.clusters.filter((cl: any) => {
        cl.life += 0.012;
        const a = cl.life < cl.max ? cl.life / cl.max : 1 - (cl.life - cl.max) / cl.max;
        ctx.fillStyle = c.color;
        ctx.globalAlpha = Math.max(0, a);
        for (const px of cl.cells) {
          px.x += 0.1;
          px.y -= 0.05;
          ctx.fillRect(px.x, px.y, 3, 3);
        }
        return cl.life < cl.max * 2;
      });
      ctx.globalAlpha = 1;
    },
  },

  mesh: {
    init() {},
    draw(c) {
      const { ctx, width, height, theme } = c;
      ctx.fillStyle = theme === "dark" ? "rgba(8,10,20,0.15)" : "rgba(248,250,255,0.15)";
      ctx.fillRect(0, 0, width, height);
      const cx = width / 2,
        cy = height / 2;
      const t = c.time * (0.5 + c.intensity);
      ctx.strokeStyle = c.color + "66";
      ctx.lineWidth = 1;
      const max = Math.hypot(width, height);
      for (let r = max; r > 0; r -= 30) {
        const phase = ((r + t * 60) % 120) / 120;
        const radius = r * (0.7 + phase * 0.3);
        ctx.globalAlpha = phase * 0.7;
        ctx.beginPath();
        for (let a = 0; a <= Math.PI * 2 + 0.1; a += 0.1) {
          const wob = Math.sin(a * 6 + t) * 4;
          const x = cx + Math.cos(a) * (radius + wob);
          const y = cy + Math.sin(a) * (radius + wob);
          if (a === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
  },
};
