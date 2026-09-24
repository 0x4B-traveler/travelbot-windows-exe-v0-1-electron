import type { ContentKind, NaturalLanguageCommand } from '../../src/domain/business';

const kindMap: Array<[ContentKind, RegExp]> = [
  ['route', /路线|行程|游玩计划/],
  ['spot', /景点|景区/],
  ['restaurant', /餐厅|餐馆|吃饭|美食/],
  ['hotel', /酒店|住宿|民宿/],
  ['guide', /攻略|游记|指南/],
];

export function parseNaturalLanguage(input: string): NaturalLanguageCommand {
  const text = input.trim();
  if (!text) return { intent: 'unknown', reason: '消息内容为空' };
  const search = text.match(/^(查询|搜索|查找|找一下|看看)(.*)$/);
  if (search) return { intent: 'search', query: search[2].trim() || '全部内容' };

  const create = text.match(/^(新增|添加|记录|创建)(.*)$/);
  if (create) {
    const rest = create[2].trim();
    const kind = kindMap.find(([, pattern]) => pattern.test(rest))?.[0] ?? 'guide';
    const title = rest.replace(/^(一条|一个|一份)/, '').replace(/路线|攻略|景点|景区|餐厅|餐馆|酒店|住宿|民宿/g, '').trim() || '未命名内容';
    return { intent: 'create', kind, title, body: rest, requiresConfirmation: true };
  }

  const remove = text.match(/^(删除|移除|删掉)(.*)$/);
  if (remove) return { intent: 'delete', query: remove[2].trim(), requiresConfirmation: true };

  const update = text.match(/^(修改|更新|补充|把)(.*)$/);
  if (update) return { intent: 'update', query: update[2].trim(), body: text, requiresConfirmation: true };

  return { intent: 'unknown', reason: '暂时只支持查询、新增、修改和删除攻略内容' };
}
