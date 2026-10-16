import { getMediaBucket } from "./r2-storage.server";

export async function deleteR2Prefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1_000, cursor });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function deleteWorkspaceMedia(userId: string) {
  const bucket = getMediaBucket();
  await Promise.all(
    [`avatars/${userId}`, `users/${userId}/`, `private/users/${userId}/`, `og/v2/${userId}/`].map(
      (prefix) => deleteR2Prefix(bucket, prefix),
    ),
  );
}
