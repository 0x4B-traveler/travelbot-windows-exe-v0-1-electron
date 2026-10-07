export type ContentKind = 'guide' | 'route' | 'spot' | 'restaurant' | 'hotel';

export type ContentItem = {
  id: string;
  kind: ContentKind;
  title: string;
  body: string;
  location?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export const CONTENT_KIND_LABELS: Record<ContentKind, string> = { guide: '攻略', route: '线路', spot: '景点', restaurant: '餐厅', hotel: '酒店' };

export type ContentInput = { kind: ContentKind; title: string; body: string; location?: string; tags?: string[] };

/** 消息模板：在群发、定时任务里复用的固定文案。 */
export type MessageTemplate = {
  id: string;
  name: string;
  category: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type MessageTemplateInput = { id?: string; name: string; category: string; body: string };

export type WeatherSnapshot = {
  location: string;
  latitude: number;
  longitude: number;
  temperatureC: number;
  apparentTemperatureC?: number;
  humidity?: number;
  precipitationMm?: number;
  windSpeedKmh?: number;
  weatherCode: number;
  observedAt: string;
};

export type WeatherGreeting = {
  title: string;
  message: string;
  snapshot: WeatherSnapshot;
};

export type WeatherJobSettings = {
  id: string;
  location: string;
  chatIds: string[];
  intervalMinutes: number;
  enabled: boolean;
  lastSentAt?: string;
  lastResult?: string;
};

export type NaturalLanguageCommand =
  | { intent: 'search'; query: string }
  | { intent: 'create'; kind: ContentKind; title: string; body: string; requiresConfirmation: true }
  | { intent: 'update'; query: string; body: string; requiresConfirmation: true }
  | { intent: 'delete'; query: string; requiresConfirmation: true }
  | { intent: 'unknown'; reason: string };

/** 行程提醒、每日推送用来按群名匹配的群（来自群管理）。 */
export type CustomerGroup = {
  chatId: string;
  name: string;
  owner: string;
  memberCount: number;
};

export type WeatherForecast = {
  location: string;
  /** 本地日期 YYYY-MM-DD */
  date: string;
  weatherCode: number;
  maxC: number;
  minC: number;
  precipitationProbability?: number;
};

/** 每日群推送：每天固定时刻生成“天气预报 + 今日推荐”，通过 RPA 发到选中的群。chatId 是群管理里的群编号。 */
export type DailyPushTarget = { chatId: string; owner: string; name: string };

export type DailyPushSettings = {
  enabled: boolean;
  /** 本地时间 HH:mm */
  sendTime: string;
  includeWeather: boolean;
  location: string;
  includeRecommendation: boolean;
  /** 附加在消息末尾的固定文字，可留空 */
  footer: string;
  targets: DailyPushTarget[];
  launchAtLogin: boolean;
};

export type DailyPushState = {
  /** 最近一次成功处理的本地日期 YYYY-MM-DD */
  lastRunDate?: string;
  /** 当天已发送成功的群，用于部分失败时只重试剩余的群 */
  doneTargets: string[];
  attemptDate?: string;
  attempts: number;
  lastAttemptAt?: string;
  lastRecommendationId?: string;
  lastResult?: string;
};

export type DailyPushView = DailyPushSettings & { state: DailyPushState; nextRunAt?: string };

/** 旅游团行程：每行一个行程节点，按群名对应到群管理里的群。 */
export type ItineraryItem = {
  id: string;
  /** 群名称，需与群管理和客户端里的群名一致 */
  groupName: string;
  /** 本地日期 YYYY-MM-DD */
  date: string;
  /** 本地时间 HH:mm，可为空（全天事项） */
  time: string;
  place: string;
  activity: string;
  /** 天气城市，留空时用地点查询天气 */
  city: string;
  /** 是否在该节点前单独发送一条提醒（否则只出现在前一晚的每日行程里） */
  separate: boolean;
};

export type ItineraryParseResult = { items: ItineraryItem[]; errors: string[] };

export type ItinerarySettings = {
  enabled: boolean;
  /** 干跑模式：到点只生成内容、记录结果，不发送 */
  dryRun: boolean;
  /** 每日行程在出行前一天的发送时间 HH:mm */
  digestTime: string;
  /** 单独提醒提前多少分钟发送 */
  reminderLeadMinutes: number;
  includeWeather: boolean;
  footer: string;
};

export type ItineraryJobKind = 'digest' | 'reminder';

export type ItineraryJobRecord = {
  status: 'created' | 'dry-run' | 'failed';
  attempts: number;
  lastAttemptAt?: string;
  createdAt?: string;
  owner?: string;
  chatId?: string;
  content?: string;
  error?: string;
  /** 已发送到群里 */
  confirmed?: boolean;
};

export type ItineraryJobStatus = 'scheduled' | 'due' | 'created' | 'confirmed' | 'unconfirmed' | 'dry-run' | 'failed' | 'expired' | 'unmatched';

export type ItineraryJobView = {
  id: string;
  kind: ItineraryJobKind;
  groupName: string;
  date: string;
  dueAt: string;
  expiresAt: string;
  summary: string;
  status: ItineraryJobStatus;
  matchError?: string;
  record?: ItineraryJobRecord;
};

export type ItineraryQuota = { groupName: string; month: string; count: number; limit: number };

export type ItineraryView = {
  settings: ItinerarySettings;
  items: ItineraryItem[];
  jobs: ItineraryJobView[];
  quota: ItineraryQuota[];
  warnings: string[];
  lastResult?: string;
};
