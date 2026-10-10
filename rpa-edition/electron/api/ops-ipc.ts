import { ipcMain } from 'electron';
import type { BackupResult, OpsApi, OpsMethod, OpsResponse } from '../../src/domain/ops';
import type { SampleDataService } from '../application/sample-data';
import { OpsError, type DashboardService, type GroupService, type LogService, type MailAlertService, type MaterialService, type PlanService, type RouteService, type SendSettingsService, type TemplateService } from '../application/services';

// API 层：界面只能通过这一个 IPC 通道调用 Service，不能直接访问 SQLite 或桌面客户端。
export type BackupApi = { export(): Promise<BackupResult | null>; restore(): Promise<string | null> };
export type OpsServices = {
  dashboard: DashboardService; materials: MaterialService; routes: RouteService; templates: TemplateService; plans: PlanService; groups: GroupService;
  logs: LogService; sendSettings: SendSettingsService; mail: MailAlertService; samples: SampleDataService; backup: BackupApi;
};

export function registerOpsApi(services: OpsServices) {
  const { dashboard, materials, routes, templates, plans, groups, logs, sendSettings, mail, samples, backup } = services;
  const handlers: { [K in OpsMethod]: (args: any) => ReturnType<OpsApi[K]> | Awaited<ReturnType<OpsApi[K]>> } = {
    'dashboard.get': () => dashboard.get(),

    'material.list': query => materials.list(query ?? {}),
    'material.facets': () => materials.facets(),
    'material.save': input => materials.save(input),
    'material.delete': ({ id }) => materials.delete(id),
    'material.import': ({ text }) => materials.import(String(text ?? '')),
    'material.addImages': ({ id }) => materials.addImages(id),
    'material.removeImage': ({ id, imageId }) => materials.removeImage(id, imageId),
    'material.imageData': ({ imageId }) => materials.imageData(imageId),
    'sample.load': ({ name, testTour }) => samples.load(String(name ?? ''), Boolean(testTour)),

    'route.list': query => routes.list(query ?? {}),
    'route.save': input => routes.save(input),
    'route.delete': ({ id }) => routes.delete(id),
    'route.parseDays': ({ text }) => routes.parseDays(String(text ?? '')),

    'template.list': () => templates.list(),
    'template.save': ({ key, body }) => templates.save(key, body),
    'template.reset': ({ key }) => templates.reset(key),
    'weatherRule.list': () => templates.weatherRules(),
    'weatherRule.save': ({ rules }) => templates.saveWeatherRules(rules),
    'weatherRule.test': ({ city, date }) => templates.test(String(city ?? ''), String(date ?? '')),

    'plan.list': query => plans.list(query ?? {}),
    'plan.preview': ({ groupId, date }) => plans.preview(groupId, date),
    'plan.skip': ({ groupId, date }) => plans.skip(groupId, date),
    'plan.unskip': ({ groupId, date }) => plans.unskip(groupId, date),
    'plan.retry': ({ id }) => plans.retry(id),
    'plan.sendNow': ({ groupId, date }) => plans.sendNow(groupId, date),
    'plan.sendToSelf': ({ groupId, date }) => plans.sendToSelf(groupId, date),

    'group.list': () => groups.list(),
    'group.add': input => groups.add(input),
    'group.update': input => groups.update(input),
    'group.sendMessage': ({ id, text }) => plans.sendMessage(id, String(text ?? '')),
    'group.delete': ({ id }) => groups.delete(id),

    'settings.getSend': () => sendSettings.get(),
    'settings.saveSend': input => sendSettings.save(input),
    'settings.checkRpa': ({ rpa }) => sendSettings.checkRpa(rpa),
    'settings.checkAccount': ({ account }) => sendSettings.checkAccount(account),
    'settings.agentInfo': () => sendSettings.agent(),
    'settings.getMail': () => mail.get(),
    'settings.saveMail': input => mail.save(input),
    'settings.testMail': input => mail.test(input),

    'backup.export': () => backup.export(),
    'backup.restore': () => backup.restore(),

    'log.list': query => logs.list(query ?? {}),
  };

  ipcMain.handle('ops:invoke', async (_event, method: string, args: unknown): Promise<OpsResponse<unknown>> => {
    if (!Object.prototype.hasOwnProperty.call(handlers, method)) return { ok: false, error: `未知操作：${method}` };
    try {
      return { ok: true, data: await handlers[method as OpsMethod]((args ?? {}) as any) };
    } catch (error: any) {
      if (!(error instanceof OpsError)) logs.write({ module: 'System', action: method, status: 'fail', message: error?.message || String(error), detail: error?.stack });
      return { ok: false, error: error?.message || '操作失败' };
    }
  });
}
