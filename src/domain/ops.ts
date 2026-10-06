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
  updatedAt: string;
};

export type GroupCapabilities = { text: boolean; image: boolean; needsConfirm: boolean };
export const GROUP_CAPABILITIES: Record<GroupChannel, GroupCapabilities> = {
  bot: { text: true, image: false, needsConfirm: false },
  customer: { text: true, image: false, needsConfirm: true },
};
export type RefreshResult = { added: number; updated: number; missing: number; warnings: string[] };

// ───────── 运行日志 ─────────
export type LogModule = 'Scheduler' | 'Task' | 'WeCom' | 'Content' | 'Group' | 'Itinerary' | 'DailyPush' | 'System';
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
  'group.update'(input: { id: string; enabled?: boolean; matchMode?: GroupMatchMode }): Promise<OpsGroup>;
  'group.testSend'(input: { id: string; text: string }): Promise<string>;

  'log.list'(query: LogQuery): Promise<LogEntry[]>;
}

export type OpsMethod = keyof OpsApi;
export type OpsResponse<T> = { ok: true; data: T } | { ok: false; error: string };
