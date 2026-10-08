import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const DEFAULT_SOURCE = 'E:\\audios';
const DEFAULT_ENDPOINT = 'https://s3.wispace.app';
const DEFAULT_BUCKET = 'aihub-speaking-samples';
const DEFAULT_REGION = 'us-east-1';
const OBJECT_PREFIX = 'speaking-samples';

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function contentType(extension) {
  return extension === 'mp3' ? 'audio/mpeg' : 'audio/webm';
}

function storageConfig() {
  const endpoint =
    option('--endpoint') ??
    process.env.SEAWEEDFS_ENDPOINT_URL?.trim() ??
    DEFAULT_ENDPOINT;
  const bucket =
    option('--bucket') ??
    process.env.SEAWEEDFS_BUCKET?.trim() ??
    DEFAULT_BUCKET;
  const region =
    option('--region') ??
    process.env.SEAWEEDFS_REGION?.trim() ??
    DEFAULT_REGION;

  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 's3.wispace.app' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('SEAWEEDFS_ENDPOINT_URL must be https://s3.wispace.app');
  }
  if (!bucket || !region) throw new Error('bucket and region are required');

  return {
    endpoint,
    bucket,
    region,
    accessKeyId: required('SEAWEEDFS_ACCESS_KEY_ID'),
    secretAccessKey: required('SEAWEEDFS_SECRET_ACCESS_KEY'),
  };
}

async function sourceObjects(source) {
  const directories = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));

  if (directories.length === 0)
    throw new Error(`No question folders found in ${source}`);

  const objects = [];
  for (const directory of directories) {
    const directoryPath = path.join(source, directory.name);
    const entries = (
      await readdir(directoryPath, { withFileTypes: true })
    ).filter((entry) => entry.isFile());
    if (entries.length !== 1) {
      throw new Error(`Expected one audio file in ${directoryPath}`);
    }

    const file = entries[0];
    const match = /^Part([123]) - (.+)\.(mp3|webm)$/i.exec(file.name);
    if (!match || match[2] !== directory.name) {
      throw new Error(
        `File must be named "PartN - <folder name>.mp3|webm": ${path.join(directoryPath, file.name)}`,
      );
    }

    const extension = match[3].toLowerCase();
    const filePath = path.join(directoryPath, file.name);
    const fileStat = await stat(filePath);
    objects.push({
      part: Number(match[1]),
      filePath,
      fileName: file.name,
      bytes: fileStat.size,
      key: `${OBJECT_PREFIX}/part-${match[1]}/${slug(directory.name)}.${extension}`,
      contentType: contentType(extension),
    });
  }
  return objects;
}

function bucketMissing(error) {
  return (
    error?.name === 'NotFound' ||
    error?.name === 'NoSuchBucket' ||
    error?.$metadata?.httpStatusCode === 404
  );
}

async function ensureBucket(client, bucket) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return false;
  } catch (error) {
    if (!bucketMissing(error)) throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    return true;
  }
}

async function main() {
  const source = path.resolve(
    option('--source') ?? process.env.SPEAKING_AUDIO_SOURCE ?? DEFAULT_SOURCE,
  );
  const dryRun = process.argv.includes('--dry-run');
  const objects = await sourceObjects(source);

  if (dryRun) {
    console.log(JSON.stringify({ source, objects }, null, 2));
    return;
  }

  const config = storageConfig();
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const created = await ensureBucket(client, config.bucket);

  for (const object of objects) {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: object.key,
        Body: createReadStream(object.filePath),
        ContentLength: object.bytes,
        ContentType: object.contentType,
      }),
    );
    await client.send(
      new HeadObjectCommand({ Bucket: config.bucket, Key: object.key }),
    );
  }

  console.log(
    JSON.stringify(
      {
        bucket: config.bucket,
        source,
        bucketCreated: created,
        uploaded: objects.length,
        parts: objects.reduce((counts, object) => {
          counts[object.part] = (counts[object.part] ?? 0) + 1;
          return counts;
        }, {}),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Audio upload failed');
  process.exitCode = 1;
});
