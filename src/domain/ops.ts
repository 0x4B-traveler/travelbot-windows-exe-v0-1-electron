// 旅游运营助手的业务领域模型，主进程（Service / Infrastructure）和界面共用。
// 模块分工：素材库负责“有什么”，路线负责“怎么玩”，内容中心负责“怎么说”，
// 运营任务负责“什么时候发”，群管理负责“发给谁”，分发适配器负责“怎么发”，日志负责“出了什么问题”。

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

// ───────── 路线管理 ─────────
export type RouteStatus = 'enabled' | 'disabled';
export type RouteItem = { id: string; day: number; time: string; title: string; materialId?: string; note: string };

export type Route = {
  id: string;
  name: string;
  city: string;
  days: number;
  tags: string[];
  summary: string;
  status: RouteStatus;
  items: RouteItem[];
  createdAt: string;
  updatedAt: string;
};

export type RouteQuery = { text?: string; city?: string; days?: number };
export type RouteInput = Omit<Route, 'id' | 'createdAt' | 'updatedAt' | 'items'> & { id?: string; items: Array<Omit<RouteItem, 'id'> & { id?: string }> };

// ───────── 内容中心 ─────────
export type ContentStatus = 'draft' | 'reviewing' | 'approved' | 'scheduled' | 'sent';
export const CONTENT_STATUS_LABELS: Record<ContentStatus, string> = { draft: '草稿', reviewing: '待审核', approved: '已通过', scheduled: '已排期', sent: '已发送' };
export const CONTENT_CHANNELS = ['群文案', '小红书', '攻略', '通知'] as const;
export type ContentChannel = (typeof CONTENT_CHANNELS)[number];
export type ContentSource = 'ai' | 'template' | 'manual';
export const CONTENT_SOURCE_LABELS: Record<ContentSource, string> = { ai: 'AI 生成', template: '模板生成', manual: '人工编写' };

export type ContentPiece = {
  id: string;
  title: string;
  channel: ContentChannel;
  body: string;
  status: ContentStatus;
  source: ContentSource;
  routeId?: string;
  routeName?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
};

export type ContentVersion = { version: number; body: string; note: string; createdAt: string };
export type ContentInput = { id?: string; title: string; channel: ContentChannel; body: string; routeId?: string };
export type GenerateInput = { routeId: string; channel: ContentChannel };

// ───────── 运营任务 ─────────
export type TaskRepeat = 'once' | 'daily' | 'weekly';
export const TASK_REPEAT_LABELS: Record<TaskRepeat, string> = { once: '一次', daily: '每天', weekly: '每周' };
export type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = { pending: '待执行', running: '执行中', success: '成功', failed: '失败', cancelled: '已取消' };

export type OpsTask = {
  id: string;
  contentId: string;
  contentTitle: string;
  groupIds: string[];
  groupNames: string[];
  /** 首次执行时间（本地时间 ISO） */
  runAt: string;
  repeat: TaskRepeat;
  /** 发送时在文末附上该城市的天气预报 */
  weatherCity: string;
  status: TaskStatus;
  nextRunAt?: string;
  lastRunAt?: string;
  lastResult?: string;
  attempts: number;
  createdAt: string;
};

export type TaskInput = { contentId: string; groupIds: string[]; runAt: string; repeat: TaskRepeat; weatherCity: string };
/** 预演：走完整个发送流程（取内容、拼天气、逐群检查、校验企业微信接口），但不真正发出。 */
export type DryRunGroup = { name: string; channel: GroupChannel; ok: boolean; detail: string };
export type DryRunReport = { contentTitle: string; text: string; groups: DryRunGroup[]; ok: boolean; checkedAt: string };
export type TaskRun = { id: string; taskId: string; startedAt: string; status: 'success' | 'failed' | 'skipped'; detail: string };

// ───────── 群管理 ─────────
export type GroupChannel = 'bot' | 'customer';
export const GROUP_CHANNEL_LABELS: Record<GroupChannel, string> = { bot: '机器人群', customer: '客户群' };
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
  updatedAt: string;
};

export type GroupCapabilities = { text: boolean; image: boolean; needsConfirm: boolean };
export const GROUP_CAPABILITIES: Record<GroupChannel, GroupCapabilities> = {
  bot: { text: true, image: false, needsConfirm: false },
  customer: { text: true, image: false, needsConfirm: true },
};
export type RefreshResult = { added: number; updated: number; missing: number; warnings: string[] };
/** 手动添加的群（RPA 模式按群名搜索发送，不需要接口返回的群 ID）。 */
export const MANUAL_CHAT_PREFIX = 'manual:';
export const isManualGroup = (group: Pick<OpsGroup, 'chatId'>) => group.chatId.startsWith(MANUAL_CHAT_PREFIX);

// ───────── 发送方式（客户群怎么发出去） ─────────
/** api：企业微信“客户群群发”接口，群主确认后发出；rpa：自动操作本机的企业微信 / 微信客户端，搜索群名后粘贴发送。 */
export type SendMode = 'api' | 'rpa';
/** 安装包版本：RPA 版只走桌面客户端，接口版只走企业微信接口，打包时决定（scripts/build.js）。 */
export type Edition = SendMode;
export const EDITION_LABELS: Record<Edition, string> = { rpa: 'RPA 版', api: '接口版' };
export const SEND_MODE_LABELS: Record<SendMode, string> = { api: '企业微信接口（API）', rpa: '桌面客户端（RPA）' };
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
  /** 开头随机加一句问候，避免多个群收到一模一样的文字。 */
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

export type SendSettings = { mode: SendMode; rpa: RpaSettings; pool: PoolSettings };
export const DEFAULT_RPA_GUARD: RpaGuard = { groupGapMinSec: 20, groupGapMaxSec: 60, activeStart: '07:30', activeEnd: '21:30', maxPerHour: 20, maxPerDay: 80, maxPerGroupPerDay: 3, pauseAfterFailures: 3, pauseMinutes: 30, varyOpening: false, maxImages: 3 };
export const DEFAULT_SEND_SETTINGS: SendSettings = { mode: 'api', rpa: { client: 'wecom', autoSend: true, sendKey: 'enter', searchHotkey: '^f', stepDelayMs: 800, clientPath: '', guard: DEFAULT_RPA_GUARD }, pool: DEFAULT_POOL_SETTINGS };
/** 客户群在当前发送方式下的发送能力。 */
export function groupCapabilities(channel: GroupChannel, mode: SendMode): GroupCapabilities {
  return channel === 'customer' && mode === 'rpa' ? { text: true, image: true, needsConfirm: false } : GROUP_CAPABILITIES[channel];
}

// ───────── 运行日志 ─────────
export type LogModule = 'Scheduler' | 'Task' | 'WeCom' | 'Content' | 'Group' | 'Itinerary' | 'DailyPush' | 'RPA' | 'System';
export type LogStatus = 'ok' | 'fail' | 'info';
export type LogEntry = {
  id: string;
  time: string;
  module: LogModule;
  action: string;
  status: LogStatus;
  message: string;
  taskId?: string;
  groupName?: string;
  attempt?: number;
  /** RPA 发送用的账号 id。 */
  account?: string;
  detail?: string;
};
export type LogQuery = { status?: LogStatus; module?: LogModule; taskId?: string; limit?: number };

// ───────── 首页 ─────────
export type DashboardTask = { taskId: string; time: string; title: string; groupNames: string[]; status: TaskStatus | 'skipped' };
export type Dashboard = {
  today: string;
  reviewing: number;
  pendingToday: number;
  successToday: number;
  failedToday: number;
  todayTasks: DashboardTask[];
  recentRoutes: Array<Pick<Route, 'id' | 'name' | 'city' | 'days' | 'tags'>>;
};

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

  'route.list'(query: RouteQuery): Promise<Route[]>;
  'route.save'(input: RouteInput): Promise<Route>;
  'route.delete'(input: { id: string }): Promise<void>;

  'content.list'(query: { status?: ContentStatus }): Promise<ContentPiece[]>;
  'content.versions'(input: { id: string }): Promise<ContentVersion[]>;
  'content.save'(input: ContentInput): Promise<ContentPiece>;
  'content.generate'(input: GenerateInput): Promise<ContentPiece>;
  'content.regenerate'(input: { id: string }): Promise<ContentPiece>;
  'content.submit'(input: { id: string }): Promise<ContentPiece>;
  'content.approve'(input: { id: string }): Promise<ContentPiece>;
  'content.reject'(input: { id: string }): Promise<ContentPiece>;
  'content.delete'(input: { id: string }): Promise<void>;

  'task.list'(query: { status?: TaskStatus }): Promise<OpsTask[]>;
  'task.create'(input: TaskInput): Promise<OpsTask>;
  'task.cancel'(input: { id: string }): Promise<OpsTask>;
  'task.retry'(input: { id: string }): Promise<OpsTask>;
  'task.runNow'(input: { id: string }): Promise<OpsTask>;
  'task.delete'(input: { id: string }): Promise<void>;
  'task.runs'(input: { id: string }): Promise<TaskRun[]>;
  /** 传 id 预演已有任务；传 TaskInput 预演还没创建的任务。都不会真正发出，也不改变任务状态。 */
  'task.dryRun'(input: { id: string } | TaskInput): Promise<DryRunReport>;

  'group.list'(): Promise<OpsGroup[]>;
  'group.refresh'(): Promise<RefreshResult>;
  'group.update'(input: { id: string; enabled?: boolean; matchMode?: GroupMatchMode; accountId?: string }): Promise<OpsGroup>;
  'group.testSend'(input: { id: string; text: string }): Promise<string>;
  /** 手动按群名添加客户群（RPA 模式用，不需要企业微信接口），已存在的同名群会跳过。 */
  'group.add'(input: { names: string[]; accountId?: string }): Promise<OpsGroup[]>;
  /** 只能删除手动添加的群。 */
  'group.delete'(input: { id: string }): Promise<void>;

  'settings.getSend'(): Promise<SendSettings>;
  'settings.saveSend'(input: SendSettings): Promise<SendSettings>;
  /** 检测 RPA 能否找到客户端窗口，不会发送任何消息。 */
  'settings.checkRpa'(input: { rpa?: RpaSettings }): Promise<string>;
  /** 测试连接账号池里的一个账号（本机检测客户端，远程请求执行端）。 */
  'settings.checkAccount'(input: { account: RpaAccount }): Promise<AccountStatus>;
  /** 本机的局域网地址，执行端把它填到主控里。 */
  'settings.agentInfo'(): Promise<{ addresses: string[]; port: number; token: string; listening: boolean; error?: string }>;

  'log.list'(query: LogQuery): Promise<LogEntry[]>;
}

export type OpsMethod = keyof OpsApi;
export type OpsResponse<T> = { ok: true; data: T } | { ok: false; error: string };
