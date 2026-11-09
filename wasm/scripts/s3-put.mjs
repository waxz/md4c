// Uploads with HTTP headers for the r2 and s3 adapters.
//
// storagesdk's S3 adapter (which its R2 adapter uses) drops the
// `cacheControl` upload option, so files uploaded through it are served
// without Cache-Control. Browsers then guess how long to keep them, from
// their age, and after a deploy one may run a new script with an old
// module it still has: "does not provide an export named ...". So
// publish.mjs sends its uploads that carry cacheControl through here,
// with the same env vars as the adapter.

/** (key, body, { contentType, cacheControl }) => Promise, or null for other adapters. */
export async function s3Put(adapter, env = process.env, bucket) {
  if (adapter !== 'r2' && adapter !== 's3') return null;
  // An optional dependency, as for storagesdk's own S3 adapter.
  const { PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
  let client;
  if (adapter === 'r2') {
    client = new S3Client({
      region: 'auto',
      endpoint: env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      forcePathStyle: true, // R2 accepts both; path style also works with any endpoint
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    });
    bucket ??= env.R2_BUCKET;
  } else {
    client = new S3Client({
      region: env.S3_REGION || env.AWS_REGION || 'us-east-1',
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      ...(/^(1|true)$/i.test(env.S3_FORCE_PATH_STYLE ?? '') ? { forcePathStyle: true } : {}),
      ...(env.S3_ACCESS_KEY_ID ? { credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } } : {}),
    });
    bucket ??= env.S3_BUCKET;
  }
  return (key, body, { contentType, cacheControl } = {}) => client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: typeof body === 'string' ? Buffer.from(body) : body,
    ...(contentType ? { ContentType: contentType } : {}),
    ...(cacheControl ? { CacheControl: cacheControl } : {}),
  }));
}
