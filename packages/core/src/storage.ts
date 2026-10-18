import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	type PutObjectCommandInput,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DEFAULT_PRESIGN_EXPIRY_SECONDS } from "./constants";
import type { StorageClient, StorageConfig } from "./types";

export function createStorageClient(config: StorageConfig): StorageClient {
	const client = new S3Client({
		region: "auto",
		endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
		},
	});

	return {
		async createUploadUrl(options) {
			const command = new PutObjectCommand({
				Bucket: config.bucket,
				Key: options.key,
				ContentType: options.contentType,
				Metadata: options.metadata,
				...(options.storageClass
					? { StorageClass: options.storageClass as PutObjectCommandInput["StorageClass"] }
					: {}),
				...(options.contentDisposition ? { ContentDisposition: options.contentDisposition } : {}),
			});

			return getSignedUrl(client, command, {
				expiresIn: options.expiresIn ?? DEFAULT_PRESIGN_EXPIRY_SECONDS,
			});
		},

		async createDownloadUrl(options) {
			const command = new GetObjectCommand({
				Bucket: config.bucket,
				Key: options.key,
			});

			return getSignedUrl(client, command, {
				expiresIn: options.expiresIn ?? DEFAULT_PRESIGN_EXPIRY_SECONDS,
			});
		},

		async deleteObject(key) {
			await client.send(
				new DeleteObjectCommand({
					Bucket: config.bucket,
					Key: key,
				}),
			);
		},

		async headObject(key) {
			try {
				const response = await client.send(
					new HeadObjectCommand({
						Bucket: config.bucket,
						Key: key,
					}),
				);

				return {
					size: response.ContentLength ?? 0,
					contentType: response.ContentType ?? "application/octet-stream",
					lastModified: response.LastModified ?? new Date(),
				};
			} catch (error: unknown) {
				if (error instanceof Error && "name" in error && error.name === "NotFound") {
					return null;
				}
				throw error;
			}
		},
	};
}
