import type { ContentChannel, Material, Route } from '../../src/domain/ops';
import { MATERIAL_KIND_LABELS } from '../../src/domain/ops';
import type { ContentGenerator, GeneratedContent } from '../application/ports';

// 没有配置大模型时使用的文案生成器：按路线 + 关联素材套用几种固定写法。
// 以后接入大模型时，实现同一个 ContentGenerator 接口替换即可。

const OPENINGS = [
  (route: Route) => `📢 周末不知道去哪玩？${route.city ? `${route.city}出发，` : ''}${route.name}安排上！`,
  (route: Route) => `✨ 为大家推荐一条好玩又省心的路线：${route.name}`,
  (route: Route) => `🌿 想换个地方放松一下？这条${route.days}天的${route.name}很适合你`,
];
const CLOSINGS = [
  '名额有限，想报名或了解详情的朋友直接在群里联系我～',
  '有兴趣的小伙伴可以私信我，帮你安排得明明白白！',
  '感兴趣的话回复“报名”，我们一对一给你详细介绍。',
];

export class TemplateContentGenerator implements ContentGenerator {
  readonly source = 'template' as const;

  async generate({ route, materials, channel, variant }: { route: Route; materials: Material[]; channel: ContentChannel; variant: number }): Promise<GeneratedContent> {
    const pick = <T,>(list: T[]) => list[Math.abs(variant) % list.length];
    const byId = new Map(materials.map(material => [material.id, material]));
    const tags = route.tags.length ? route.tags.map(tag => `#${tag}`).join(' ') : '';
    const highlights = materials.filter(material => material.kind === 'spot' || material.kind === 'restaurant' || material.kind === 'hotel').slice(0, 4);
    const dayLines = Array.from({ length: route.days }, (_, index) => index + 1).map(day => {
      const items = route.items.filter(item => item.day === day);
      if (!items.length) return '';
      return `Day ${day}：${items.map(item => `${item.time ? `${item.time} ` : ''}${item.title}`).join(' → ')}`;
    }).filter(Boolean);
    const highlightLines = highlights.map(material => `· ${material.title}（${MATERIAL_KIND_LABELS[material.kind]}）${firstSentence(material.body)}`);

    if (channel === '小红书') {
      const body = [
        `${route.name}｜${route.days}天玩法攻略${tags ? `\n${tags}` : ''}`,
        '',
        route.summary || `${route.city}${route.days}天，节奏刚好不累。`,
        '',
        '🗓 行程安排',
        ...dayLines,
        ...(highlightLines.length ? ['', '📍 必去打卡', ...highlightLines] : []),
        '',
        '💡 小贴士：提前预约热门景点，穿舒适的鞋，注意天气变化。',
      ].join('\n');
      return { title: `${route.name}｜小红书笔记`, body };
    }

    if (channel === '攻略') {
      const detail = Array.from({ length: route.days }, (_, index) => index + 1).flatMap(day => {
        const items = route.items.filter(item => item.day === day);
        if (!items.length) return [];
        return [`【第 ${day} 天】`, ...items.map(item => {
          const material = item.materialId ? byId.get(item.materialId) : undefined;
          const extra = item.note || (material ? firstSentence(material.body) : '');
          return `${item.time ? `${item.time} ` : ''}${item.title}${extra ? `：${extra}` : ''}`;
        }), ''];
      });
      return { title: `${route.name}攻略`, body: [`${route.name}（${route.city} · ${route.days}天）`, route.summary, '', ...detail].filter((line, index, all) => line || all[index - 1]).join('\n').trim() };
    }

    if (channel === '通知') {
      const body = [
        `【出行通知】${route.name}`,
        '',
        ...dayLines,
        '',
        '请各位团友提前 10 分钟到达集合地点，带好身份证件和随身物品。如有问题请随时在群里联系。',
      ].join('\n');
      return { title: `${route.name}出行通知`, body };
    }

    const body = [
      pick(OPENINGS)(route),
      '',
      route.summary,
      ...(dayLines.length ? ['', '🗓 行程亮点', ...dayLines] : []),
      ...(highlightLines.length ? ['', ...highlightLines] : []),
      ...(tags ? ['', tags] : []),
      '',
      pick(CLOSINGS),
    ].filter((line, index, all) => line !== undefined && !(line === '' && all[index - 1] === '')).join('\n').trim();
    return { title: `${route.name}推荐`, body };
  }
}

function firstSentence(text: string): string {
  const sentence = text.trim().split(/[。！？\n]/)[0]?.trim() ?? '';
  return sentence.length > 40 ? `${sentence.slice(0, 40)}…` : sentence;
}
