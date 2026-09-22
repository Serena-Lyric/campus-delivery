import { randomUUID } from 'node:crypto';

export type MediaInput = {
  fileName: string;
  contentType: string;
  capturedAt?: string;
  source?: 'CAMERA' | 'UNKNOWN';
};

export interface MediaStorage {
  createReference(orderId: string, input: MediaInput): Promise<string>;
}

export class MockMediaStorage implements MediaStorage {
  async createReference(orderId: string, input: MediaInput): Promise<string> {
    const safeName = encodeURIComponent(input.fileName.replace(/[\\/]/g, '_'));
    return `mock://evidence/${orderId}/${randomUUID()}/${safeName}`;
  }
}
