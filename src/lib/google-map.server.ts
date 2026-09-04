import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { configuredAppOrigin, configuredPublicOrigin } from "./application-urls";

export const GOOGLE_MAP_EMBED_PATH = "/api/maps/embed";

type MapEmbedDependencies = {
  isActiveCustomDomain?: (hostname: string) => Promise<boolean>;
};

function numberParam(url: URL, key: string, min: number, max: number) {
  const value = Number(url.searchParams.get(key));
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function mapsKey(env: unknown) {
  if (env && typeof env === "object") {
    const value = (env as Record<string, unknown>).GOOGLE_MAPS_BROWSER_KEY;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return process.env.GOOGLE_MAPS_BROWSER_KEY?.trim() || null;
}

async function defaultIsActiveCustomDomain(hostname: string) {
  const { data, error } = await supabaseAdmin
    .from("custom_domains")
    .select("id")
    .eq("hostname", hostname)
    .eq("status", "active")
    .eq("ssl_status", "active")
    .maybeSingle();
  return !error && !!data;
}

async function allowedParentOrigin(
  request: Request,
  env: unknown,
  dependencies: MapEmbedDependencies,
): Promise<string | null> {
  const referer = request.headers.get("referer");
  if (!referer) return null;
  let parent: URL;
  try {
    parent = new URL(referer);
  } catch {
    return null;
  }
  const localParent = parent.hostname === "localhost" || parent.hostname === "127.0.0.1";
  if (parent.protocol !== "https:" && !(localParent && parent.protocol === "http:")) {
    return null;
  }
  const values = env as { VITE_APP_URL?: unknown; VITE_PUBLIC_URL?: unknown } | undefined;
  const trustedOrigins = new Set([
    configuredAppOrigin(typeof values?.VITE_APP_URL === "string" ? values.VITE_APP_URL : undefined),
    configuredPublicOrigin(
      typeof values?.VITE_PUBLIC_URL === "string" ? values.VITE_PUBLIC_URL : undefined,
    ),
  ]);
  if (trustedOrigins.has(parent.origin)) {
    return parent.origin;
  }
  const hostname = parent.hostname.toLowerCase();
  const isActive = await (dependencies.isActiveCustomDomain ?? defaultIsActiveCustomDomain)(
    hostname,
  );
  return isActive ? parent.origin : null;
}

function escapeJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function mapHtml(
  key: string,
  parentOrigin: string,
  view: { mapLat: number; mapLng: number; mapZoom: number },
  interactive: boolean,
) {
  const configuration = escapeJson({ ...view, interactive, parentOrigin });
  const scriptUrl = new URL("https://maps.googleapis.com/maps/api/js");
  scriptUrl.searchParams.set("key", key);
  scriptUrl.searchParams.set("loading", "async");
  scriptUrl.searchParams.set("callback", "initBentoMap");
  scriptUrl.searchParams.set("v", "weekly");

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>
html,body,#map{width:100%;height:100%;margin:0;overflow:hidden;background:#e8eef4}*{box-sizing:border-box}
</style></head><body><div id="map" role="img" aria-label="Google Map"></div><script>
const config=${configuration};
let map;
let userGesture=false;
function validView(value){return value&&Number.isFinite(value.mapLat)&&Number.isFinite(value.mapLng)&&Number.isFinite(value.mapZoom)}
function initBentoMap(){
  const canvas=document.getElementById("map");
  map=new google.maps.Map(canvas,{
    center:{lat:config.mapLat,lng:config.mapLng},zoom:config.mapZoom,minZoom:2,maxZoom:18,
    mapTypeId:"roadmap",disableDefaultUI:true,clickableIcons:false,
    gestureHandling:config.interactive?"greedy":"none",keyboardShortcuts:config.interactive,
    disableDoubleClickZoom:!config.interactive,backgroundColor:"#e8eef4"
  });
  if(config.interactive){
    const mark=()=>{userGesture=true};
    canvas.addEventListener("pointerdown",mark,{passive:true});
    canvas.addEventListener("wheel",mark,{passive:true});
    canvas.addEventListener("keydown",mark);
    map.addListener("idle",()=>{
      if(!userGesture)return;
      userGesture=false;
      const center=map.getCenter();
      parent.postMessage({type:"bento-map-view",mapLat:center.lat(),mapLng:center.lng(),mapZoom:map.getZoom()},config.parentOrigin);
    });
  }
}
addEventListener("message",event=>{
  if(event.source!==parent||event.origin!==config.parentOrigin||!map||event.data?.type!=="bento-map-set-view"||!validView(event.data))return;
  map.setCenter({lat:event.data.mapLat,lng:event.data.mapLng});
  map.setZoom(event.data.mapZoom);
});
</script><script async src="${scriptUrl.toString().replace(/&/g, "&amp;")}"></script></body></html>`;
}

export async function handleGoogleMapEmbedRequest(
  request: Request,
  env: unknown,
  dependencies: MapEmbedDependencies = {},
) {
  const url = new URL(request.url);
  if (url.pathname !== GOOGLE_MAP_EMBED_PATH) return null;
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const mapLat = numberParam(url, "lat", -90, 90);
  const mapLng = numberParam(url, "lng", -180, 180);
  const mapZoom = numberParam(url, "zoom", 2, 18);
  if (mapLat === null || mapLng === null || mapZoom === null) {
    return new Response("Invalid map view", { status: 400 });
  }
  const parentOrigin = await allowedParentOrigin(request, env, dependencies);
  if (!parentOrigin) return new Response("Map embed is not allowed", { status: 403 });
  const key = mapsKey(env);
  if (!key) return new Response("Google Maps is not configured", { status: 503 });

  const interactive = url.searchParams.get("interactive") === "1";
  return new Response(mapHtml(key, parentOrigin, { mapLat, mapLng, mapZoom }, interactive), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "content-security-policy": `frame-ancestors 'self' ${parentOrigin}`,
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
    },
  });
}
