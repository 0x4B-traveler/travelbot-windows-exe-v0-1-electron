// 旅游运营助手的业务领域模型，主进程（Service / Infrastructure）和界面共用。
// 客户只录三样东西：素材库里的路线（含酒店、景点攻略）、群管理里的团（群名 + 出发日期 + 路线）、内容中心里的模板。
// 软件按团的出行日期每天傍晚自动组织内容并发送，团结束后自动停发。

// ───────── 素材库 ─────────
export type MaterialKind = 'spot' | 'guide' | 'hotel' | 'restaurant' | 'route';
export const MATERIAL_KIND_LABELS: Record<MaterialKind, string> = { spot: '景点', guide: '攻略', hotel: '酒店', restaurant: '餐厅', route: '线路' };
export type MaterialSource = 'manual' | 'excel' | 'file';
export const MATERIAL_SOURCE_LABELS: Record<MaterialSource, string> = { manual: '手动', excel: 'Excel', file: '文件' };

export type MaterialImage = { id: string; fileName: string; caption: string };

export type Material = {
  id: string;
  kind: MaterialKind;
  title: string;
  body: string;
  city: string;
  tags: string[];
  source: MaterialSource;
  images: MaterialImage[];
  createdAt: string;
  updatedAt: string;
};

export type MaterialQuery = { text?: string; kind?: MaterialKind; city?: string; tag?: string };
export type MaterialInput = { id?: string; kind: MaterialKind; title: string; body: string; city: string; tags: string[] };
export type MaterialFacets = { cities: string[]; tags: string[] };
export type ImportResult = { added: number; errors: string[] };
/** 导入示例数据的结果。 */
export type SampleDataResult = { name: string; materials: number; images: number; routes: number; skipped: number; tour?: { groupName: string; startDate: string } };

// ───────── 路线（素材库的核心：固定的几天行程，每天一行） ─────────
export type RouteStatus = 'enabled' | 'disabled';
/** 路线的一天：所在城市（查天气用）、当天行程、当晚住的酒店、这天要发的景点攻略。 */
export type RouteDay = { day: number; city: string; plan: string; hotelId?: string; spotIds: string[] };

export type Route = {
  id: string;
  name: string;
  /** 第一天的城市，列表里展示用。 */
  city: string;
  days: number;
  tags: string[];
  summary: string;
  status: RouteStatus;
  dayPlans: RouteDay[];
  createdAt: string;
  updatedAt: string;
};

export type RouteQuery = { text?: string; city?: string; days?: number };
export type RouteInput = { id?: string; name: string; tags: string[]; summary: string; status: RouteStatus; dayPlans: RouteDay[] };
/** 从 Excel 贴入的路线日程（第几天、城市、行程、酒店、景点），酒店和景点按名称匹配素材，没有的自动新建。 */
export type RouteDaysImport = { dayPlans: RouteDay[]; created: string[]; errors: string[] };

// ───────── 团（群管理：一个群对应一个团） ─────────
/** normal：按日期自动发；paused：暂停，不发但保留计划；cancelled：团取消，不再发。 */
export type TourState = 'normal' | 'paused' | 'cancelled';
/** 由出发日期和路线天数算出：待出发 → 进行中 → 已结束。没绑团的群是 none。 */
export type TourPhase = 'none' | 'upcoming' | 'ongoing' | 'ended';
export const TOUR_PHASE_LABELS: Record<TourPhase, string> = { none: '未绑定团', upcoming: '待出发', ongoing: '进行中', ended: '已结束' };
export const TOUR_STATE_LABELS: Record<TourState, string> = { normal: '正常', paused: '已暂停', cancelled: '已取消' };

export type Tour = {
  routeId: string;
  /** 出发日期 YYYY-MM-DD（本地日期），结束日期 = 出发日期 + 路线天数 - 1。 */
  startDate: string;
  state: TourState;
  /** 这个团按天换的酒店：{ 第几天: 酒店素材 id }，空字符串表示这天不发酒店TIPS。 */
  hotelOverrides: Record<string, string>;
  note: string;
};

export type TourInput = { routeId: string; startDate: string; hotelOverrides?: Record<string, string>; note?: string };

/** 数据库字段沿用接口版，RPA 版的群都是 customer。 */
export type GroupChannel = 'bot' | 'customer';
export type GroupMatchMode = 'id' | 'name';

export type OpsGroup = {
  id: string;
  chatId: string;
  name: string;
  channel: GroupChannel;
  owner: string;
  memberCount: number;
  enabled: boolean;
  matchMode: GroupMatchMode;
  /** 最近一次刷新时是否还能找到这个群 */
  available: boolean;
  lastSentAt?: string;
  todaySent: number;
  /** RPA 账号池里负责这个群的账号，留空用第一个可用账号。 */
  accountId?: string;
  /** 这个群对应的团；没绑团的群（比如测试用的文件传输助手）只能手动发消息。 */
  tour?: Tour;
  /** 以下由团和路线算出，只读。 */
  routeName?: string;
  tourDays?: number;
  endDate?: string;
  phase: TourPhase;
  /** 今天是行程第几天（进行中才有）。 */
  dayNo?: number;
  updatedAt: string;
};

/** RPA 版的群都按群名手动添加，发送时在客户端里搜索群名；chatId 只是本地编号。 */
export const MANUAL_CHAT_PREFIX = 'manual:';
export type GroupAddInput = { name: string; accountId?: string; tour?: TourInput };
export type GroupUpdateInput = { id: string; name?: string; enabled?: boolean; accountId?: string; tour?: TourInput | null; state?: TourState };

// ───────── 内容中心：模板 + 天气对照表 ─────────
export type TemplateKey = 'reminder' | 'hotel' | 'spot' | 'overview' | 'hotelList';
export const TEMPLATE_KEYS: TemplateKey[] = ['reminder', 'hotel', 'spot', 'overview', 'hotelList'];
export type TemplateMeta = { label: string; when: string; placeholders: string[] };
export const TEMPLATE_META: Record<TemplateKey, TemplateMeta> = {
  reminder: { label: '明日提醒', when: '每天傍晚发，内容是明天的天气、行程和建议', placeholders: ['城市', '最低', '最高', '天气', '出行必备', '明日行程', '建议着装', '日期', '第几天'] },
  hotel: { label: '酒店及周边TIPS', when: '每天傍晚发，介绍今晚住的酒店；这天没填酒店就不发', placeholders: ['酒店', '酒店介绍', '城市'] },
  spot: { label: '景点游玩攻略', when: '每天傍晚发，路线里明天指定的景点，一个景点一条，附攻略图', placeholders: ['景点', '攻略', '城市'] },
  overview: { label: '行程总览', when: '出发前一天傍晚发一次', placeholders: ['路线', '天数', '出发日期', '结束日期', '每日行程'] },
  hotelList: { label: '酒店明细', when: '出发前一天傍晚发一次；路线里没有酒店就不发', placeholders: ['路线', '酒店列表'] },
};
export const DEFAULT_TEMPLATES: Record<TemplateKey, string> = {
  reminder: '【明日提醒】明日{城市}[天气参考{最低}-{最高}℃，{天气}]\n出行必备：{出行必备}\n明日行程：{明日行程}\n建议着装：{建议着装}\n如有需要帮助或咨询可以第一时间联系到我',
  hotel: '【酒店及周边TIPS】{酒店}\n{酒店介绍}',
  spot: '【{景点}游玩攻略】{攻略}',
  overview: '【行程总览】{路线}\n{出发日期}出发，共{天数}天\n{每日行程}',
  hotelList: '【酒店明细】\n{酒店列表}',
};
export type MessageTemplate = { key: TemplateKey; body: string; isDefault: boolean; updatedAt?: string };

/** 天气对照表的条件：weather 天气描述里含某个字（如“雨”）；minBelow 最低气温低于；maxAbove 最高气温高于；always 每天都带。 */
export type WeatherRuleKind = 'weather' | 'minBelow' | 'maxAbove' | 'always';
export const WEATHER_RULE_KIND_LABELS: Record<WeatherRuleKind, string> = { weather: '天气含', minBelow: '最低气温低于', maxAbove: '最高气温高于', always: '每天都带' };
export type WeatherRule = { id: string; kind: WeatherRuleKind; value: string; essentials: string; clothing: string };
export const DEFAULT_WEATHER_RULES: Array<Omit<WeatherRule, 'id'>> = [
  { kind: 'weather', value: '雨', essentials: '雨具', clothing: '防水外套' },
  { kind: 'weather', value: '阴', essentials: '保温杯', clothing: '外套、长裤' },
  { kind: 'weather', value: '晴', essentials: '防晒霜、墨镜', clothing: '夏装' },
  { kind: 'minBelow', value: '10', essentials: '保温杯', clothing: '羽绒服或冲锋衣' },
  { kind: 'always', value: '', essentials: '充电宝、常用药品', clothing: '' },
];
/** 明天某个城市的天气（查不到时为 null）。 */
export type DayWeather = { city: string; date: string; condition: string; min: number; max: number };

// ───────── 发送计划（每个团每晚一组，自动排出） ─────────
/** evening：每天傍晚的一组；oneoff：群详情里临时发的一条。 */
export type BatchKind = 'evening' | 'oneoff';
export type BatchStatus = 'planned' | 'sending' | 'sent' | 'partial' | 'failed' | 'skipped' | 'missed';
export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = { planned: '待发送', sending: '发送中', sent: '已发送', partial: '部分发出', failed: '失败', skipped: '已跳过', missed: '已错过' };
export type PlanMessageStatus = 'pending' | 'sent' | 'failed';
export type PlanMessage = { label: string; text: string; images: string[]; imageCount: number; status: PlanMessageStatus; sentAt?: string; error?: string };
export type SendBatch = {
  /** 还没开始发的计划没有 id（按团实时算出），开始发、跳过或取消后才存进数据库。 */
  id?: string;
  groupId: string;
  groupName: string;
  kind: BatchKind;
  /** 发送当天的日期 YYYY-MM-DD。 */
  date: string;
  /** 明天是行程第几天（出发前一天为 1，包含行程总览）。 */
  dayNo?: number;
  status: BatchStatus;
  /** 最早什么时候开始发（傍晚开始时间或重试时间）。 */
  notBefore?: string;
  attempts: number;
  lastResult?: string;
  labels: string[];
  messages?: PlanMessage[];
  updatedAt?: string;
};
export type PlanQuery = { from?: string; to?: string; groupId?: string };
/** 预览某个群某天傍晚会收到的内容（实时查天气，不发送）。 */
export type BatchPreview = { groupName: string; date: string; dayNo?: number; messages: PlanMessage[]; weather: DayWeather | null; notes: string[] };
export type TourScheduleSettings = { /** 每天傍晚开始发送的时间（HH:mm） */ eveningStart: string; /** 开机自动启动（最小化到托盘），电脑重启后照常发 */ launchAtLogin: boolean };
export const DEFAULT_TOUR_SCHEDULE: TourScheduleSettings = { eveningStart: '15:00', launchAtLogin: true };


// ───────── 发送（RPA：自动操作本机的企业微信 / 微信客户端，搜索群名后粘贴发送） ─────────
export type RpaClient = 'wecom' | 'wechat';
export const RPA_CLIENT_LABELS: Record<RpaClient, string> = { wecom: '企业微信', wechat: '微信' };
export type RpaSendKey = 'enter' | 'ctrlEnter';
export type RpaSettings = {
  client: RpaClient;
  /** false：只把内容粘贴进输入框，由人工按发送，适合先试跑。 */
  autoSend: boolean;
  /** 客户端里“发送消息”的按键，和客户端设置保持一致。 */
  sendKey: RpaSendKey;
  /** 打开搜索框的快捷键（SendKeys 写法，^ 表示 Ctrl、% 表示 Alt），默认 ^f。 */
  searchHotkey: string;
  /** 每一步之间的等待毫秒数，电脑较慢时调大。 */
  stepDelayMs: number;
  /** 客户端没运行时用来启动它的 exe 路径，可留空。 */
  clientPath: string;
  /** 打开聊天后用 Windows 自带 OCR 识别聊天标题，和群名对不上就不发。 */
  verifyChat: boolean;
  /** 发送成功后把客户端窗口最小化，并切回发送前的前台窗口，不让客户端一直停在前台。 */
  minimizeAfterSend: boolean;
  guard: RpaGuard;
};
/** 防封：按真人的节奏、频率和时段发送，出问题自动停手。 */
export type RpaGuard = {
  /** 群与群之间随机间隔（秒）。每一步按键的等待也会自动加随机抖动。 */
  groupGapMinSec: number;
  groupGapMaxSec: number;
  /** 只在这个时段内发送（HH:mm），时段外到点的任务顺延到下一个时段开始。 */
  activeStart: string;
  activeEnd: string;
  /** 每小时 / 每天最多发几次（发到一个群算一次，图片跟着文字不另算）。 */
  maxPerHour: number;
  maxPerDay: number;
  /** 同一个群每天最多发几次。 */
  maxPerGroupPerDay: number;
  /** 连续失败几次就暂停 RPA，暂停多少分钟。 */
  pauseAfterFailures: number;
  pauseMinutes: number;
  /** 开头随机加一句问候（旧版同一段文字群发多个群时用）。团的消息按模板原样发，各群的天气和行程本来就不同，所以默认关闭。 */
  varyOpening: boolean;
  /** 每次最多附几张路线素材里的攻略图，0 表示不发图。 */
  maxImages: number;
};
// ───────── RPA 账号池（多台电脑，一台一个账号） ─────────
/** master：主控，管内容、任务、群，按群把发送指令分给账号；agent：执行端，在局域网里接收主控的指令，用本机客户端发。 */
export type PoolRole = 'master' | 'agent';
export const POOL_ROLE_LABELS: Record<PoolRole, string> = { master: '主控', agent: '执行端' };
export const LOCAL_ACCOUNT_ID = 'local';
export type RpaAccount = {
  id: string;
  name: string;
  /** local：本机客户端；remote：局域网里另一台电脑上的执行端。 */
  kind: 'local' | 'remote';
  host: string;
  port: number;
  token: string;
  enabled: boolean;
};
export type PoolSettings = {
  role: PoolRole;
  accounts: RpaAccount[];
  /** 本机作为执行端时监听的端口和配对口令。 */
  agentPort: number;
  agentToken: string;
};
export const DEFAULT_AGENT_PORT = 47820;
export const DEFAULT_POOL_SETTINGS: PoolSettings = { role: 'master', accounts: [{ id: LOCAL_ACCOUNT_ID, name: '本机', kind: 'local', host: '', port: 0, token: '', enabled: true }], agentPort: DEFAULT_AGENT_PORT, agentToken: '' };
/** 群实际由哪个账号发：绑定的账号可用就用它，否则用第一个可用账号。 */
export function resolveAccount(pool: PoolSettings, accountId?: string): RpaAccount | null {
  const enabled = pool.accounts.filter(account => account.enabled);
  return enabled.find(account => account.id === accountId) ?? (accountId && pool.accounts.some(account => account.id === accountId) ? null : enabled[0] ?? null);
}
/** 账号状态（主控测试连接、执行端自检时返回）。 */
export type AccountStatus = { ok: boolean; detail: string; client?: string; sentToday?: number; pausedUntil?: string };

export type SendSettings = { rpa: RpaSettings; pool: PoolSettings; /** 团的每日发送时间（只在主控上用）。 */ tour: TourScheduleSettings };
/** 提醒邮件：客户端弹出安全验证等需要人马上处理的情况，发邮件到这些邮箱（每台电脑各自配置）。 */
export type MailSettings = { enabled: boolean; host: string; port: number; secure: boolean; user: string; /** 收件人，多个用逗号分隔 */ to: string };
export type MailSettingsView = MailSettings & { hasPassword: boolean };
export type MailSettingsInput = MailSettings & { /** 留空表示保留已保存的授权码 */ password?: string };
export const DEFAULT_RPA_GUARD: RpaGuard = { groupGapMinSec: 60, groupGapMaxSec: 180, activeStart: '07:30', activeEnd: '21:30', maxPerHour: 10, maxPerDay: 40, maxPerGroupPerDay: 3, pauseAfterFailures: 3, pauseMinutes: 30, varyOpening: false, maxImages: 3 };
/** 防封规则全部内置、界面上不显示也不能改（发送时段、附图张数也固定）；旧版本保存的自定义值一律不再生效。 */
export function builtInGuard(_input?: Partial<RpaGuard>): RpaGuard {
  return { ...DEFAULT_RPA_GUARD };
}
/** 自己的“文件传输助手”不是群，不受单群每天次数限制（只用来测试），但仍计入每小时、每天的总次数。 */
export const SELF_CHAT_NAME = '文件传输助手';
export const DEFAULT_SEND_SETTINGS: SendSettings = { rpa: { client: 'wecom', autoSend: true, sendKey: 'enter', searchHotkey: '^f', stepDelayMs: 800, clientPath: '', verifyChat: true, minimizeAfterSend: true, guard: DEFAULT_RPA_GUARD }, pool: DEFAULT_POOL_SETTINGS, tour: DEFAULT_TOUR_SCHEDULE };

// ───────── 运行日志 ─────────
export type LogModule = 'Scheduler' | 'Plan' | 'Tour' | 'Content' | 'Group' | 'RPA' | 'System' | 'Task' | 'Itinerary' | 'DailyPush';
export type LogStatus = 'ok' | 'fail' | 'info';
export type LogEntry = {
  id: string;
  time: string;
  module: LogModule;
  action: string;
  status: LogStatus;
  message: string;
  /** 发送计划的那一组（旧版本是运营任务 id）。 */
  taskId?: string;
  groupName?: string;
  attempt?: number;
  /** RPA 发送用的账号 id。 */
  account?: string;
  /** 同一组消息共用一个 batchId，防封计数时一组只算一次。 */
  batchId?: string;
  detail?: string;
};
export type LogQuery = { status?: LogStatus; module?: LogModule; taskId?: string; limit?: number };

// ───────── 首页 ─────────
export type Dashboard = {
  today: string;
  eveningStart: string;
  ongoing: number;
  upcoming: number;
  tonight: SendBatch[];
  ongoingGroups: Array<Pick<OpsGroup, 'id' | 'name' | 'routeName' | 'dayNo' | 'tourDays' | 'endDate'>>;
  recentFailures: LogEntry[];
};

// ───────── 备份 ─────────
export type BackupResult = { path: string; routes: number; groups: number; materials: number; images: number };

// ───────── 界面 ↔ 主进程接口（IPC 相当于 API 层） ─────────
// 每个方法只接收一个参数对象，主进程统一返回 { ok, data } 或 { ok: false, error }。
export interface OpsApi {
  'dashboard.get'(): Promise<Dashboard>;

  'material.list'(query: MaterialQuery): Promise<Material[]>;
  'material.facets'(): Promise<MaterialFacets>;
  'material.save'(input: MaterialInput): Promise<Material>;
  'material.delete'(input: { id: string }): Promise<void>;
  'material.import'(input: { text: string }): Promise<ImportResult>;
  'material.addImages'(input: { id: string }): Promise<Material>;
  'material.removeImage'(input: { id: string; imageId: string }): Promise<Material>;
  'material.imageData'(input: { imageId: string }): Promise<string | null>;
  /** 导入随程序附带的示例数据（素材 + 图片 + 一条路线），可选再建一个发到文件传输助手的测试团。 */
  'sample.load'(input: { name: string; testTour?: boolean }): Promise<SampleDataResult>;

  'route.list'(query: RouteQuery): Promise<Route[]>;
  'route.save'(input: RouteInput): Promise<Route>;
  'route.delete'(input: { id: string }): Promise<void>;
  /** 解析从 Excel 复制的日程表，按名称匹配酒店和景点素材，找不到的新建空素材。 */
  'route.parseDays'(input: { text: string }): Promise<RouteDaysImport>;

  'template.list'(): Promise<MessageTemplate[]>;
  'template.save'(input: { key: TemplateKey; body: string }): Promise<MessageTemplate>;
  'template.reset'(input: { key: TemplateKey }): Promise<MessageTemplate>;
  'weatherRule.list'(): Promise<WeatherRule[]>;
  'weatherRule.save'(input: { rules: Array<Omit<WeatherRule, 'id'> & { id?: string }> }): Promise<WeatherRule[]>;
  /** 查某个城市某天的天气，并给出对照表算出的出行必备和建议着装。 */
  'weatherRule.test'(input: { city: string; date: string }): Promise<{ weather: DayWeather | null; essentials: string; clothing: string; error?: string }>;

  'plan.list'(query: PlanQuery): Promise<SendBatch[]>;
  'plan.preview'(input: { groupId: string; date: string }): Promise<BatchPreview>;
  /** 跳过某个群某天的一组（首页今晚预览、发送计划里用），已发出的不受影响。 */
  'plan.skip'(input: { groupId: string; date: string }): Promise<SendBatch>;
  'plan.unskip'(input: { groupId: string; date: string }): Promise<SendBatch>;
  /** 重发一组里还没发出去的消息。 */
  'plan.retry'(input: { id: string }): Promise<SendBatch>;
  /** 不等傍晚开始时间，现在就发今天这一组（仍受防封规则限制）。 */
  'plan.sendNow'(input: { groupId: string; date: string }): Promise<SendBatch>;
  /** 把某个群某天的一组发到文件传输助手试看，不发到群里。 */
  'plan.sendToSelf'(input: { groupId: string; date: string }): Promise<SendBatch>;

  'group.list'(): Promise<OpsGroup[]>;
  'group.add'(input: GroupAddInput): Promise<OpsGroup>;
  'group.update'(input: GroupUpdateInput): Promise<OpsGroup>;
  /** 临时发一条消息（比如拼团通知），也走防封规则，算一次发送。 */
  'group.sendMessage'(input: { id: string; text: string }): Promise<SendBatch>;
  'group.delete'(input: { id: string }): Promise<void>;

  'settings.getSend'(): Promise<SendSettings>;
  'settings.saveSend'(input: SendSettings): Promise<SendSettings>;
  /** 检测 RPA 能否找到客户端窗口，不会发送任何消息。 */
  'settings.checkRpa'(input: { rpa?: RpaSettings }): Promise<string>;
  /** 测试连接账号池里的一个账号（本机检测客户端，远程请求执行端）。 */
  'settings.checkAccount'(input: { account: RpaAccount }): Promise<AccountStatus>;
  /** 本机的局域网地址，执行端把它填到主控里。 */
  'settings.agentInfo'(): Promise<{ addresses: string[]; port: number; token: string; listening: boolean; error?: string }>;

  'settings.getMail'(): Promise<MailSettingsView>;
  'settings.saveMail'(input: MailSettingsInput): Promise<MailSettingsView>;
  /** 用界面上的设置（未保存也行）发一封测试邮件。 */
  'settings.testMail'(input: MailSettingsInput): Promise<string>;

  /** 导出备份：数据库里的路线、素材（含图片）、群和团、模板、发送记录，存成一个文件。 */
  'backup.export'(): Promise<BackupResult | null>;
  /** 从备份文件恢复：会替换现在的全部数据，恢复后程序自动重启。 */
  'backup.restore'(): Promise<string | null>;

  'log.list'(query: LogQuery): Promise<LogEntry[]>;
}

export type OpsMethod = keyof OpsApi;
export type OpsResponse<T> = { ok: true; data: T } | { ok: false; error: string };

// ───────── 日期工具（本地日期 YYYY-MM-DD） ─────────
export function localDateText(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function parseDateText(text: string): Date | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getMonth() === Number(match[2]) - 1 ? date : null;
}
export function addDays(text: string, days: number): string {
  const date = parseDateText(text)!;
  date.setDate(date.getDate() + days);
  return localDateText(date);
}
/** b - a 相差几天。 */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDateText(b)!.getTime() - parseDateText(a)!.getTime()) / (24 * 3600 * 1000));
}
/** 10月12日 */
export function shortDate(text: string): string {
  const date = parseDateText(text);
  return date ? `${date.getMonth() + 1}月${date.getDate()}日` : text;
}
/** 团今天处在哪个阶段、第几天。 */
export function tourPhase(startDate: string, days: number, today: string): { phase: TourPhase; dayNo?: number } {
  if (!parseDateText(startDate)) return { phase: 'none' };
  const dayNo = daysBetween(startDate, today) + 1;
  if (dayNo < 1) return { phase: 'upcoming' };
  if (dayNo > days) return { phase: 'ended' };
  return { phase: 'ongoing', dayNo };
}
