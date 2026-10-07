/// <reference types="vite/client" />
import type { DailyPushSettings, DailyPushView, ItineraryItem, ItineraryParseResult, ItinerarySettings, ItineraryView } from './domain/business';
import type { OpsResponse } from './domain/ops';
declare global {
  interface Window {
    opsApi: { invoke(method: string, args?: unknown): Promise<OpsResponse<unknown>> };
    travelbot: {
      openImage(path: string): Promise<boolean>;
      dailyPush(): Promise<DailyPushView>;
      saveDailyPush(input: DailyPushSettings): Promise<{ ok: boolean; stderr?: string; view?: DailyPushView }>;
      previewDailyPush(input?: DailyPushSettings): Promise<{ ok: boolean; stderr?: string; content?: string }>;
      runDailyPush(): Promise<{ ok: boolean; message: string; content?: string; errors: string[]; view?: DailyPushView }>;
      itinerary(): Promise<ItineraryView>;
      saveItinerarySettings(input: ItinerarySettings): Promise<ItineraryResult>;
      parseItinerary(text: string): Promise<ItineraryParseResult>;
      importItinerary(input: { text: string; mode: 'append' | 'replace' }): Promise<ItineraryResult & { added?: number; errors?: string[] }>;
      updateItineraryItem(input: { id: string; patch: Partial<Pick<ItineraryItem, 'separate'>> }): Promise<ItineraryResult>;
      deleteItineraryItems(input: { ids?: string[]; groupName?: string; beforeToday?: boolean }): Promise<ItineraryResult>;
      previewItineraryJob(jobId: string): Promise<{ ok: boolean; stderr?: string; content?: string }>;
      runItineraryJob(jobId: string): Promise<{ ok: boolean; message: string; errors?: string[]; view?: ItineraryView }>;
    };
  }
  interface ItineraryResult { ok: boolean; stderr?: string; view?: ItineraryView; }
}
export {};
