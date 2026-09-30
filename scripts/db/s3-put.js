#!/usr/bin/env node
// Uploads files to S3 (used by backup.sh when BACKUP_S3_URI is set). Credentials: the AWS default chain (ECS task role).
// Each object carries its SHA-256 so S3 rejects a corrupted upload; the bucket's default Object Lock retention applies.
//   node scripts/db/s3-put.js s3://bucket/prefix/ file [file…]
'use strict';
const { createReadStream, readFileSync, statSync } = require('fs');
const { basename } = require('path');
const { createHash } = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

async function main() {
  const [uri, ...files] = process.argv.slice(2);
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri || '');
  if (!m || files.length === 0) throw new Error('usage: s3-put.js s3://bucket/prefix/ file [file…]');
  const [, bucket, prefixRaw] = m;
  const prefix = prefixRaw && !prefixRaw.endsWith('/') ? `${prefixRaw}/` : prefixRaw;
  const s3 = new S3Client({ forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' });
  for (const file of files) {
    const sha = createHash('sha256').update(readFileSync(file)).digest('base64');
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: `${prefix}${basename(file)}`, Body: createReadStream(file), ContentLength: statSync(file).size,
      ChecksumAlgorithm: 'SHA256', ChecksumSHA256: sha, ServerSideEncryption: process.env.BACKUP_S3_SSE === 'AES256' ? 'AES256' : 'aws:kms',
    }));
    console.log(`s3://${bucket}/${prefix}${basename(file)}`);
  }
}
main().catch((e) => { console.error(`upload failed: ${e.name}: ${e.message}`); process.exit(1); });
