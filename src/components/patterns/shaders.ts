import { SHADER_HEADER } from "./shader-runner";
import type { PatternId } from "@/lib/patterns/registry";

const H = SHADER_HEADER;

// Each entry is a fragment shader main body - must write fragColor.
export const SHADERS: Partial<Record<PatternId, string>> = {
  retro:
    H +
    `
  void main(){
    vec2 uv = (v_uv - 0.5) * vec2(u_resolution.x/u_resolution.y, 1.0);
    float horizon = 0.05;
    vec3 bg = mix(vec3(0.04,0.02,0.08), vec3(0.18,0.04,0.22), smoothstep(-0.5, horizon, uv.y));
    bg += vec3(0.9,0.2,0.5) * smoothstep(0.05, -0.02, abs(uv.y-horizon)) * 0.6;

    vec3 col = bg;
    if(uv.y < horizon){
      float z = (horizon - uv.y);
      float persp = 1.0 / (z + 0.04);
      float speed = u_time * (0.4 + u_intensity*0.6);
      float gx = abs(fract(uv.x * persp * 1.4) - 0.5);
      float gz = abs(fract(z * persp * 3.0 - speed) - 0.5);
      float line = smoothstep(0.04, 0.0, min(gx, gz)) * smoothstep(horizon, -0.5, uv.y);
      col += vec3(1.0, 0.4, 0.9) * line * 1.2;
    } else {
      // sun
      vec2 s = uv - vec2(0.0, 0.18);
      float d = length(s);
      float sun = smoothstep(0.22, 0.18, d);
      float bands = step(0.5, fract((s.y + 0.18)*18.0 - 0.5)) * step(s.y, 0.18);
      col = mix(col, vec3(1.0,0.5,0.3), sun * (1.0 - bands*0.6));
    }
    fragColor = vec4(col, 1.0);
  }`,

  ripple:
    H +
    `
  void main(){
    vec2 uv = (v_uv - 0.5) * vec2(u_resolution.x/u_resolution.y, 1.0);
    float d = length(uv);
    float t = u_time * (0.6 + u_intensity*1.2);
    float rings = sin(d*36.0 - t*3.0) * 0.5 + 0.5;
    rings *= smoothstep(1.0, 0.0, d);
    vec3 base = mix(vec3(0.02,0.05,0.08), vec3(0.06,0.1,0.18), 1.0-d);
    vec3 col = base + u_color * rings * 0.45;
    fragColor = vec4(col, 1.0);
  }`,

  aurora:
    H +
    `
  void main(){
    vec2 uv = v_uv;
    float t = u_time * (0.15 + u_intensity*0.25);
    float n = fbm(uv*3.0 + vec2(t, t*0.6));
    float n2 = fbm(uv*2.0 - vec2(t*0.7, -t));
    float band1 = smoothstep(0.45, 0.55, n + uv.y*0.4);
    float band2 = smoothstep(0.5, 0.6, n2 + (1.0-uv.y)*0.3);
    vec3 green  = vec3(0.2, 0.95, 0.55);
    vec3 cyan   = vec3(0.25, 0.85, 1.0);
    vec3 purple = vec3(0.7, 0.35, 1.0);
    vec3 blue   = vec3(0.25, 0.4, 1.0);
    vec3 sky = mix(vec3(0.02,0.02,0.07), vec3(0.05,0.0,0.12), uv.y);
    vec3 col = sky;
    col = mix(col, green, band1*0.65);
    col = mix(col, purple, band2*0.55);
    col += cyan * pow(n*n2, 2.0) * 0.4;
    col += blue * 0.08;
    fragColor = vec4(col, 1.0);
  }`,

  ether:
    H +
    `
  void main(){
    vec2 uv = v_uv;
    vec2 m = u_mouse;
    float t = u_time * 0.35;
    float n = fbm(uv*4.0 + t);
    float d = distance(uv, m);
    float glow = exp(-d*4.5) * (0.6 + u_intensity*0.8);
    vec3 purple = vec3(0.55, 0.25, 0.95);
    vec3 base = mix(vec3(0.05,0.02,0.1), vec3(0.1,0.04,0.18), n);
    vec3 col = base + purple * (glow + n*0.3*u_intensity);
    col += vec3(0.3,0.15,0.6) * smoothstep(0.6, 0.0, d) * length(u_mouse_v)*8.0;
    fragColor = vec4(col, 1.0);
  }`,

  bends:
    H +
    `
  // Two glowing rainbow ribbons
  vec3 hsv2rgb(vec3 c){
    vec3 p = abs(fract(c.xxx + vec3(0.0,2.0/3.0,1.0/3.0))*6.0-3.0);
    return c.z * mix(vec3(1.0), clamp(p-1.0,0.0,1.0), c.y);
  }
  void main(){
    vec2 uv = (v_uv - 0.5) * vec2(u_resolution.x/u_resolution.y, 1.0);
    float t = u_time * (0.2 + u_intensity*0.4);
    float w1 = sin(uv.x*2.0 + t) * 0.4 + sin(uv.x*5.0 - t*1.3)*0.15;
    float w2 = cos(uv.x*1.6 - t*0.8) * 0.35 + cos(uv.x*4.0 + t*0.9)*0.12;
    float d1 = abs(uv.y - w1);
    float d2 = abs(uv.y + 0.1 - w2);
    float r1 = exp(-d1*9.0) * 0.9;
    float r2 = exp(-d2*9.0) * 0.9;
    vec3 c1 = hsv2rgb(vec3(fract(uv.x*0.4 + t*0.3), 0.7, 1.0));
    vec3 c2 = hsv2rgb(vec3(fract(uv.x*0.4 + t*0.3 + 0.5), 0.7, 1.0));
    vec3 col = vec3(0.02,0.02,0.05) + c1*r1 + c2*r2;
    fragColor = vec4(col, 1.0);
  }`,

  veil:
    H +
    `
  void main(){
    vec2 uv = v_uv;
    float t = u_time*0.1;
    vec2 d = uv - u_mouse;
    float dist = length(d);
    float distort = smoothstep(0.4, 0.0, dist) * 0.06 * (0.5 + u_intensity);
    uv += normalize(d) * distort;
    vec3 pink   = vec3(0.95, 0.3, 0.6);
    vec3 purple = vec3(0.3, 0.1, 0.5);
    vec3 deep   = vec3(0.05, 0.02, 0.12);
    float n = fbm(uv*2.0 + t);
    vec3 grad = mix(purple, pink, uv.y*0.7 + n*0.3);
    grad = mix(deep, grad, 0.5 + n*0.5);
    grad *= 1.0 - smoothstep(0.45, 0.0, dist)*0.6;
    float grain = hash(uv*u_resolution + u_time) - 0.5;
    grad += grain*0.06;
    fragColor = vec4(grad, 1.0);
  }`,

  lines:
    H +
    `
  void main(){
    vec2 uv = (v_uv - 0.5) * vec2(u_resolution.x/u_resolution.y, 1.0);
    float t = u_time * (0.4 + u_intensity*0.6);
    vec3 col = vec3(0.02,0.01,0.05);
    for(int i=0;i<6;i++){
      float fi = float(i);
      float ang = 0.6 + fi*0.18 + (u_mouse.x-0.5)*0.4;
      vec2 dir = vec2(cos(ang), sin(ang));
      float d = dot(uv, vec2(-dir.y, dir.x));
      float off = sin(t + fi*1.7) * 0.5;
      float beam = exp(-pow((d - off)*14.0, 2.0));
      vec3 c = mix(vec3(0.4,0.2,1.0), vec3(0.2,0.4,1.0), fract(fi*0.37));
      col += c * beam * 0.6;
    }
    fragColor = vec4(col, 1.0);
  }`,

  grain:
    H +
    `
  void main(){
    vec2 uv = v_uv;
    float t = u_time*0.05;
    float n = fbm(uv*1.5 + t);
    vec3 a = mix(vec3(0.96,0.94,0.9), vec3(0.78,0.82,0.92), n);
    vec3 b = mix(vec3(0.08,0.07,0.1), vec3(0.12,0.1,0.18), n);
    vec3 base = mix(a, b, u_theme);
    base = mix(base, u_color, n*0.18);
    float g = hash(uv*u_resolution + u_time*60.0) - 0.5;
    base += g * (0.08 + u_intensity*0.12);
    fragColor = vec4(base, 1.0);
  }`,

  rays:
    H +
    `
  void main(){
    vec2 uv = v_uv;
    float t = u_time * 0.15;
    vec3 deep = mix(vec3(0.05,0.15,0.25), vec3(0.02,0.05,0.12), uv.y);
    vec3 col = deep;
    for(int i=0;i<5;i++){
      float fi = float(i);
      float ang = 1.3 + fi*0.15 + (u_mouse.x-0.5)*0.3;
      vec2 dir = vec2(cos(ang), sin(ang));
      float band = abs(dot(uv - vec2(0.5,1.2), vec2(-dir.y, dir.x)));
      float beam = exp(-band*8.0) * (0.4 + 0.6*sin(t+fi));
      col += vec3(0.7,0.85,1.0) * beam * 0.25 * (0.5+u_intensity);
    }
    float caustics = fbm(uv*4.0 + t) * 0.2;
    col += vec3(0.5,0.7,0.9) * caustics;
    fragColor = vec4(col, 1.0);
  }`,

  silk:
    H +
    `
  void main(){
    vec2 uv = v_uv;
    float t = u_time * (0.15 + u_intensity*0.2);
    float n = fbm(uv*3.0 + vec2(t, -t*0.5));
    float folds = sin(uv.y*12.0 + n*6.0 + t*2.0) * 0.5 + 0.5;
    vec3 silk1 = vec3(0.85, 0.78, 0.92);
    vec3 silk2 = vec3(0.35, 0.25, 0.55);
    vec3 col = mix(silk2, silk1, folds);
    col += pow(folds, 4.0) * u_color * 0.6;
    fragColor = vec4(col, 1.0);
  }`,
};
