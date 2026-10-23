/** Remove credentials and temporary bearer capabilities from externally readable data. */
const SECRET_FIELDS = new Set([
  "token",
  "tokenhash",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "secret",
  "clientsecret",
  "authorization",
  "cookie",
  "password",
  "privatekey",
  "servicerolekey",
  "publishablekey",
  "providertoken",
  "webhooksecret",
  "accesstokenenc",
  "refreshtokenenc",
  "apikeyhash",
  "oauthtoken",
  "bearertoken",
  "authorizationheader",
  "webhooksigningsecret",
  "credentials",
  "uploadsessionurl",
  "signedurl",
  "signeddownloadurl",
  "signeduploadurl",
]);
const CAPABILITY_PARAMS = new Set([
  "token",
  "access_token",
  "api_key",
  "apikey",
  "signature",
  "sig",
  "x-amz-signature",
  "x-goog-signature",
  "upload_id",
  "upload_token",
]);

export function sanitizeMcpReadData<T>(value: T): T {
  function clean(item: unknown, field = ""): unknown {
    const normalized = field.replace(/[_-]/g, "").toLowerCase();
    if (SECRET_FIELDS.has(normalized)) return undefined;
    if (typeof item === "string" && /(?:url|uri|href|src)s?$/i.test(field)) {
      try {
        const url = new URL(item);
        if (
          url.username ||
          url.password ||
          [...url.searchParams.keys()].some((key) => CAPABILITY_PARAMS.has(key.toLowerCase()))
        ) {
          return undefined;
        }
      } catch {
        /* Plain text is retained verbatim. */
      }
    }
    if (Array.isArray(item))
      return item.map((entry) => clean(entry, field)).filter((entry) => entry !== undefined);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item).flatMap(([key, entry]) => {
          const result = clean(entry, key);
          return result === undefined ? [] : [[key, result]];
        }),
      );
    }
    return item;
  }
  return clean(value) as T;
}
