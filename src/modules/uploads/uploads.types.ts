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
}
