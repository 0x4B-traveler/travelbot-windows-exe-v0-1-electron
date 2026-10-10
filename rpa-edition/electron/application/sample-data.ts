import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addDays, localDateText, SELF_CHAT_NAME, type MaterialKind, type SampleDataResult } from '../../src/domain/ops';
import type { MaterialRepository } from '../infrastructure/repositories';
import type { FileStore } from './ports';
import { OpsError, type GroupService, type LogService, type RouteService } from './services';

// 示例数据：把 sample-data/<name>/seed.json 里的素材（景点攻略带图、酒店）和一条按天排好的路线导入，
// 可选再建一个发到“文件传输助手”的测试团，不录入真实资料也能完整测试每天傍晚的发送。重复导入会跳过已存在的。

type SeedMaterial = { key: string; kind: MaterialKind; title: string; city: string; tags: string[]; body: string; images: string[] };
type SeedDay = { day: number; city: string; plan: string; hotel?: string; spots?: string[] };
type SeedTourRoute = { key: string; name: string; tags: string[]; summary: string; days: SeedDay[] };
type Seed = { name: string; tag: string; materials: SeedMaterial[]; tourRoutes?: SeedTourRoute[] };

export class SampleDataService {
  constructor(
    private readonly root: string,
    private readonly materials: MaterialRepository,
    private readonly files: FileStore,
    private readonly routes: RouteService,
    private readonly groups: GroupService,
    private readonly logs: LogService,
  ) {}

  private seed(name: string): { dir: string; seed: Seed } {
    const dir = join(this.root, name);
    const seedFile = join(dir, 'seed.json');
    if (!/^[a-z0-9-]+$/.test(name) || !existsSync(seedFile)) throw new OpsError(`找不到示例数据“${name}”`);
    return { dir, seed: JSON.parse(readFileSync(seedFile, 'utf8')) as Seed };
  }

  async load(name: string, testTour = false): Promise<SampleDataResult> {
    const { dir, seed } = this.seed(name);
    const result: SampleDataResult = { name: seed.name, materials: 0, images: 0, routes: 0, skipped: 0 };

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

    let firstRouteId: string | undefined;
    for (const item of seed.tourRoutes ?? []) {
      const existing = this.routes.list({ text: item.name }).find(route => route.name === item.name);
      if (existing) { firstRouteId ??= existing.id; result.skipped += 1; continue; }
      const route = this.routes.save({
        name: item.name, tags: item.tags, summary: item.summary, status: 'enabled',
        dayPlans: item.days.map(day => ({ day: day.day, city: day.city, plan: day.plan, hotelId: day.hotel ? ids.get(day.hotel) : undefined, spotIds: (day.spots ?? []).map(key => ids.get(key)).filter((id): id is string => Boolean(id)) })),
      });
      firstRouteId ??= route.id;
      result.routes += 1;
    }

    // 测试团：发到自己的“文件传输助手”，明天出发，今天傍晚就会收到出发前一天的一组
    if (testTour && firstRouteId) {
      const startDate = addDays(localDateText(new Date()), 1);
      const self = this.groups.list().find(group => group.name === SELF_CHAT_NAME);
      if (self?.tour && (self.phase === 'upcoming' || self.phase === 'ongoing') && self.tour.state !== 'cancelled') {
        result.tour = { groupName: self.name, startDate: self.tour.startDate };
      } else if (self) {
        const updated = this.groups.update({ id: self.id, enabled: true, tour: { routeId: firstRouteId, startDate }, state: 'normal' });
        result.tour = { groupName: updated.name, startDate };
      } else {
        const added = this.groups.add({ name: SELF_CHAT_NAME, tour: { routeId: firstRouteId, startDate, note: '示例测试团，只发到自己的文件传输助手' } });
        result.tour = { groupName: added.name, startDate };
      }
    }

    this.logs.write({ module: 'System', action: '导入示例数据', status: 'ok', message: `${seed.name}：新增素材 ${result.materials} 条、图片 ${result.images} 张、路线 ${result.routes} 条，跳过已存在 ${result.skipped} 项${result.tour ? `；测试团“${result.tour.groupName}”${result.tour.startDate}出发` : ''}` });
    return result;
  }
}
