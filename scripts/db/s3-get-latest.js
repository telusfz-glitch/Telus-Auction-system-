#!/usr/bin/env node
// Downloads the newest backup (and its .sha256) under an S3 prefix (used by scheduled-drill.sh). Credentials: the AWS
// default chain (ECS task role). Prints the local path of the dump and its age in hours, tab-separated.
//   node scripts/db/s3-get-latest.js s3://bucket/prefix/ out-dir
'use strict';
const { createWriteStream } = require('fs');
const { join } = require('path');
const { pipeline } = require('stream/promises');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

async function main() {
  const [uri, out] = process.argv.slice(2);
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri || '');
  if (!m || !out) throw new Error('usage: s3-get-latest.js s3://bucket/prefix/ out-dir');
  const [, bucket, prefixRaw] = m;
  const prefix = prefixRaw && !prefixRaw.endsWith('/') ? `${prefixRaw}/` : prefixRaw;
  const s3 = new S3Client({ forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' });
  const dumps = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (/\.dump(\.gpg)?$/.test(o.Key)) dumps.push(o);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  if (dumps.length === 0) throw new Error(`no backups under ${uri}`);
  // Names carry a UTC timestamp (telus-YYYYMMDDTHHMMSSZ.dump), so the newest sorts last.
  const newest = dumps.sort((a, b) => a.Key.localeCompare(b.Key)).at(-1);
  const name = newest.Key.split('/').pop();
  for (const key of [newest.Key, `${newest.Key}.sha256`]) {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await pipeline(res.Body, createWriteStream(join(out, key.split('/').pop())));
  }
  const ageHours = (Date.now() - new Date(newest.LastModified).getTime()) / 3_600_000;
  console.log(`${join(out, name)}\t${ageHours.toFixed(1)}`);
}
main().catch((e) => { console.error(`download failed: ${e.name}: ${e.message}`); process.exit(1); });
