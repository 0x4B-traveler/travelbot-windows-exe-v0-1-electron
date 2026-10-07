import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MaterialKind, SampleDataResult } from '../../src/domain/ops';
import type { MaterialRepository } from '../infrastructure/repositories';
import type { FileStore } from './ports';
import { OpsError, type ContentService, type LogService, type RouteService } from './services';

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
  ) {}

  async load(name: string): Promise<SampleDataResult> {
    const dir = join(this.root, name);
    const seedFile = join(dir, 'seed.json');
    if (!/^[a-z0-9-]+$/.test(name) || !existsSync(seedFile)) throw new OpsError(`找不到示例数据“${name}”`);
    const seed = JSON.parse(readFileSync(seedFile, 'utf8')) as Seed;
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
