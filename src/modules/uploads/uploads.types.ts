export type UploadCategory = "product" | "avatar" | "cover" | "verification";

export interface RequestUploadInput {
  filename: string;
  contentType: string;
  category: UploadCategory;
}

export interface UploadUrlResponse {
  uploadUrl: string;
  publicUrl: string;
  key: string;
}
