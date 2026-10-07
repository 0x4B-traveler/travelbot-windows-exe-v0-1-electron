import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MaterialKind, SampleDailyInput, SampleDailyResult, SampleDataResult, SamplePlanInput, SamplePlanResult } from '../../src/domain/ops';
import type { MaterialRepository } from '../infrastructure/repositories';
import type { FileStore } from './ports';
import { OpsError, type ContentService, type GroupService, type LogService, type RouteService, type TaskService } from './services';

// 示例数据：把 sample-data/<name>/seed.json 里的素材（带图片）、路线导入，并为每条路线生成一条已审核的群文案，
// 方便不录入真实资料就能完整测试“任务 → 发送文字 + 攻略图/路线图 + 天气”。重复导入会跳过同名素材和路线。

type SeedMaterial = { key: string; kind: MaterialKind; title: string; city: string; tags: string[]; body: string; images: string[] };
type SeedRouteItem = { day: number; time: string; title: string; material?: string; note: string };
type SeedRoute = { key: string; name: string; city: string; days: number; tags: string[]; summary: string; weatherCity: string; items: SeedRouteItem[] };
type Seed = { name: string; tag: string; materials: SeedMaterial[]; routes: SeedRoute[] };

export class SampleDataService {
  constructor(
    private readonly root: string,
    private readonly materials: MaterialRepository,
    private readonly files: FileStore,
    private readonly routes: RouteService,
    private readonly contents: ContentService,
    private readonly logs: LogService,
    private readonly tasks: TaskService,
    private readonly groups: GroupService,
  ) {}

  private seed(name: string): { dir: string; seed: Seed } {
    const dir = join(this.root, name);
    const seedFile = join(dir, 'seed.json');
    if (!/^[a-z0-9-]+$/.test(name) || !existsSync(seedFile)) throw new OpsError(`找不到示例数据“${name}”`);
    return { dir, seed: JSON.parse(readFileSync(seedFile, 'utf8')) as Seed };
  }

  /**
   * 一周测试排期：群按示例路线数分成几组，每个时段一组群收一条路线文案（附路线天气），
   * 每天轮换路线，路线数天之内每个群都会收到全部路线（覆盖全部景点）。都是“仅一次”任务，可在运营任务里逐个取消。
   */
  planWeek(input: SamplePlanInput): SamplePlanResult {
    const { seed } = this.seed(input.name);
    const groupIds = [...new Set(input.groupIds ?? [])];
    if (!groupIds.length) throw new OpsError('请至少选择一个群');
    const days = Math.min(14, Math.max(1, Math.round(input.days) || 7));
    const interval = Math.min(240, Math.max(10, Math.round(input.intervalMinutes) || 35));
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.startDate ?? '');
    const time = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(input.startTime ?? '');
    if (!date || !time) throw new OpsError('请填写开始日期和第一次发送时间');
    const plan = this.sampleContents(seed);
    if (!plan.length) throw new OpsError('还没有示例路线的群文案，请先在素材库导入示例数据');
    // 群按顺序轮流分到各组，组数不超过路线数。
    const buckets = Array.from({ length: Math.min(plan.length, groupIds.length) }, () => [] as string[]);
    groupIds.forEach((id, index) => buckets[index % buckets.length].push(id));
    const firstAt = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]), Number(time[1]), Number(time[2]));
    if (firstAt.getTime() < Date.now()) throw new OpsError('第一次发送时间已经过去了，请从明天开始');
    const runs: Date[] = [];
    for (let day = 0; day < days; day += 1) {
      buckets.forEach((bucket, slot) => {
        const runAt = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]) + day, Number(time[1]), Number(time[2]) + slot * interval);
        const item = plan[(slot + day) % plan.length];
        this.tasks.create({ contentId: item.contentId, groupIds: bucket, runAt: runAt.toISOString(), repeat: 'once', weatherCity: item.weatherCity });
        runs.push(runAt);
      });
    }
    const result = { tasks: runs.length, groups: groupIds.length, sendsPerDay: groupIds.length, firstAt: runs[0].toISOString(), lastAt: runs[runs.length - 1].toISOString() };
    this.logs.write({ module: 'Scheduler', action: '生成测试排期', status: 'ok', message: `${seed.name}：${result.groups} 个群、${days} 天、共 ${result.tasks} 个任务` });
    return result;
  }

  /** 每天固定时刻给一个群各发 perSlot 条示例文案（每条间隔 gapMinutes 分钟，轮换路线和天气），都是“每天”重复的任务。 */
  planDaily(input: SampleDailyInput): SampleDailyResult {
    const { seed } = this.seed(input.name);
    const group = this.groups.get(input.groupId);
    const times = [...new Set((input.times ?? []).map(value => value.trim()).filter(Boolean))].sort();
    if (!times.length) throw new OpsError('请至少填一个发送时刻');
    const invalid = times.find(value => !/^([01]?\d|2[0-3]):[0-5]\d$/.test(value));
    if (invalid) throw new OpsError(`时刻“${invalid}”格式应为 HH:mm`);
    const perSlot = Math.min(20, Math.max(1, Math.round(input.perSlot) || 10));
    const gap = Math.min(60, Math.max(1, Math.round(input.gapMinutes) || 3));
    const plan = this.sampleContents(seed);
    if (!plan.length) throw new OpsError('还没有示例路线的群文案，请先在素材库导入示例数据');
    const today = new Date();
    let created = 0;
    times.forEach(value => {
      const [hour, minute] = value.split(':').map(Number);
      for (let index = 0; index < perSlot; index += 1) {
        const runAt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, minute + index * gap);
        const item = plan[(created + index) % plan.length];
        this.tasks.create({ contentId: item.contentId, groupIds: [group.id], runAt: runAt.toISOString(), repeat: 'daily', weatherCity: item.weatherCity });
      }
      created += perSlot;
    });
    this.logs.write({ module: 'Scheduler', action: '生成定时测试', status: 'ok', message: `“${group.name}”每天 ${times.join('、')} 各发 ${perSlot} 条，共 ${created} 个每天任务` });
    return { tasks: created, perDay: created, groupName: group.name };
  }

  /** 示例路线对应的已审核群文案，按 seed 里的路线顺序。 */
  private sampleContents(seed: Seed): Array<{ contentId: string; weatherCity: string }> {
    const approved = this.contents.list('approved').concat(this.contents.list('scheduled'), this.contents.list('sent'));
    return seed.routes.map(item => {
      const route = this.routes.list({ text: item.name }).find(candidate => candidate.name === item.name);
      const piece = route && approved.find(candidate => candidate.routeId === route.id && candidate.channel === '群文案');
      return piece ? { contentId: piece.id, weatherCity: item.weatherCity } : null;
    }).filter((item): item is { contentId: string; weatherCity: string } => Boolean(item));
  }

  async load(name: string): Promise<SampleDataResult> {
    const { dir, seed } = this.seed(name);
    const result: SampleDataResult = { name: seed.name, materials: 0, images: 0, routes: 0, contents: 0, skipped: 0, weatherCities: [] };

    const ids = new Map<string, string>();
    for (const item of seed.materials) {
      const existing = this.materials.list({ city: item.city, text: item.title }).find(material => material.title === item.title && material.kind === item.kind);
      if (existing) { ids.set(item.key, existing.id); result.skipped += 1; continue; }
      const material = this.materials.insert({ kind: item.kind, title: item.title, body: item.body, city: item.city, tags: item.tags, source: 'file' });
      ids.set(item.key, material.id);
      result.materials += 1;
      for (const image of item.images) {
        const path = join(dir, image);
        if (!existsSync(path)) continue;
        this.materials.addImage(material.id, this.files.importFile(path), '');
        result.images += 1;
      }
    }

    for (const item of seed.routes) {
      result.weatherCities.push(`${item.name}：${item.weatherCity}`);
      if (this.routes.list({ text: item.name }).some(route => route.name === item.name)) { result.skipped += 1; continue; }
      const route = this.routes.save({
        name: item.name, city: item.city, days: item.days, tags: item.tags, summary: item.summary, status: 'enabled',
        items: item.items.map(step => ({ day: step.day, time: step.time, title: step.title, note: step.note, materialId: step.material ? ids.get(step.material) : undefined })),
      });
      result.routes += 1;
      const piece = await this.contents.generate({ routeId: route.id, channel: '群文案' });
      this.contents.submit(piece.id);
      this.contents.approve(piece.id);
      result.contents += 1;
    }

    this.logs.write({ module: 'System', action: '导入示例数据', status: 'ok', message: `${seed.name}：新增素材 ${result.materials} 条、图片 ${result.images} 张、路线 ${result.routes} 条、群文案 ${result.contents} 条，跳过已存在 ${result.skipped} 项` });
    return result;
  }
}
