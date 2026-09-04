// Tiny WebGL2 fullscreen-fragment runner.
// Compiles a frag shader and drives it with time, resolution, mouse, intensity.

export type ShaderUniforms = {
  u_time: number;
  u_resolution: [number, number];
  u_mouse: [number, number]; // 0..1, y flipped
  u_mouse_v: [number, number]; // mouse velocity
  u_intensity: number; // 0..1
  u_color: [number, number, number];
  u_theme: number; // 0 light, 1 dark
};

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export function makeShaderRunner(
  canvas: HTMLCanvasElement,
  frag: string,
  initial: { color: [number, number, number]; intensity: number; theme: 0 | 1 },
) {
  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: false,
    alpha: true,
    antialias: false,
  });
  if (!gl) return null;

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn("shader compile", gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  };

  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, `#version 300 es\nprecision highp float;\n` + frag);
  if (!vs || !fs) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("link error", gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uniforms = {
    u_time: gl.getUniformLocation(prog, "u_time"),
    u_resolution: gl.getUniformLocation(prog, "u_resolution"),
    u_mouse: gl.getUniformLocation(prog, "u_mouse"),
    u_mouse_v: gl.getUniformLocation(prog, "u_mouse_v"),
    u_intensity: gl.getUniformLocation(prog, "u_intensity"),
    u_color: gl.getUniformLocation(prog, "u_color"),
    u_theme: gl.getUniformLocation(prog, "u_theme"),
  };

  const state: ShaderUniforms = {
    u_time: 0,
    u_resolution: [canvas.width, canvas.height],
    u_mouse: [0.5, 0.5],
    u_mouse_v: [0, 0],
    u_intensity: initial.intensity,
    u_color: initial.color,
    u_theme: initial.theme,
  };

  let raf = 0;
  let alive = true;
  const start = performance.now();
  let lastMouse: [number, number] = [0.5, 0.5];

  const loop = () => {
    if (!alive) return;
    if (document.hidden) {
      raf = requestAnimationFrame(loop);
      return;
    }
    state.u_time = (performance.now() - start) / 1000;
    state.u_resolution = [canvas.width, canvas.height];
    state.u_mouse_v = [state.u_mouse[0] - lastMouse[0], state.u_mouse[1] - lastMouse[1]];
    lastMouse = [...state.u_mouse];

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(prog);
    gl.uniform1f(uniforms.u_time, state.u_time);
    gl.uniform2f(uniforms.u_resolution, state.u_resolution[0], state.u_resolution[1]);
    gl.uniform2f(uniforms.u_mouse, state.u_mouse[0], state.u_mouse[1]);
    gl.uniform2f(uniforms.u_mouse_v, state.u_mouse_v[0], state.u_mouse_v[1]);
    gl.uniform1f(uniforms.u_intensity, state.u_intensity);
    gl.uniform3f(uniforms.u_color, state.u_color[0], state.u_color[1], state.u_color[2]);
    gl.uniform1f(uniforms.u_theme, state.u_theme);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    state,
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      gl.deleteProgram(prog);
      gl.deleteBuffer(buf);
    },
  };
}

// Helpers shared by all shaders - simplex noise / hash etc.
export const SHADER_HEADER = `
in vec2 v_uv;
out vec4 fragColor;
uniform float u_time;
uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform vec2 u_mouse_v;
uniform float u_intensity;
uniform vec3 u_color;
uniform float u_theme;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0,0.0));
  float c = hash(i + vec2(0.0,1.0));
  float d = hash(i + vec2(1.0,1.0));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
}
float fbm(vec2 p){
  float v = 0.0; float a = 0.5;
  for(int i=0;i<5;i++){ v += a*noise(p); p*=2.02; a*=0.5; }
  return v;
}
`;

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  return [r || 0, g || 0, b || 0];
}
