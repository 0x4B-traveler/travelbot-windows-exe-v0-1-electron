import { randomUUID } from 'node:crypto';
import {
  MATERIAL_KIND_LABELS, TEMPLATE_KEYS, TEMPLATE_META, WEATHER_RULE_KIND_LABELS,
  addDays, daysBetween, localDateText, parseDateText, shortDate, tourPhase,
  type BatchPreview, type Dashboard, type DayWeather, type GroupAddInput, type GroupUpdateInput, type ImportResult, type LogEntry, type LogQuery, type Material, type MaterialFacets,
  type MaterialInput, type MaterialKind, type MaterialQuery, type MessageTemplate, type OpsGroup, type PlanMessage, type PlanQuery, type Route, type RouteDay, type RouteDaysImport, type RouteInput,
  type RouteQuery, type SendBatch, type TemplateKey, type Tour, type TourInput, type TourScheduleSettings, type WeatherRule, type WeatherRuleKind,
  builtInGuard, DEFAULT_AGENT_PORT, DEFAULT_SEND_SETTINGS, DEFAULT_TOUR_SCHEDULE, LOCAL_ACCOUNT_ID, MANUAL_CHAT_PREFIX, SELF_CHAT_NAME, resolveAccount,
  type AccountStatus, type MailSettings, type MailSettingsInput, type MailSettingsView, type PoolSettings, type RpaAccount, type RpaGuard, type RpaSettings, type SendSettings,
} from '../../src/domain/ops';
import { BatchRepository, GroupRepository, LogRepository, MaterialRepository, RouteRepository, TemplateRepository, WeatherRuleRepository, type StoredBatch, type StoredGroup } from '../infrastructure/repositories';
import type { FilePicker, MailSender, MailSettingsStore, FileStore, RpaAccountClient, SendSettingsStore, WeatherGateway } from './ports';
import { GuardBlocked, nextActiveStart, type RpaExecutor } from './rpa-executor';

// Application 层：每个服务只管自己模块的业务规则，跨模块协作通过调用其他服务，不直接碰别人的表或桌面客户端。

export class OpsError extends Error {}
const fail = (message: string): never => { throw new OpsError(message); };
const nowIso = () => new Date().toISOString();
const fmt = (date: Date) => date.toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const cleanList = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))];
function startOfLocalDay(date: Date) { const day = new Date(date); day.setHours(0, 0, 0, 0); return day; }
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
/** 某天的 HH:mm 对应的时刻。 */
function atTime(date: string, hhmm: string): Date { const day = parseDateText(date)!; const [hour, minute] = hhmm.split(':').map(Number); day.setHours(hour, minute, 0, 0); return day; }

// ───────── 运行日志 ─────────
export class LogService {
  constructor(private readonly repo: LogRepository) {}
  write(entry: Omit<LogEntry, 'id' | 'time'>) { try { this.repo.add(entry); } catch { /* 日志失败不能影响业务 */ } }
  list(query: LogQuery) { return this.repo.list(query); }
  sentToday(groupName: string) { return this.repo.countSentSince(groupName, startOfLocalDay(new Date()).toISOString()); }
  rpaSentSince(account: string, since: Date, groupName?: string) { return this.repo.countRpaSentSince(account, since.toISOString(), groupName); }
  batchStarted(account: string, batchId: string) { return this.repo.batchStarted(account, batchId); }
  /** 只保留最近 60 天的日志。 */
  prune() { this.repo.prune(new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString()); }
}

// ───────── 素材库（路线之外的酒店、景点攻略等） ─────────
const KIND_BY_LABEL = new Map(Object.entries(MATERIAL_KIND_LABELS).map(([kind, label]) => [label, kind as MaterialKind]));

export class MaterialService {
  constructor(private readonly repo: MaterialRepository, private readonly routes: RouteRepository, private readonly files: FileStore, private readonly picker: FilePicker) {}

  list(query: MaterialQuery) { return this.repo.list(query); }
  facets(): MaterialFacets { return this.repo.facets(); }
  getMany(ids: string[]) { return this.repo.getMany(ids); }

  save(input: MaterialInput): Material {
    const fields = { kind: input.kind, title: input.title.trim(), body: input.body.trim(), city: input.city.trim(), tags: cleanList(input.tags) };
    if (!fields.title) fail('请填写素材名称');
    if (!MATERIAL_KIND_LABELS[fields.kind]) fail('素材类型不正确');
    if (input.id) return this.repo.update(input.id, fields) ?? fail('素材不存在或已被删除');
    return this.repo.insert({ ...fields, source: 'manual' });
  }

  delete(id: string) {
    const paths = this.repo.imagePaths(id);
    if (!this.repo.delete(id)) fail('素材不存在或已被删除');
    paths.forEach(path => this.files.remove(path));
    this.routes.unlinkMaterial(id);
  }

  /** 从 Excel 复制的表格（制表符分隔）导入，第一行可以是表头：名称 类型 城市 标签 简介。 */
  import(text: string): ImportResult {
    const lines = text.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim());
    if (!lines.length) fail('没有可导入的内容');
    const errors: string[] = []; let added = 0;
    const header = lines[0].split('\t').map(cell => cell.trim());
    const hasHeader = header.includes('名称');
    const index = (name: string, fallback: number) => (hasHeader ? header.indexOf(name) : fallback);
    const columns = { title: index('名称', 0), kind: index('类型', 1), city: index('城市', 2), tags: index('标签', 3), body: index('简介', 4) };
    lines.slice(hasHeader ? 1 : 0).forEach((line, offset) => {
      const cells = line.split('\t').map(cell => cell.trim());
      const cell = (column: number) => (column >= 0 ? cells[column] ?? '' : '');
      const rowNo = offset + (hasHeader ? 2 : 1);
      const title = cell(columns.title);
      if (!title) { errors.push(`第 ${rowNo} 行：缺少名称`); return; }
      const kindText = cell(columns.kind);
      const kind = KIND_BY_LABEL.get(kindText) ?? (kindText ? undefined : 'spot');
      if (!kind) { errors.push(`第 ${rowNo} 行：类型“${kindText}”不认识，可用：${[...KIND_BY_LABEL.keys()].join('、')}`); return; }
      this.repo.insert({ kind, title, city: cell(columns.city), tags: cleanList(cell(columns.tags).split(/[,，、/\s]+/)), body: cell(columns.body), source: 'excel' });
      added += 1;
    });
    return { added, errors };
  }

  async addImages(id: string): Promise<Material> {
    if (!this.repo.get(id)) fail('素材不存在或已被删除');
    for (const path of await this.picker.pickImages()) this.repo.addImage(id, this.files.importFile(path), '');
    return this.repo.get(id)!;
  }

  removeImage(id: string, imageId: string): Material {
    const path = this.repo.removeImage(id, imageId);
    if (path) this.files.remove(path);
    return this.repo.get(id) ?? fail('素材不存在或已被删除');
  }

  /** 图片在本机的保存路径（RPA 发图用）。 */
  imageFile(imageId: string): string | null { return this.repo.imagePath(imageId); }

  imageData(imageId: string) {
    const path = this.repo.imagePath(imageId);
    return path ? this.files.dataUrl(path) : null;
  }
}

// ───────── 路线（素材库的核心） ─────────
const ROUTE_HEADERS = { day: ['第几天', '天数', '天', '日'], city: ['城市', '所在城市'], plan: ['行程', '当天行程', '明日行程'], hotel: ['酒店', '当晚酒店', '住宿'], spots: ['景点', '景点攻略', '攻略'] };
const splitNames = (text: string) => cleanList(text.split(/[、,，;；/|]+/));

export class RouteService {
  constructor(private readonly repo: RouteRepository, private readonly materials: MaterialRepository, private readonly groups: GroupRepository, private readonly logs: LogService) {}

  list(query: RouteQuery) { return this.repo.list(query); }
  get(id: string) { return this.repo.get(id) ?? fail('路线不存在或已被删除'); }
  find(id: string) { return this.repo.get(id); }

  save(input: RouteInput): Route {
    const name = String(input.name ?? '').trim();
    if (!name) fail('请填写路线名称');
    const plans = Array.isArray(input.dayPlans) ? input.dayPlans : [];
    if (!plans.length) fail('路线至少要有一天');
    const linked = cleanList(plans.flatMap(day => [day.hotelId ?? '', ...(day.spotIds ?? [])]));
    const existing = new Map(this.materials.getMany(linked).map(material => [material.id, material]));
    // 按顺序重新编号：第 1 天、第 2 天……
    const dayPlans: RouteDay[] = plans.map((day, index) => ({
      day: index + 1,
      city: String(day.city ?? '').trim(),
      plan: String(day.plan ?? '').trim(),
      hotelId: day.hotelId && existing.get(day.hotelId)?.kind === 'hotel' ? day.hotelId : undefined,
      spotIds: cleanList(day.spotIds ?? []).filter(id => existing.has(id)),
    }));
    const missingCity = dayPlans.find(day => !day.city);
    if (missingCity) fail(`第 ${missingCity.day} 天还没填城市（查天气要用）`);
    const current = input.id ? this.repo.get(input.id) : null;
    if (input.id && !current) fail('路线不存在或已被删除');
    const saved = this.repo.save({
      id: current?.id ?? randomUUID(), createdAt: current?.createdAt, name, city: dayPlans[0].city, days: dayPlans.length, tags: cleanList(input.tags ?? []),
      summary: String(input.summary ?? '').trim(), status: input.status === 'disabled' ? 'disabled' : 'enabled', dayPlans,
    });
    if (current && current.days !== saved.days) this.logs.write({ module: 'Tour', action: '修改路线', status: 'info', message: `“${saved.name}”从 ${current.days} 天改为 ${saved.days} 天，用这条路线的团按新天数发送` });
    return saved;
  }

  delete(id: string) {
    const route = this.get(id);
    const today = localDateText(new Date());
    const active = this.groups.byRoute(id).filter(group => group.tour && group.tour.state !== 'cancelled' && tourPhase(group.tour.startDate, route.days, today).phase !== 'ended');
    if (active.length) fail(`还有 ${active.length} 个团在用这条路线（${active.map(group => group.name).join('、')}），等团结束或换路线后再删`);
    this.repo.delete(id);
  }

  /** 从 Excel 复制的日程表：第几天、城市、行程、酒店、景点。酒店和景点按名称找素材，找不到的新建一条空素材，之后到素材库补介绍和攻略图。 */
  parseDays(text: string): RouteDaysImport {
    const lines = String(text ?? '').split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim());
    if (!lines.length) fail('没有可导入的内容');
    const header = lines[0].split('\t').map(cell => cell.trim());
    const find = (names: string[]) => header.findIndex(cell => names.includes(cell));
    const hasHeader = find(ROUTE_HEADERS.city) >= 0 || find(ROUTE_HEADERS.plan) >= 0;
    const columns = hasHeader
      ? { day: find(ROUTE_HEADERS.day), city: find(ROUTE_HEADERS.city), plan: find(ROUTE_HEADERS.plan), hotel: find(ROUTE_HEADERS.hotel), spots: find(ROUTE_HEADERS.spots) }
      : { day: 0, city: 1, plan: 2, hotel: 3, spots: 4 };
    const errors: string[] = []; const created: string[] = [];
    const rows: Array<RouteDay & { order: number }> = [];
    lines.slice(hasHeader ? 1 : 0).forEach((line, offset) => {
      const cells = line.split('\t').map(cell => cell.trim());
      const cell = (column: number) => (column >= 0 ? cells[column] ?? '' : '');
      const rowNo = offset + (hasHeader ? 2 : 1);
      const dayText = cell(columns.day);
      const dayMatch = /(\d+)/.exec(dayText);
      const day = dayMatch ? Number(dayMatch[1]) : rows.length + 1;
      const city = cell(columns.city);
      if (!city && !cell(columns.plan)) { errors.push(`第 ${rowNo} 行：城市和行程都是空的，跳过`); return; }
      if (!city) errors.push(`第 ${rowNo} 行：没填城市，查不到天气`);
      const hotelName = cell(columns.hotel);
      const hotelId = hotelName && !/^(无|不住|—|-)$/.test(hotelName) ? this.materialFor('hotel', hotelName, city, created) : undefined;
      const spotIds = splitNames(cell(columns.spots)).map(name => this.materialFor('spot', name, city, created));
      rows.push({ order: rows.length, day, city, plan: cell(columns.plan), hotelId, spotIds });
    });
    if (!rows.length) fail(errors.join('\n') || '没有可导入的行程');
    rows.sort((a, b) => a.day - b.day || a.order - b.order);
    const dayPlans = rows.map(({ order: _order, ...day }, index) => ({ ...day, day: index + 1 }));
    if (created.length) this.logs.write({ module: 'Content', action: '导入路线日程', status: 'info', message: `新建了 ${created.length} 条素材：${created.join('、')}，请到素材库补上介绍和攻略图` });
    return { dayPlans, created, errors };
  }

  private materialFor(kind: 'hotel' | 'spot', title: string, city: string, created: string[]): string {
    const candidates = this.materials.list({ text: title }).filter(material => material.title === title && (kind === 'hotel' ? material.kind === 'hotel' : material.kind === 'spot' || material.kind === 'guide'));
    const found = candidates.find(material => !city || material.city === city) ?? candidates[0];
    if (found) return found.id;
    const material = this.materials.insert({ kind, title, body: '', city, tags: [], source: 'excel' });
    created.push(`${MATERIAL_KIND_LABELS[kind]}“${title}”`);
    return material.id;
  }
}

// ───────── 内容中心：模板和天气对照表 ─────────
/**
 * 按模板填内容：{名称} 换成对应的值；[ ] 里的一段只要有一个值是空的就整段去掉（比如天气查不到时去掉“天气参考…”半句）；
 * 一行里的值全是空的，这一行也去掉（比如没填行程时去掉“明日行程：”这一行）。
 */
export function fillTemplate(template: string, values: Record<string, string | undefined>): string {
  const lookup = (name: string) => values[name];
  const lines = template.replace(/\r\n/g, '\n').split('\n').map(line => {
    const withOptional = line.replace(/\[([^\[\]]*)\]/g, (_whole, inner: string) => {
      const names = [...inner.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);
      return names.some(name => lookup(name) !== undefined && !String(lookup(name)).trim()) ? '' : inner;
    });
    const names = [...withOptional.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]).filter(name => lookup(name) !== undefined);
    if (names.length && names.every(name => !String(lookup(name) ?? '').trim())) return null;
    return withOptional.replace(/\{([^{}]+)\}/g, (whole, name: string) => (lookup(name) === undefined ? whole : String(lookup(name))));
  });
  return lines.filter((line): line is string => line !== null).join('\n').trim();
}

/** 天气对照表：明天的天气命中哪几行，就把这几行的出行必备、建议着装合起来，去掉重复。 */
export function adviceFor(rules: WeatherRule[], weather: DayWeather | null): { essentials: string; clothing: string; matched: WeatherRule[] } {
  const matched = rules.filter(rule => {
    if (rule.kind === 'always') return true;
    if (!weather) return false;
    if (rule.kind === 'weather') return Boolean(rule.value.trim()) && weather.condition.includes(rule.value.trim());
    const limit = Number(rule.value);
    if (!Number.isFinite(limit)) return false;
    return rule.kind === 'minBelow' ? weather.min < limit : weather.max > limit;
  });
  const merge = (pick: (rule: WeatherRule) => string) => cleanList(matched.flatMap(rule => pick(rule).split(/[、,，;；/]+/)).filter(item => item !== '—' && item !== '-')).join('、');
  return { essentials: merge(rule => rule.essentials), clothing: merge(rule => rule.clothing), matched };
}

export class TemplateService {
  constructor(private readonly templates: TemplateRepository, private readonly rules: WeatherRuleRepository, private readonly weather: WeatherGateway) {}

  list(): MessageTemplate[] { return this.templates.list(); }
  body(key: TemplateKey) { return this.templates.get(key); }

  save(key: TemplateKey, body: string): MessageTemplate {
    if (!TEMPLATE_KEYS.includes(key)) fail('模板不存在');
    const text = String(body ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) fail(`“${TEMPLATE_META[key].label}”模板不能为空`);
    const unknown = [...text.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]).filter(name => !TEMPLATE_META[key].placeholders.includes(name));
    if (unknown.length) fail(`模板里的 {${unknown[0]}} 软件填不了，可用的有：${TEMPLATE_META[key].placeholders.map(name => `{${name}}`).join(' ')}`);
    this.templates.save(key, text);
    return this.list().find(item => item.key === key)!;
  }

  reset(key: TemplateKey): MessageTemplate {
    if (!TEMPLATE_KEYS.includes(key)) fail('模板不存在');
    this.templates.reset(key);
    return this.list().find(item => item.key === key)!;
  }

  weatherRules(): WeatherRule[] { return this.rules.list(); }

  saveWeatherRules(input: Array<Omit<WeatherRule, 'id'> & { id?: string }>): WeatherRule[] {
    const rules = (Array.isArray(input) ? input : []).map((rule, index): WeatherRule => {
      const kind = (Object.keys(WEATHER_RULE_KIND_LABELS) as WeatherRuleKind[]).includes(rule.kind) ? rule.kind : fail(`第 ${index + 1} 行：条件类型不对`);
      const value = String(rule.value ?? '').trim();
      if (kind === 'weather' && !value) fail(`第 ${index + 1} 行：请填天气里包含的字，比如“雨”`);
      if ((kind === 'minBelow' || kind === 'maxAbove') && !Number.isFinite(Number(value))) fail(`第 ${index + 1} 行：气温要填数字`);
      const essentials = String(rule.essentials ?? '').trim(); const clothing = String(rule.clothing ?? '').trim();
      if (!essentials && !clothing) fail(`第 ${index + 1} 行：出行必备和建议着装至少填一个`);
      return { id: rule.id || randomUUID(), kind, value: kind === 'always' ? '' : value, essentials, clothing };
    });
    this.rules.replaceAll(rules);
    return this.rules.list();
  }

  /** 查天气失败返回 null 和原因，不抛错：天气查不到时消息照发，只是去掉天气那半句。 */
  async forecast(city: string, date: string): Promise<{ weather: DayWeather | null; error?: string }> {
    if (!city.trim()) return { weather: null, error: '没填城市' };
    try { return { weather: await this.weather.forecast(city.trim(), date) }; }
    catch (error: any) { return { weather: null, error: error?.message || String(error) }; }
  }

  async test(city: string, date: string) {
    if (!parseDateText(date)) fail('日期格式不对');
    const { weather, error } = await this.forecast(String(city ?? ''), date);
    const advice = adviceFor(this.rules.list(), weather);
    return { weather, essentials: advice.essentials, clothing: advice.clothing, error };
  }
}

// ───────── 发送方式（设置） ─────────
export type AgentInfo = { addresses: string[]; port: number; token: string; listening: boolean; error?: string };

export class SendSettingsService {
  constructor(
    private readonly store: SendSettingsStore,
    private readonly local: RpaExecutor,
    private readonly accounts: (account: RpaAccount) => RpaAccountClient,
    private readonly agentInfo: () => AgentInfo,
    private readonly logs: LogService,
    /** 保存后回调：主进程据此启停执行端的局域网服务。 */
    private readonly onChange: (settings: SendSettings) => void,
  ) {}

  get(): SendSettings { return this.store.get(); }

  save(input: SendSettings): SendSettings {
    const previous = this.store.get();
    const next: SendSettings = { rpa: normalizeRpa(input?.rpa), pool: normalizePool(input?.pool, previous.pool), tour: normalizeTourSchedule(input?.tour) };
    this.store.save(next);
    if (previous.pool.role !== next.pool.role) this.logs.write({ module: 'System', action: '切换本机角色', status: 'info', message: next.pool.role === 'agent' ? `本机改为执行端，监听端口 ${next.pool.agentPort}` : '本机改为主控' });
    this.onChange(next);
    return next;
  }

  async checkRpa(override?: RpaSettings): Promise<string> {
    const status = await this.local.check(undefined, override ? normalizeRpa(override) : undefined);
    this.logs.write({ module: 'RPA', action: '检测客户端', status: status.ok ? 'ok' : 'fail', message: status.detail });
    if (!status.ok) throw new OpsError(status.detail);
    return status.detail;
  }

  async checkAccount(input: RpaAccount): Promise<AccountStatus> {
    const account = normalizeAccount(input);
    if (account.kind === 'remote' && (!account.host || !account.token)) fail('请填写执行端的 IP 地址和配对口令');
    const status = await this.accounts(account).check().catch((error: any): AccountStatus => ({ ok: false, detail: error?.message || String(error) }));
    this.logs.write({ module: 'RPA', action: '测试账号', status: status.ok ? 'ok' : 'fail', message: `${account.name}：${status.detail}` });
    return status;
  }

  agent(): AgentInfo { return this.agentInfo(); }
}

// ───────── 提醒邮件 ─────────
export class MailAlertService {
  constructor(private readonly store: MailSettingsStore, private readonly mailer: MailSender, private readonly logs: LogService, private readonly machine: () => string) {}

  get(): MailSettingsView { return this.store.get(); }

  save(input: MailSettingsInput): MailSettingsView {
    const settings = normalizeMail(input);
    if (settings.enabled && (!settings.host || !settings.user || !settings.to)) fail('请填写 SMTP 服务器、发件邮箱和收件人');
    if (settings.enabled && !input.password?.trim() && !this.store.get().hasPassword) fail('请填写邮箱授权码');
    this.store.save(settings, input.password?.trim() || undefined);
    return this.store.get();
  }

  async test(input: MailSettingsInput): Promise<string> {
    const settings = normalizeMail(input);
    const server = this.serverFor(settings, input.password?.trim());
    await this.mailer.send(server, { to: recipients(settings.to), subject: '【旅游运营助手】测试邮件', text: `这是一封测试邮件，说明提醒邮件配置正确。\n\n发送电脑：${this.machine()}\n时间：${new Date().toLocaleString('zh-CN', { hour12: false })}` });
    return `测试邮件已发到 ${recipients(settings.to).join('、')}，请到邮箱查收（也看看垃圾箱）`;
  }

  /** 发提醒邮件；失败只记日志，不影响发送流程。 */
  async alert(subject: string, text: string) {
    const settings = this.store.get();
    if (!settings.enabled) return;
    try {
      const server = this.serverFor(settings);
      await this.mailer.send(server, { to: recipients(settings.to), subject: `【旅游运营助手】${subject}`, text: `${text}\n\n发送电脑：${this.machine()}\n时间：${new Date().toLocaleString('zh-CN', { hour12: false })}` });
      this.logs.write({ module: 'System', action: '提醒邮件', status: 'ok', message: `已发到 ${settings.to}：${subject}` });
    } catch (error: any) {
      this.logs.write({ module: 'System', action: '提醒邮件', status: 'fail', message: error?.message || String(error) });
    }
  }

  private serverFor(settings: MailSettings, password?: string) {
    if (!settings.host || !settings.user) fail('请填写 SMTP 服务器和发件邮箱');
    if (!recipients(settings.to).length) fail('请填写收件人邮箱');
    const stored = this.store.server(password);
    if (!stored) fail('请填写邮箱授权码');
    return { ...stored!, host: settings.host, port: settings.port, secure: settings.secure, user: settings.user };
  }
}

function recipients(to: string) { return cleanList(String(to ?? '').split(/[,，;；\s]+/)).filter(item => /^[^@\s]+@[^@\s]+$/.test(item)); }

function normalizeMail(input: Partial<MailSettings>): MailSettings {
  const port = Number(input?.port);
  return {
    enabled: Boolean(input?.enabled),
    host: String(input?.host ?? '').trim(),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 465,
    secure: input?.secure ?? true,
    user: String(input?.user ?? '').trim(),
    to: recipients(String(input?.to ?? '')).join(', '),
  };
}

function normalizeAccount(input: Partial<RpaAccount>): RpaAccount {
  const port = Number(input?.port);
  const isLocal = input?.id === LOCAL_ACCOUNT_ID;
  return {
    id: isLocal ? LOCAL_ACCOUNT_ID : String(input?.id || randomUUID()),
    name: String(input?.name ?? '').trim() || (isLocal ? '本机' : '未命名账号'),
    kind: isLocal ? 'local' : 'remote',
    host: isLocal ? '' : String(input?.host ?? '').trim(),
    port: isLocal ? 0 : Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_AGENT_PORT,
    token: isLocal ? '' : String(input?.token ?? '').trim(),
    enabled: input?.enabled ?? true,
  };
}

function normalizePool(input: Partial<PoolSettings> | undefined, previous: PoolSettings): PoolSettings {
  const accounts = (Array.isArray(input?.accounts) ? input!.accounts : previous.accounts).map(normalizeAccount);
  // 本机账号始终存在（可以停用），排在第一个
  const local = accounts.find(account => account.id === LOCAL_ACCOUNT_ID) ?? normalizeAccount({ id: LOCAL_ACCOUNT_ID });
  const port = Number(input?.agentPort);
  return {
    role: input?.role === 'agent' ? 'agent' : 'master',
    accounts: [local, ...accounts.filter(account => account.id !== LOCAL_ACCOUNT_ID)],
    agentPort: Number.isInteger(port) && port > 1024 && port < 65536 ? port : previous.agentPort || DEFAULT_AGENT_PORT,
    agentToken: String(input?.agentToken ?? '').trim() || previous.agentToken || randomUUID().replace(/-/g, '').slice(0, 16),
  };
}

function normalizeRpa(input?: Partial<RpaSettings>): RpaSettings {
  const base = DEFAULT_SEND_SETTINGS.rpa;
  const delay = Number(input?.stepDelayMs);
  return {
    client: input?.client === 'wechat' ? 'wechat' : 'wecom',
    autoSend: input?.autoSend ?? base.autoSend,
    sendKey: input?.sendKey === 'ctrlEnter' ? 'ctrlEnter' : 'enter',
    searchHotkey: String(input?.searchHotkey ?? '').trim() || base.searchHotkey,
    stepDelayMs: Number.isFinite(delay) ? Math.min(5000, Math.max(200, Math.round(delay))) : base.stepDelayMs,
    clientPath: String(input?.clientPath ?? '').trim(),
    verifyChat: input?.verifyChat ?? base.verifyChat,
    minimizeAfterSend: input?.minimizeAfterSend ?? base.minimizeAfterSend,
    guard: normalizeGuard(input?.guard),
  };
}

function normalizeGuard(input?: Partial<RpaGuard>): RpaGuard {
  return builtInGuard(input);
}

export function normalizeTourSchedule(input?: Partial<TourScheduleSettings>): TourScheduleSettings {
  const start = String(input?.eveningStart ?? '').trim();
  return { eveningStart: HHMM.test(start) ? start.padStart(5, '0') : DEFAULT_TOUR_SCHEDULE.eveningStart, launchAtLogin: input?.launchAtLogin ?? DEFAULT_TOUR_SCHEDULE.launchAtLogin };
}

// ───────── 群管理（一个群对应一个团） ─────────
export class GroupService {
  constructor(
    private readonly repo: GroupRepository,
    private readonly routes: RouteRepository,
    private readonly materials: MaterialRepository,
    private readonly batches: BatchRepository,
    private readonly logs: LogService,
    private readonly sendSettings: () => SendSettings,
  ) {}

  list(): OpsGroup[] { const today = localDateText(new Date()); return this.repo.list().map(group => this.view(group, today)); }
  get(id: string): OpsGroup { return this.view(this.repo.get(id) ?? fail('群不存在或已被删除'), localDateText(new Date())); }
  find(id: string): OpsGroup | null { const group = this.repo.get(id); return group ? this.view(group, localDateText(new Date())) : null; }
  markSent(id: string) { this.repo.markSent(id, nowIso()); }

  /** 新增群：群名要和客户端里显示的一致，发送时在客户端里搜索这个群名；新增时一起填团的出发日期和路线。 */
  add(input: GroupAddInput): OpsGroup {
    const name = String(input?.name ?? '').trim();
    if (!name) fail('请填写群名称');
    if (this.repo.list().some(group => group.name === name)) fail(`已经有叫“${name}”的群了。一个群只对应一个团，下一批客人请建新群`);
    const accountId = this.checkAccount(input.accountId);
    const tour = input.tour ? this.normalizeTour(input.tour) : undefined;
    const id = randomUUID();
    this.repo.upsert({ id, chatId: `${MANUAL_CHAT_PREFIX}${id}`, name, channel: 'customer', owner: '', memberCount: 0, enabled: true, matchMode: 'name', available: true, accountId, tour });
    const view = this.get(id);
    this.logs.write({ module: 'Group', action: '新增群', status: 'ok', groupName: name, message: tour ? `${view.routeName}，${shortDate(tour.startDate)}出发，${view.tourDays} 天` : '没有绑定团' });
    return view;
  }

  update(input: GroupUpdateInput): OpsGroup {
    const group = this.repo.get(input.id) ?? fail('群不存在或已被删除');
    const name = input.name === undefined ? group.name : String(input.name).trim();
    if (!name) fail('群名称不能为空');
    if (name !== group.name && this.repo.list().some(item => item.name === name)) fail(`已经有叫“${name}”的群了`);
    const accountId = input.accountId === undefined ? group.accountId : this.checkAccount(input.accountId);
    let tour = group.tour;
    if (input.tour === null) tour = undefined;
    else if (input.tour) tour = this.normalizeTour(input.tour, group.tour);
    if (input.state) {
      if (!tour) fail('这个群还没绑定团');
      if (!['normal', 'paused', 'cancelled'].includes(input.state)) fail('团的状态不对');
      tour = { ...tour!, state: input.state };
    }
    const rescheduled = (group.tour?.routeId ?? '') !== (tour?.routeId ?? '') || (group.tour?.startDate ?? '') !== (tour?.startDate ?? '');
    this.repo.upsert({ ...group, name, enabled: input.enabled ?? group.enabled, accountId, tour });
    // 出发日期或路线变了：还没发的计划按新日期重排，已经发出去的保留、不重发
    if (rescheduled) this.clearUnsent(group.id);
    const view = this.get(group.id);
    if (rescheduled) this.logs.write({ module: 'Tour', action: tour ? '修改团' : '解绑团', status: 'info', groupName: name, message: tour ? `${view.routeName}，${shortDate(tour.startDate)}出发，发送计划已重排` : '已解绑，不再自动发送' });
    if (input.state && input.state !== group.tour?.state) this.logs.write({ module: 'Tour', action: '团状态', status: 'info', groupName: name, message: input.state === 'normal' ? '已恢复，按日期继续发' : input.state === 'paused' ? '已暂停，暂停期间不发' : '团已取消，不再发送' });
    return view;
  }

  delete(id: string) {
    const group = this.repo.get(id) ?? fail('群不存在或已被删除');
    this.batches.deleteByGroup(id);
    this.repo.delete(id);
    this.logs.write({ module: 'Group', action: '删除群', status: 'ok', message: group.name });
  }

  private clearUnsent(groupId: string) {
    const today = localDateText(new Date());
    for (const batch of this.batches.between(today, '9999-12-31', groupId)) {
      if (batch.kind === 'evening' && (batch.status === 'planned' || batch.status === 'skipped') && !batch.messages.some(message => message.status === 'sent')) this.batches.delete(batch.id);
    }
  }

  private checkAccount(accountId?: string) {
    if (!accountId) return undefined;
    if (!this.sendSettings().pool.accounts.some(account => account.id === accountId)) fail('账号不存在，请先在“设置 → 账号池”里添加');
    return accountId;
  }

  private normalizeTour(input: TourInput, current?: Tour): Tour {
    const route = this.routes.get(String(input?.routeId ?? '')) ?? fail('请选择路线');
    const startDate = String(input?.startDate ?? '').trim();
    if (!parseDateText(startDate)) fail('请选择出发日期');
    const overrides: Record<string, string> = {};
    // 没传酒店调整时沿用原来的（换了路线就清空）
    const source = input.hotelOverrides ?? (current?.routeId === route.id ? current.hotelOverrides : {});
    const hotels = new Set(this.materials.getMany(Object.values(source).filter(Boolean)).filter(material => material.kind === 'hotel').map(material => material.id));
    for (const [day, hotelId] of Object.entries(source)) {
      const number = Number(day);
      if (!Number.isInteger(number) || number < 1 || number > route.days) continue;
      if (hotelId === '' || hotels.has(hotelId)) overrides[String(number)] = hotelId;
    }
    return { routeId: route.id, startDate: localDateText(parseDateText(startDate)!), state: current?.state ?? 'normal', hotelOverrides: overrides, note: String(input.note ?? current?.note ?? '').trim() };
  }

  private view(group: StoredGroup, today: string): OpsGroup {
    const route = group.tour ? this.routes.get(group.tour.routeId) : null;
    const status = group.tour && route ? tourPhase(group.tour.startDate, route.days, today) : { phase: 'none' as const };
    return {
      ...group, todaySent: this.logs.sentToday(group.name),
      routeName: route?.name ?? (group.tour ? '（路线已删除）' : undefined),
      tourDays: route?.days, endDate: group.tour && route ? addDays(group.tour.startDate, route.days - 1) : undefined,
      phase: status.phase, dayNo: status.dayNo,
    };
  }
}

// ───────── 分发适配（怎么发：按群绑定的账号，交给本机或局域网执行端的客户端发） ─────────
/** blocked：被防封规则拦下（时段、次数、安全验证），过一会儿再试，不算失败。 */
export type SendResult = { ok: boolean; detail: string; blocked?: boolean };

export class DistributionService {
  constructor(
    /** 账号池里每个账号的发送入口：本机账号是 RpaExecutor，远程账号是执行端的局域网客户端。 */
    private readonly accounts: (account: RpaAccount) => RpaAccountClient,
    private readonly sendSettings: () => SendSettings,
    private readonly logs: LogService,
    private readonly onSent: (groupId: string) => void,
  ) {}

  /** 群由哪个账号发；找不到时给出原因。 */
  accountFor(group: Pick<OpsGroup, 'accountId'>): { account: RpaAccount } | { error: string } {
    const pool = this.sendSettings().pool;
    const account = resolveAccount(pool, group.accountId);
    if (account) return { account };
    return { error: group.accountId && pool.accounts.some(item => item.id === group.accountId) ? '绑定的发送账号已停用，请在群管理换一个账号' : '账号池里没有可用的发送账号（设置 → 账号池）' };
  }

  /** 当前不在发送时段时，返回下一个时段开始的时间（时段以主控的设置为准）。 */
  rpaDeferUntil(now: Date): Date | null {
    return nextActiveStart(this.sendSettings().rpa.guard, now);
  }

  /** 按群绑定的账号发。本机账号的日志由执行器写；远程账号这里再记一条，主控也能看到结果。 */
  async send(group: Pick<OpsGroup, 'id' | 'name' | 'enabled' | 'accountId'>, text: string, context: { taskId?: string; batchId?: string; attempt?: number; action?: string; images?: string[]; paced?: boolean }): Promise<SendResult> {
    const action = context.action ?? '发送文本';
    const base = { module: 'RPA' as const, taskId: context.taskId, batchId: context.batchId, groupName: group.name, attempt: context.attempt, action };
    if (!group.enabled) { this.logs.write({ ...base, status: 'fail', message: '群已停用，跳过' }); return { ok: false, detail: `${group.name}：群已停用` }; }
    const picked = this.accountFor(group);
    if ('error' in picked) { this.logs.write({ ...base, status: 'fail', message: picked.error }); return { ok: false, detail: `${group.name}：${picked.error}` }; }
    const { account } = picked;
    const remote = account.kind === 'remote';
    try {
      const result = await this.accounts(account).send(group.name, text, context.images ?? [], { taskId: context.taskId, batchId: context.batchId, attempt: context.attempt, action, paced: context.paced ?? true });
      if (remote) this.logs.write({ ...base, account: account.id, status: 'ok', message: `账号“${account.name}”：${result.detail}` });
      if (group.id) this.onSent(group.id);
      return { ok: true, detail: `${remote ? `账号“${account.name}”` : ''}${result.detail}` };
    } catch (error: any) {
      const message = error?.message || String(error);
      if (remote) this.logs.write({ ...base, account: account.id, status: 'fail', message: `账号“${account.name}”：${message}` });
      return { ok: false, detail: `${remote ? `账号“${account.name}”：` : ''}${message}`, blocked: error instanceof GuardBlocked };
    }
  }
}

// ───────── 发送计划（每个团每晚一组，按日期自动排出） ─────────
/** 一组里的一条：先算出要发哪几条（不查天气），真正发之前再查天气、套模板。 */
type PlanItem =
  | { type: 'overview' }
  | { type: 'hotelList' }
  | { type: 'reminder'; day: number }
  | { type: 'hotel'; day: number; hotel: Material }
  | { type: 'spot'; day: number; spot: Material };
type DayPlan = { dayNo?: number; items: PlanItem[]; notes: string[]; route?: Route };

/** 一组里条与条失败后最多自动重发几轮。 */
const MAX_BATCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;
/** 被防封规则拦下（时段、次数、安全验证）时，过多久再试。 */
const BLOCKED_DELAY_MS = 30 * 60 * 1000;

export class PlanService {
  private running = false;

  constructor(
    private readonly batches: BatchRepository,
    private readonly groups: GroupService,
    private readonly routes: RouteService,
    private readonly materials: MaterialService,
    private readonly templates: TemplateService,
    private readonly distribution: DistributionService,
    private readonly settings: () => SendSettings,
    private readonly logs: LogService,
  ) {}

  /** 发送计划：存下来的（已发、跳过、失败、临时消息）+ 按团实时算出的（还没开始发的）。 */
  list(query: PlanQuery): SendBatch[] {
    const today = localDateText(new Date());
    const from = parseDateText(query.from ?? '') ? query.from! : addDays(today, -3);
    const to = parseDateText(query.to ?? '') ? query.to! : addDays(today, 14);
    const groups = this.groups.list().filter(group => !query.groupId || group.id === query.groupId);
    const byId = new Map(groups.map(group => [group.id, group]));
    const stored = this.batches.between(from, to, query.groupId);
    const result: SendBatch[] = stored.map(batch => this.view(batch, byId.get(batch.groupId)));
    const storedKeys = new Set(stored.filter(batch => batch.kind === 'evening').map(batch => `${batch.groupId}|${batch.date}`));
    const eveningStart = this.settings().tour.eveningStart;
    for (const group of groups) {
      if (!group.tour || group.tour.state === 'cancelled') continue;
      for (const date of this.eveningDates(group)) {
        if (date < from || date > to || date < today || storedKeys.has(`${group.id}|${date}`)) continue;
        const plan = this.dayPlan(group, date);
        if (!plan.items.length) continue;
        const held = group.tour.state === 'paused' ? '团已暂停，恢复后才发' : !group.enabled ? '群已停用' : undefined;
        result.push({ groupId: group.id, groupName: group.name, kind: 'evening', date, dayNo: plan.dayNo, status: held ? 'skipped' : 'planned', notBefore: atTime(date, eveningStart).toISOString(), attempts: 0, lastResult: held, labels: plan.items.map(item => this.label(item)) });
      }
    }
    return result.sort((a, b) => a.date.localeCompare(b.date) || (a.notBefore ?? '').localeCompare(b.notBefore ?? '') || a.groupName.localeCompare(b.groupName, 'zh-CN'));
  }

  /** 预览某个群某天傍晚会收到什么：已经开始发的按存下来的内容，没开始的实时查天气、套模板。 */
  async preview(groupId: string, date: string): Promise<BatchPreview> {
    const group = this.groups.get(groupId);
    if (!parseDateText(date)) fail('日期格式不对');
    const stored = this.batches.evening(group.id, date);
    if (stored?.messages.length) return { groupName: group.name, date, dayNo: stored.dayNo, messages: stored.messages.map(strip), weather: null, notes: ['这一组已经生成，下面是实际发送的内容'] };
    const plan = this.dayPlan(group, date);
    const rendered = await this.render(group, date, plan);
    if (stored?.status === 'skipped') rendered.notes.unshift('这一组已跳过，不会发送');
    return { groupName: group.name, date, dayNo: plan.dayNo, messages: rendered.messages, weather: rendered.weather, notes: [...plan.notes, ...rendered.notes] };
  }

  skip(groupId: string, date: string): SendBatch {
    const group = this.groups.get(groupId);
    const stored = this.batches.evening(group.id, date);
    if (stored) {
      if (stored.status === 'sending') fail('这一组正在发送，不能跳过');
      if (stored.messages.some(message => message.status === 'sent')) fail('这一组已经发出去了，不能跳过');
      this.batches.update(stored.id, { status: 'skipped', lastResult: '手动跳过' });
    } else {
      const plan = this.dayPlan(group, date);
      if (!plan.items.length) fail('这一天没有要发的内容');
      this.batches.create({ groupId: group.id, kind: 'evening', date, dayNo: plan.dayNo, status: 'skipped', attempts: 0, lastResult: '手动跳过', messages: [] });
    }
    this.logs.write({ module: 'Plan', action: '跳过', status: 'info', groupName: group.name, message: `跳过 ${shortDate(date)} 傍晚的一组` });
    return this.view(this.batches.evening(group.id, date)!, group);
  }

  unskip(groupId: string, date: string): SendBatch {
    const group = this.groups.get(groupId);
    const stored = this.batches.evening(group.id, date);
    if (!stored || stored.status !== 'skipped') fail('这一组没有被跳过');
    if (date < localDateText(new Date())) fail('日期已经过了');
    this.batches.delete(stored!.id);
    this.logs.write({ module: 'Plan', action: '恢复', status: 'info', groupName: group.name, message: `恢复 ${shortDate(date)} 傍晚的一组` });
    return this.list({ from: date, to: date, groupId: group.id }).find(batch => batch.kind === 'evening') ?? fail('这一天没有要发的内容');
  }

  /** 不等傍晚开始时间，现在就发今天这一组。 */
  async sendNow(groupId: string, date: string): Promise<SendBatch> {
    const group = this.groups.get(groupId);
    if (date !== localDateText(new Date())) fail('只能立即发送今天的一组');
    const blocked = this.cannotSend(group);
    if (blocked) fail(blocked);
    const stored = this.batches.evening(group.id, date);
    if (stored?.status === 'sent') fail('今天这一组已经发过了');
    if (stored?.status === 'skipped') fail('今天这一组已跳过，先恢复再发');
    if (stored?.status === 'sending') fail('正在发送');
    const batch = stored ?? await this.createEvening(group, date);
    if (!batch) fail('今天没有要发的内容');
    return this.view(await this.execute(batch!.id, group), group);
  }

  /** 重发一组里还没发出去的消息（已发出的不再发）。 */
  async retry(id: string): Promise<SendBatch> {
    const batch = this.batches.get(id) ?? fail('这一组不存在');
    if (batch!.date !== localDateText(new Date())) fail('只能重发今天的，过了当天的消息不再补发');
    if (!['failed', 'partial', 'planned'].includes(batch!.status)) fail('这一组不需要重发');
    const group = this.groups.get(batch!.groupId);
    if (!group.enabled) fail('群已停用');
    this.batches.update(batch!.id, { status: 'planned', attempts: 0, notBefore: null });
    this.logs.write({ module: 'Plan', action: '手动重发', status: 'info', taskId: batch!.id, groupName: group.name, message: `重发没发出去的 ${batch!.messages.filter(message => message.status !== 'sent').length} 条` });
    return this.view(await this.execute(batch!.id, group), group);
  }

  /** 把某个群某天的一组发到文件传输助手试看：内容和正式发的一样，但不发到群里、不记进发送计划。 */
  async sendToSelf(groupId: string, date: string): Promise<SendBatch> {
    const group = this.groups.get(groupId);
    const plan = this.dayPlan(group, date);
    if (!plan.items.length) fail(plan.notes[0] ?? '这一天没有要发的内容');
    const { messages } = await this.render(group, date, plan);
    const self = { id: '', name: SELF_CHAT_NAME, enabled: true, accountId: group.accountId };
    const batchId = randomUUID();
    for (const message of messages) {
      const result = await this.distribution.send(self, message.text, { taskId: batchId, batchId, images: message.images, paced: true, action: `试看：${message.label}` });
      message.status = result.ok ? 'sent' : 'failed';
      if (!result.ok) { message.error = result.detail; break; }
      message.sentAt = nowIso();
    }
    const sent = messages.filter(message => message.status === 'sent').length;
    this.logs.write({ module: 'Plan', action: '发到文件传输助手试看', status: sent === messages.length ? 'ok' : 'fail', groupName: SELF_CHAT_NAME, message: `“${group.name}”${shortDate(date)}傍晚的一组：发出 ${sent}/${messages.length} 条` });
    return { groupId: group.id, groupName: `${SELF_CHAT_NAME}（试看“${group.name}”）`, kind: 'oneoff', date, dayNo: plan.dayNo, status: sent === messages.length ? 'sent' : sent ? 'partial' : 'failed', attempts: 1, lastResult: messages.find(message => message.error)?.error, labels: messages.map(message => message.label), messages: messages.map(strip) };
  }

  /** 临时发一条消息（比如拼团通知），也走防封规则，算一次发送。 */
  async sendMessage(groupId: string, text: string): Promise<SendBatch> {
    const group = this.groups.get(groupId);
    const body = String(text ?? '').trim();
    if (!body) fail('消息内容不能为空');
    if (!group.enabled) fail('群已停用');
    const batch = this.batches.create({ groupId: group.id, kind: 'oneoff', date: localDateText(new Date()), status: 'planned', attempts: 0, messages: [{ label: '临时消息', text: body, images: [], imageCount: 0, status: 'pending' }] });
    return this.view(await this.execute(batch.id, group), group);
  }

  recoverAfterRestart() { this.batches.resetSending(); }

  /** 调度器每 30 秒调用：过了傍晚开始时间，给每个进行中的团发今天这一组。 */
  async runDue(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      const today = localDateText(now);
      for (const stale of this.batches.stale(today)) {
        const sent = stale.messages.filter(message => message.status === 'sent').length;
        const message = sent ? `当天只发出 ${sent}/${stale.messages.length} 条，剩下的不再补发` : '当天没发出去（电脑没开、程序没运行或被防封规则拦下），不再补发';
        this.batches.update(stale.id, { status: sent ? 'partial' : 'missed', lastResult: message });
        this.logs.write({ module: 'Plan', action: '错过发送', status: 'fail', taskId: stale.id, groupName: this.groups.find(stale.groupId)?.name, message: `${shortDate(stale.date)}：${message}` });
      }
      // 不在发送时段就等下一个时段，不逐个去试
      if (this.distribution.rpaDeferUntil(now)) return;
      const start = atTime(today, this.settings().tour.eveningStart);
      const due = (batch: StoredBatch) => batch.status === 'planned' && (!batch.notBefore || new Date(batch.notBefore) <= now);
      const jobs: Array<{ group: OpsGroup; batch?: StoredBatch }> = [];
      for (const group of this.groups.list()) {
        if (this.cannotSend(group)) continue;
        const stored = this.batches.evening(group.id, today);
        if (stored) { if (due(stored)) jobs.push({ group, batch: stored }); continue; }
        if (now >= start && this.eveningDates(group).includes(today)) jobs.push({ group });
      }
      for (const batch of this.batches.between(today, today)) {
        if (batch.kind !== 'oneoff' || !due(batch)) continue;
        const group = this.groups.find(batch.groupId);
        if (group?.enabled) jobs.push({ group, batch });
      }
      // 不同账号（不同电脑）同时发，同一个账号按顺序一个群一个群发
      const byAccount = new Map<string, typeof jobs>();
      for (const job of jobs) {
        const picked = this.distribution.accountFor(job.group);
        const key = 'account' in picked ? picked.account.id : '';
        byAccount.set(key, [...(byAccount.get(key) ?? []), job]);
      }
      await Promise.all([...byAccount.values()].map(async list => {
        for (const job of list) {
          try {
            const batch = job.batch ? this.batches.get(job.batch.id) : this.batches.evening(job.group.id, today) ?? await this.createEvening(job.group, today);
            if (batch && due(batch)) await this.execute(batch.id, job.group);
          } catch (error: any) {
            this.logs.write({ module: 'Plan', action: '发送', status: 'fail', groupName: job.group.name, message: error?.message || String(error) });
          }
        }
      }));
    } finally { this.running = false; }
  }

  // ── 内部 ──

  /** 不能自动发的原因；可以发时返回 null。 */
  private cannotSend(group: OpsGroup): string | null {
    if (!group.enabled) return '群已停用';
    if (!group.tour) return '这个群没绑定团';
    if (group.tour.state === 'paused') return '团已暂停';
    if (group.tour.state === 'cancelled') return '团已取消';
    if (!this.routes.find(group.tour.routeId)) return '团的路线已被删除';
    return null;
  }

  /** 团要发的傍晚：出发前一天到最后一天的前一天（最后一天不再发明日提醒）。 */
  private eveningDates(group: OpsGroup): string[] {
    if (!group.tour || !group.tourDays) return [];
    return Array.from({ length: group.tourDays }, (_, index) => addDays(group.tour!.startDate, index - 1));
  }

  /** 某天傍晚这一组要发哪几条：出发前一天加发行程总览、酒店明细；之后每晚是明日提醒、今晚的酒店TIPS、明天的景点攻略。 */
  private dayPlan(group: OpsGroup, date: string): DayPlan {
    if (!group.tour) return { items: [], notes: ['这个群没绑定团，不会自动发'] };
    const route = this.routes.find(group.tour.routeId);
    if (!route) return { items: [], notes: ['团的路线已被删除'] };
    const dayNo = daysBetween(group.tour.startDate, date) + 2;
    if (dayNo < 1) return { items: [], notes: [`还没到出发前一天，${shortDate(addDays(group.tour.startDate, -1))}傍晚开始发`], route };
    if (dayNo > route.days) return { items: [], notes: [dayNo === route.days + 1 ? '今天是行程最后一天，不再发明日提醒' : '行程已经结束，不再发送'], route };
    const notes: string[] = [];
    const items: PlanItem[] = [];
    if (dayNo === 1) {
      items.push({ type: 'overview' });
      if (route.dayPlans.some((_, index) => this.hotelOf(group, route, index + 1))) items.push({ type: 'hotelList' });
    }
    items.push({ type: 'reminder', day: dayNo });
    if (dayNo >= 2) {
      const hotel = this.hotelOf(group, route, dayNo - 1);
      if (hotel) items.push({ type: 'hotel', day: dayNo - 1, hotel });
    }
    const spots = this.materials.getMany(this.planOf(route, dayNo).spotIds);
    for (const id of this.planOf(route, dayNo).spotIds) {
      const spot = spots.find(material => material.id === id);
      if (spot) items.push({ type: 'spot', day: dayNo, spot });
    }
    if (!this.planOf(route, dayNo).plan) notes.push(`路线第 ${dayNo} 天没填行程，明日提醒里不写“明日行程”`);
    return { dayNo, items, notes, route };
  }

  private planOf(route: Route, day: number): RouteDay {
    return route.dayPlans.find(plan => plan.day === day) ?? { day, city: route.city, plan: '', spotIds: [] };
  }

  /** 第几晚住哪个酒店：团里按天换过的优先，其次是路线默认的。 */
  private hotelOf(group: OpsGroup, route: Route, day: number): Material | null {
    const override = group.tour?.hotelOverrides[String(day)];
    const id = override !== undefined ? override : this.planOf(route, day).hotelId;
    if (!id) return null;
    return this.materials.getMany([id])[0] ?? null;
  }

  private label(item: PlanItem): string {
    switch (item.type) {
      case 'overview': return TEMPLATE_META.overview.label;
      case 'hotelList': return TEMPLATE_META.hotelList.label;
      case 'reminder': return TEMPLATE_META.reminder.label;
      case 'hotel': return `${TEMPLATE_META.hotel.label}（${item.hotel.title}）`;
      case 'spot': return `${item.spot.title}游玩攻略`;
    }
  }

  /** 查明天的天气、套模板，得到这一组每条消息的文字和图片。 */
  private async render(group: OpsGroup, date: string, plan: DayPlan): Promise<{ messages: PlanMessage[]; weather: DayWeather | null; notes: string[] }> {
    const notes: string[] = [];
    const route = plan.route;
    if (!route || !plan.dayNo || !plan.items.length || !group.tour) return { messages: [], weather: null, notes };
    const start = group.tour.startDate;
    const tomorrow = addDays(date, 1);
    const today = this.planOf(route, plan.dayNo);
    const { weather, error } = await this.templates.forecast(today.city, tomorrow);
    if (!weather) notes.push(`明天${today.city || ''}的天气没查到（${error}），明日提醒里先不写天气`);
    const advice = adviceFor(this.templates.weatherRules(), weather);
    const images = (material: Material) => material.images.map(image => this.materials.imageFile(image.id)).filter((path): path is string => Boolean(path));
    const messages: PlanMessage[] = [];
    const push = (label: string, text: string, files: string[] = []) => { if (text.trim()) messages.push({ label, text, images: files, imageCount: files.length, status: 'pending' }); };
    for (const item of plan.items) {
      if (item.type === 'overview') {
        const lines = route.dayPlans.map(day => `第${day.day}天（${shortDate(addDays(start, day.day - 1))}）${day.city}${day.plan ? `：${day.plan}` : ''}`);
        push(this.label(item), fillTemplate(this.templates.body('overview'), { 路线: route.name, 天数: String(route.days), 出发日期: shortDate(start), 结束日期: shortDate(addDays(start, route.days - 1)), 每日行程: lines.join('\n') }));
      } else if (item.type === 'hotelList') {
        const lines = route.dayPlans.map(day => ({ day, hotel: this.hotelOf(group, route, day.day) })).filter(row => row.hotel).map(({ day, hotel }) => `第${day.day}晚（${shortDate(addDays(start, day.day - 1))}）${hotel!.city || day.city}：${hotel!.title}`);
        push(this.label(item), fillTemplate(this.templates.body('hotelList'), { 路线: route.name, 酒店列表: lines.join('\n') }));
      } else if (item.type === 'reminder') {
        push(this.label(item), fillTemplate(this.templates.body('reminder'), {
          城市: today.city, 最低: weather ? String(Math.round(weather.min)) : '', 最高: weather ? String(Math.round(weather.max)) : '', 天气: weather?.condition ?? '',
          出行必备: advice.essentials, 明日行程: today.plan, 建议着装: advice.clothing, 日期: shortDate(tomorrow), 第几天: String(plan.dayNo),
        }));
      } else if (item.type === 'hotel') {
        if (!item.hotel.body.trim()) notes.push(`酒店“${item.hotel.title}”还没写介绍`);
        push(this.label(item), fillTemplate(this.templates.body('hotel'), { 酒店: item.hotel.title, 酒店介绍: item.hotel.body, 城市: this.planOf(route, item.day).city }), images(item.hotel));
      } else {
        const files = images(item.spot);
        if (!files.length) notes.push(`景点“${item.spot.title}”还没有攻略图，只发文字`);
        push(this.label(item), fillTemplate(this.templates.body('spot'), { 景点: item.spot.title, 攻略: item.spot.body, 城市: today.city }), files);
      }
    }
    const maxImages = this.settings().rpa.guard.maxImages;
    if (messages.some(message => message.imageCount > maxImages)) notes.push(`每条最多附 ${maxImages} 张图，多的不发`);
    return { messages, weather, notes };
  }

  /** 生成今天这一组并存下来（状态是待发送）；别处已经生成了就用那一组。 */
  private async createEvening(group: OpsGroup, date: string): Promise<StoredBatch | null> {
    const plan = this.dayPlan(group, date);
    if (!plan.items.length) return null;
    const { messages, notes } = await this.render(group, date, plan);
    const existing = this.batches.evening(group.id, date);
    if (existing) return existing;
    if (!messages.length) return null;
    return this.batches.create({ groupId: group.id, kind: 'evening', date, dayNo: plan.dayNo, status: 'planned', attempts: 0, lastResult: notes.length ? notes.join('；') : undefined, messages });
  }

  /** 按顺序发这一组里还没发出去的消息；一条失败就停下，过一会儿只重发没发出去的。 */
  private async execute(batchId: string, group: OpsGroup): Promise<StoredBatch> {
    const batch = this.batches.get(batchId) ?? fail('这一组不存在');
    if (batch!.status === 'sending') fail('这一组正在发送');
    const attempt = batch!.attempts + 1;
    this.batches.update(batchId, { status: 'sending', attempts: attempt });
    const label = batch!.kind === 'oneoff' ? '临时消息' : `${shortDate(batch!.date)}傍晚的一组`;
    let failure: SendResult | null = null;
    try {
      for (const message of batch!.messages) {
        if (message.status === 'sent') continue;
        const result = await this.distribution.send(group, message.text, { taskId: batchId, batchId, attempt, images: message.images, paced: true, action: message.label });
        if (result.ok) this.batches.markMessage(message.id, 'sent');
        else { this.batches.markMessage(message.id, 'failed', result.detail); failure = result; break; }
      }
    } catch (error: any) {
      failure = { ok: false, detail: error?.message || String(error) };
    }
    const after = this.batches.get(batchId)!;
    const sent = after.messages.filter(message => message.status === 'sent').length;
    const total = after.messages.length;
    const now = Date.now();
    if (!failure) {
      this.batches.update(batchId, { status: 'sent', notBefore: null, lastResult: `已发出 ${total} 条` });
      this.logs.write({ module: 'Plan', action: '发送', status: 'ok', taskId: batchId, groupName: group.name, attempt, message: `${label}：已发出 ${total} 条` });
    } else if (failure.blocked) {
      this.batches.update(batchId, { status: 'planned', attempts: attempt - 1, notBefore: new Date(now + BLOCKED_DELAY_MS).toISOString(), lastResult: `${sent ? `已发出 ${sent}/${total} 条，` : ''}${failure.detail}，${fmt(new Date(now + BLOCKED_DELAY_MS))} 再试` });
      this.logs.write({ module: 'Plan', action: '发送', status: 'info', taskId: batchId, groupName: group.name, attempt, message: `${label}：被防封规则拦下，稍后再试（${failure.detail}）` });
    } else if (attempt < MAX_BATCH_ATTEMPTS) {
      this.batches.update(batchId, { status: 'planned', notBefore: new Date(now + RETRY_DELAY_MS).toISOString(), lastResult: `已发出 ${sent}/${total} 条，${failure.detail}；5 分钟后重发没发出去的` });
      this.logs.write({ module: 'Plan', action: '发送', status: 'fail', taskId: batchId, groupName: group.name, attempt, message: `${label}：已发出 ${sent}/${total} 条，5 分钟后重发没发出去的`, detail: failure.detail });
    } else {
      this.batches.update(batchId, { status: sent ? 'partial' : 'failed', lastResult: `已发出 ${sent}/${total} 条：${failure.detail}` });
      this.logs.write({ module: 'Plan', action: '发送', status: 'fail', taskId: batchId, groupName: group.name, attempt, message: `${label}：试了 ${attempt} 次，已发出 ${sent}/${total} 条，请到发送计划里手动重发`, detail: failure.detail });
    }
    return this.batches.get(batchId)!;
  }

  private view(batch: StoredBatch, group?: OpsGroup): SendBatch {
    return {
      id: batch.id, groupId: batch.groupId, groupName: group?.name ?? '（群已删除）', kind: batch.kind, date: batch.date, dayNo: batch.dayNo, status: batch.status,
      notBefore: batch.notBefore, attempts: batch.attempts, lastResult: batch.lastResult, labels: batch.messages.map(message => message.label), messages: batch.messages.map(strip), updatedAt: batch.updatedAt,
    };
  }
}

/** 给界面的消息不带本机图片路径。 */
function strip(message: PlanMessage): PlanMessage { return { ...message, images: [] }; }

// ───────── 首页（只读汇总 + 今晚预览） ─────────
export class DashboardService {
  constructor(private readonly plans: PlanService, private readonly groups: GroupService, private readonly logs: LogService, private readonly settings: () => SendSettings) {}

  get(): Dashboard {
    const today = localDateText(new Date());
    const groups = this.groups.list();
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    return {
      today,
      eveningStart: this.settings().tour.eveningStart,
      ongoing: groups.filter(group => group.phase === 'ongoing' && group.tour?.state !== 'cancelled').length,
      upcoming: groups.filter(group => group.phase === 'upcoming' && group.tour?.state !== 'cancelled').length,
      tonight: this.plans.list({ from: today, to: today }),
      ongoingGroups: groups.filter(group => group.phase === 'ongoing' && group.tour?.state !== 'cancelled').map(group => ({ id: group.id, name: group.name, routeName: group.routeName, dayNo: group.dayNo, tourDays: group.tourDays, endDate: group.endDate })),
      recentFailures: this.logs.list({ status: 'fail', limit: 50 }).filter(entry => entry.time >= since && (entry.module === 'Plan' || entry.module === 'RPA')).slice(0, 6),
    };
  }
}
