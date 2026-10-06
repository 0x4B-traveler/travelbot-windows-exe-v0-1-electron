/// <reference types="vite/client" />
import type { CustomerGroup, DailyPushSettings, DailyPushView, GroupMessageConfigInput, GroupMessageConfigView, ItineraryItem, ItineraryParseResult, ItinerarySettings, ItineraryView } from './domain/business';
import type { OpsResponse } from './domain/ops';
declare global {
  interface Window {
    opsApi: { invoke(method: string, args?: unknown): Promise<OpsResponse<unknown>> };
    travelbot: {
      authStatus(): Promise<CliResult>;
      startAuth(): Promise<CliResult & { pending?: boolean; qrcode?: string | null; qrcodeDataUrl?: string | null }>;
      openImage(path: string): Promise<boolean>;
      groupMessageConfig(): Promise<GroupMessageConfigView>;
      saveGroupMessageConfig(input: GroupMessageConfigInput): Promise<{ ok: boolean; stderr?: string; config?: GroupMessageConfigView }>;
      dailyPush(): Promise<DailyPushView>;
      saveDailyPush(input: DailyPushSettings): Promise<{ ok: boolean; stderr?: string; view?: DailyPushView }>;
      dailyPushGroups(ownerUserIds: string[]): Promise<{ ok: boolean; stderr?: string; groups: CustomerGroup[] }>;
      previewDailyPush(input?: DailyPushSettings): Promise<{ ok: boolean; stderr?: string; content?: string }>;
      runDailyPush(): Promise<{ ok: boolean; message: string; content?: string; errors: string[]; view?: DailyPushView }>;
      itinerary(): Promise<ItineraryView>;
      saveItinerarySettings(input: ItinerarySettings): Promise<ItineraryResult>;
      loadItineraryGroups(ownerUserIds: string[]): Promise<ItineraryResult>;
      parseItinerary(text: string): Promise<ItineraryParseResult>;
      importItinerary(input: { text: string; mode: 'append' | 'replace' }): Promise<ItineraryResult & { added?: number; errors?: string[] }>;
      updateItineraryItem(input: { id: string; patch: Partial<Pick<ItineraryItem, 'separate'>> }): Promise<ItineraryResult>;
      deleteItineraryItems(input: { ids?: string[]; groupName?: string; beforeToday?: boolean }): Promise<ItineraryResult>;
      previewItineraryJob(jobId: string): Promise<{ ok: boolean; stderr?: string; content?: string }>;
      runItineraryJob(jobId: string): Promise<{ ok: boolean; message: string; errors?: string[]; view?: ItineraryView }>;
      checkItineraryConfirmations(): Promise<ItineraryResult & { confirmed?: number }>;
    };
  }
  interface ItineraryResult { ok: boolean; stderr?: string; view?: ItineraryView; }
  interface CliResult { ok: boolean; stdout?: string; stderr?: string; step?: string; pending?: boolean; }
}
export {};
