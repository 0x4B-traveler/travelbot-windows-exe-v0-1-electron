/// <reference types="vite/client" />
import type { OpsResponse } from './domain/ops';
declare global {
  interface Window {
    opsApi: { invoke(method: string, args?: unknown): Promise<OpsResponse<unknown>> };
  }
}
export {};
