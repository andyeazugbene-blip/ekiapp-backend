export type UploadCategory = "product" | "avatar" | "cover" | "verification" | "message";

export interface RequestUploadInput {
  filename: string;
  contentType: string;
  category: UploadCategory;
}

export interface UploadUrlResponse {
  assetId: string;
  uploadUrl: string;
  publicUrl?: string;
  key: string;
}

export interface CompleteUploadInput {
  assetId: string;
  key: string;
  sizeBytes?: number;
  /** What the asset is attached to (optional; inferred for avatar/cover/verification). */
  entityType?: UploadEntityType;
  entityId?: string;
}

export const UPLOAD_ENTITY_TYPES = ["product", "store", "user", "message", "review", "vendor_verification"] as const;
export type UploadEntityType = (typeof UPLOAD_ENTITY_TYPES)[number];
