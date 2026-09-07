import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import type { Config } from './config.js';
import { AppError, sha256 } from './domain.js';

export interface Storage {
  uploadUrl(key: string): Promise<string>;
  read(key: string): Promise<Buffer>;
  write(key: string, bytes: Buffer): Promise<void>;
  delete(key: string): Promise<void>;
  ready(): Promise<void>;
}
export class S3Storage implements Storage {
  private client: S3Client; private publicClient: S3Client;
  constructor(private config: Config) {
    const options = { region: config.OBJECT_STORAGE_REGION, forcePathStyle: true, credentials: { accessKeyId: config.OBJECT_STORAGE_ACCESS_KEY, secretAccessKey: config.OBJECT_STORAGE_SECRET_KEY } };
    this.client = new S3Client({ ...options, endpoint: config.OBJECT_STORAGE_ENDPOINT });
    this.publicClient = new S3Client({ ...options, endpoint: config.OBJECT_STORAGE_PUBLIC_ENDPOINT ?? config.OBJECT_STORAGE_ENDPOINT });
  }
  async uploadUrl(key: string): Promise<string> {
    return getSignedUrl(this.publicClient, new PutObjectCommand({ Bucket: this.config.OBJECT_STORAGE_BUCKET, Key: key, ContentType: 'image/jpeg' }), { expiresIn: 300 });
  }
  async read(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.OBJECT_STORAGE_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(20_000) });
    if (!response.Body || (response.ContentLength ?? 0) > 10 * 1024 * 1024) throw new AppError(400, 'INVALID_FILE_SIZE', 'Maximum file size is 10 MiB');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) { (response.Body as { destroy?: () => void }).destroy?.(); throw new AppError(400, 'INVALID_FILE_SIZE', 'Maximum file size is 10 MiB'); }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  async write(key: string, bytes: Buffer): Promise<void> { await this.client.send(new PutObjectCommand({ Bucket: this.config.OBJECT_STORAGE_BUCKET, Key: key, Body: bytes, ContentType: 'image/jpeg' }), { abortSignal: AbortSignal.timeout(20_000) }); }
  async delete(key: string): Promise<void> { await this.client.send(new DeleteObjectCommand({ Bucket: this.config.OBJECT_STORAGE_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(20_000) }); }
  async ready(): Promise<void> { await this.client.send(new HeadBucketCommand({ Bucket: this.config.OBJECT_STORAGE_BUCKET }), { abortSignal: AbortSignal.timeout(10_000) }); }
}
export async function validateImage(bytes: Buffer, expectedHash: string, expectedSize: number): Promise<void> {
  if (bytes.length !== expectedSize || bytes.length > 10 * 1024 * 1024) throw new AppError(400, 'INVALID_FILE_SIZE', 'File size does not match upload declaration');
  if (sha256(bytes) !== expectedHash) throw new AppError(400, 'HASH_MISMATCH', 'Uploaded bytes do not match SHA-256');
  try {
    const metadata = await sharp(bytes, { limitInputPixels: 25_000_000, failOn: 'warning' }).metadata();
    if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height || metadata.width * metadata.height > 25_000_000 || metadata.exif || metadata.xmp || metadata.iptc) throw new Error('Invalid or unsanitized JPEG');
    // Force full decode: metadata alone accepts truncated images.
    await sharp(bytes, { limitInputPixels: 25_000_000, failOn: 'warning' }).stats();
  } catch { throw new AppError(400, 'INVALID_IMAGE', 'Upload a valid JPEG without EXIF, XMP or IPTC, at most 25 megapixels'); }
}
