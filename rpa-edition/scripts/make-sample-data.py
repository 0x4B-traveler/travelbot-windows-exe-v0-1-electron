#!/usr/bin/env python3
"""生成云南示例数据：sample-data/yunnan/seed.json 和 images/*.jpg。

图片都是程序画的示意图（攻略图、路线图、景点卡片），不含任何网络图片。
用法：python3 scripts/make-sample-data.py（需要 Pillow 和一套中文字体）。
"""
import json
import math
import os
import random
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'sample-data', 'yunnan')
IMAGES = os.path.join(ROOT, 'images')
FONT_PATHS = [
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/usr/share/fonts/wenquanyi/wqy-zenhei/wqy-zenhei.ttc',
    'C:/Windows/Fonts/msyh.ttc',
]
FONT = next(path for path in FONT_PATHS if os.path.exists(path))
TAG = '示例数据'
SLUG = {'昆明': 'kunming', '大理': 'dali', '丽江': 'lijiang', '香格里拉': 'shangrila', '西双版纳': 'banna', '腾冲': 'tengchong'}

# 城市：主题色、天气查询用的城市名、攻略要点
CITIES = {
    '昆明': {'weather': '昆明', 'colors': ((46, 134, 193), (133, 193, 233)),
           'season': '四季如春，全年适合出行；冬季早晚温差大，带件外套。',
           'traffic': '长水机场到市区约 40 分钟，地铁 6 号线直达；去石林可坐高铁到石林西站。',
           'food': '过桥米线、汽锅鸡、鲜花饼、野生菌火锅（菌子一定要煮熟）。'},
    '大理': {'weather': '大理', 'colors': ((31, 97, 141), (93, 173, 226)),
           'season': '3—5 月和 9—11 月最舒服；紫外线强，注意防晒。',
           'traffic': '昆明到大理动车约 2 小时；环洱海建议包车或租电动车。',
           'food': '酸辣鱼、乳扇、饵块、喜洲粑粑、雕梅。'},
    '丽江': {'weather': '丽江', 'colors': ((20, 90, 50), (82, 190, 128)),
           'season': '玉龙雪山常年低温，上山带羽绒服；高原反应注意别剧烈运动。',
           'traffic': '大理到丽江动车约 1.5 小时；玉龙雪山需提前在官方渠道预约索道。',
           'food': '腊排骨火锅、鸡豆凉粉、丽江粑粑、纳西烤鱼。'},
    '香格里拉': {'weather': '香格里拉', 'colors': ((110, 44, 0), (220, 118, 51)),
             'season': '海拔约 3300 米，早晚冷；6—9 月花海最好看，冬季可看雪景。',
             'traffic': '丽江到香格里拉自驾或大巴约 3.5 小时；景点之间建议包车。',
             'food': '牦牛火锅、酥油茶、青稞饼、藏式烤肉。'},
    '西双版纳': {'weather': '景洪', 'colors': ((14, 98, 81), (72, 201, 176)),
             'season': '11 月—次年 4 月干季最适合；夏季多雨闷热，备好驱蚊。',
             'traffic': '嘎洒机场离告庄约 15 分钟；野象谷和植物园可坐动车或包车。',
             'food': '傣味烧烤、菠萝饭、柠檬撒撇、手抓饭。'},
    '腾冲': {'weather': '腾冲', 'colors': ((120, 40, 31), (236, 112, 99)),
           'season': '秋冬银杏季（11 月中下旬）最热门；全年都适合泡温泉。',
           'traffic': '驼峰机场离市区约 20 分钟；和顺古镇和热海之间打车约 30 分钟。',
           'food': '大救驾（炒饵块）、稀豆粉、土锅子、松花糕。'},
}

# 素材：key、类型、名称、城市、标签、简介
MATERIALS = [
    ('km-dianchi', 'spot', '滇池海埂大坝', '昆明', ['湖景', '观鸟'], '冬季可以近距离看红嘴鸥，傍晚看滇池日落。建议游玩 2 小时。'),
    ('km-shilin', 'spot', '石林风景区', '昆明', ['5A', '世界遗产'], '喀斯特地貌奇观，大小石林步行约 3 小时，记得穿舒适的鞋。'),
    ('km-cuihu', 'spot', '翠湖公园', '昆明', ['城市漫步'], '市中心的湖景公园，周边有云南大学和陆军讲武堂，适合半天慢逛。'),
    ('km-mixian', 'restaurant', '建新园过桥米线', '昆明', ['老字号', '美食'], '昆明老字号米线店，人均 30 元左右，早餐时段人多。'),
    ('dl-gucheng', 'spot', '大理古城', '大理', ['古城', '夜景'], '人民路和洋人街最热闹，晚上逛更有氛围，适合拍照和买手作。'),
    ('dl-erhai', 'spot', '洱海生态廊道', '大理', ['湖景', '骑行'], '沿洱海西岸骑行或步行，海舌公园、龙龛码头适合看日出。'),
    ('dl-xizhou', 'spot', '喜洲古镇', '大理', ['古镇', '稻田'], '白族民居和稻田，夏季稻田最出片，必吃喜洲粑粑。'),
    ('dl-santa', 'spot', '崇圣寺三塔', '大理', ['5A', '人文'], '大理地标，建议上午去，顺光拍三塔倒影。'),
    ('dl-fish', 'restaurant', '洱海酸辣鱼', '大理', ['美食'], '白族特色酸辣鱼，人均 70 元左右，古城和双廊都有。'),
    ('dl-hotel', 'hotel', '双廊海景民宿', '大理', ['海景', '民宿'], '推开窗就是洱海，旺季提前一周预订，参考价 400—800 元/晚。'),
    ('lj-gucheng', 'spot', '丽江古城', '丽江', ['古城', '世界遗产'], '四方街、木府、大水车，清晨人少适合拍照，晚上看古城夜景。'),
    ('lj-yulong', 'spot', '玉龙雪山', '丽江', ['5A', '雪山'], '冰川公园大索道需提前预约，山顶海拔 4680 米，带上氧气瓶和羽绒服。'),
    ('lj-lanyue', 'spot', '蓝月谷', '丽江', ['湖景'], '雪山脚下的蓝色湖泊，晴天颜色最好看，和玉龙雪山同一天游览。'),
    ('lj-shuhe', 'spot', '束河古镇', '丽江', ['古镇'], '比大研古城安静，适合慢慢逛和喝咖啡。'),
    ('lj-hotpot', 'restaurant', '纳西腊排骨火锅', '丽江', ['美食'], '丽江招牌美食，人均 60 元左右，可以加一份鸡豆凉粉。'),
    ('xgll-pudacuo', 'spot', '普达措国家公园', '香格里拉', ['5A', '高原湖泊'], '属都湖和碧塔海，栈道徒步约 3 小时，注意保暖、慢走防高反。'),
    ('xgll-songzanlin', 'spot', '松赞林寺', '香格里拉', ['人文', '藏传佛教'], '被称为“小布达拉宫”，参观时顺时针绕行，尊重寺院礼仪。'),
    ('xgll-dukezong', 'spot', '独克宗古城', '香格里拉', ['古城'], '世界最大转经筒所在地，晚上广场有锅庄舞可以一起跳。'),
    ('bn-gaozhuang', 'spot', '告庄西双景', '西双版纳', ['夜市', '夜景'], '星光夜市和大金塔，晚上 7 点后最热闹，可以换傣装拍照。'),
    ('bn-yexianggu', 'spot', '野象谷', '西双版纳', ['雨林', '亲子'], '有机会看到野生亚洲象，高空栈道走一圈约 2 小时。'),
    ('bn-zhiwuyuan', 'spot', '中科院西双版纳热带植物园', '西双版纳', ['雨林', '科普'], '国内最大的热带植物园之一，园区大，建议坐电瓶车。'),
    ('bn-food', 'restaurant', '傣味烧烤', '西双版纳', ['美食'], '香茅草烤鱼、包烧、菠萝饭，人均 60 元左右。'),
    ('tc-heshun', 'spot', '和顺古镇', '腾冲', ['古镇', '人文'], '保存完好的侨乡古镇，和顺图书馆和洗衣亭值得一看。'),
    ('tc-rehai', 'spot', '热海景区', '腾冲', ['温泉', '地热'], '大滚锅和地热奇观，景区里可以泡温泉、吃温泉煮鸡蛋。'),
    ('tc-yinxing', 'spot', '银杏村', '腾冲', ['银杏', '秋季限定'], '11 月中下旬满村金黄，其余季节是安静的田园村落。'),
]

# 路线：key、名称、出发城市、天数、标签、简介、天气城市、行程（第几天、时间、标题、关联素材、备注）
ROUTES = [
    ('r-kunming', '昆明石林2日游', '昆明', 2, ['周末', '轻松'], '春城慢游加世界遗产石林，适合周末短途。', '昆明', [
        (1, '09:00', '集合出发', '__map__', '集合出发，导游讲解行程'),
        (1, '09:30', '翠湖公园', 'km-cuihu', ''),
        (1, '12:00', '过桥米线午餐', 'km-mixian', ''),
        (1, '15:30', '滇池海埂大坝', 'km-dianchi', '傍晚看日落'),
        (2, '08:30', '石林风景区', 'km-shilin', '全天游览，含电瓶车'),
        (2, '17:00', '返回昆明市区', '', '散团'),
    ]),
    ('r-dali', '大理洱海3日休闲游', '大理', 3, ['休闲', '拍照'], '环洱海骑行、古城夜游、喜洲稻田，一次玩遍大理精华。', '大理', [
        (1, '10:00', '集合出发', '__map__', '大理站接站，入住民宿'),
        (1, '14:00', '崇圣寺三塔', 'dl-santa', ''),
        (1, '19:00', '大理古城夜游', 'dl-gucheng', ''),
        (2, '07:00', '洱海日出', 'dl-erhai', '龙龛码头看日出'),
        (2, '12:00', '酸辣鱼午餐', 'dl-fish', ''),
        (2, '15:00', '双廊海景民宿', 'dl-hotel', '下午茶看洱海'),
        (3, '09:00', '喜洲古镇', 'dl-xizhou', '稻田骑行'),
        (3, '15:00', '返程', '', '送站'),
    ]),
    ('r-dali-lijiang', '大理丽江4日经典游', '大理', 4, ['经典', '雪山'], '洱海 + 玉龙雪山 + 两座古城，第一次来云南的首选。', '丽江', [
        (1, '10:00', '集合出发', '__map__', '大理接站'),
        (1, '14:00', '大理古城', 'dl-gucheng', ''),
        (2, '08:00', '洱海生态廊道', 'dl-erhai', ''),
        (2, '16:00', '动车前往丽江', '', '约 1.5 小时'),
        (3, '07:30', '玉龙雪山', 'lj-yulong', '大索道需提前预约'),
        (3, '13:30', '蓝月谷', 'lj-lanyue', ''),
        (3, '18:30', '腊排骨火锅晚餐', 'lj-hotpot', ''),
        (4, '09:00', '丽江古城', 'lj-gucheng', ''),
        (4, '14:00', '束河古镇', 'lj-shuhe', '自由活动后送机'),
    ]),
    ('r-shangrila', '丽江香格里拉5日深度游', '香格里拉', 5, ['高原', '深度'], '从纳西古城到藏地秘境，慢节奏适应海拔。', '香格里拉', [
        (1, '10:00', '集合出发', '__map__', '丽江接机'),
        (1, '15:00', '丽江古城', 'lj-gucheng', ''),
        (2, '07:30', '玉龙雪山', 'lj-yulong', ''),
        (2, '13:30', '蓝月谷', 'lj-lanyue', ''),
        (3, '08:00', '前往香格里拉', '', '车程约 3.5 小时，途经虎跳峡'),
        (3, '19:00', '独克宗古城', 'xgll-dukezong', '晚上跳锅庄'),
        (4, '09:00', '普达措国家公园', 'xgll-pudacuo', ''),
        (5, '09:00', '松赞林寺', 'xgll-songzanlin', ''),
        (5, '14:00', '返程', '', '送机'),
    ]),
    ('r-banna', '西双版纳3日热带雨林游', '西双版纳', 3, ['亲子', '雨林'], '看野象、逛植物园、夜游告庄，冬天也能穿短袖。', '景洪', [
        (1, '11:00', '集合出发', '__map__', '景洪接机'),
        (1, '19:00', '告庄西双景夜市', 'bn-gaozhuang', ''),
        (2, '08:30', '野象谷', 'bn-yexianggu', ''),
        (2, '18:30', '傣味烧烤晚餐', 'bn-food', ''),
        (3, '09:00', '热带植物园', 'bn-zhiwuyuan', ''),
        (3, '16:00', '返程', '', '送机'),
    ]),
    ('r-tengchong', '腾冲和顺温泉2日游', '腾冲', 2, ['温泉', '秋季'], '侨乡古镇 + 地热温泉，秋天还能看满村银杏。', '腾冲', [
        (1, '10:00', '集合出发', '__map__', '腾冲接机'),
        (1, '14:00', '和顺古镇', 'tc-heshun', ''),
        (1, '19:00', '热海泡温泉', 'tc-rehai', ''),
        (2, '09:00', '银杏村', 'tc-yinxing', ''),
        (2, '15:00', '返程', '', '送机'),
    ]),
]


def font(size):
    return ImageFont.truetype(FONT, size)


def gradient(width, height, top, bottom):
    image = Image.new('RGB', (width, height), top)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        ratio = y / max(1, height - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        draw.line([(0, y), (width, y)], fill=color)
    return image


def mountains(draw, width, base, seed, color, peak=220):
    rng = random.Random(seed)
    points = [(0, base)]
    x = 0
    while x < width:
        x += rng.randint(80, 180)
        points.append((x, base - rng.randint(peak // 4, peak)))
        x += rng.randint(60, 140)
        points.append((x, base - rng.randint(0, 60)))
    points += [(width, base), (width, base + 2000), (0, base + 2000)]
    draw.polygon(points, fill=color)


def wrap(draw, text, size, width):
    lines, line = [], ''
    for char in text:
        if draw.textlength(line + char, font=font(size)) > width and char not in '，。；、：）！？”':
            lines.append(line)
            line = char
        else:
            line += char
    if line:
        lines.append(line)
    return lines


def paragraph(draw, xy, text, size, width, fill, spacing=1.45):
    x, y = xy
    for line in wrap(draw, text, size, width):
        draw.text((x, y), line, font=font(size), fill=fill)
        y += int(size * spacing)
    return y


def footer(draw, width, height):
    draw.text((60, height - 70), f'{TAG} · 示意图，非实景照片', font=font(26), fill=(255, 255, 255))


def spot_card(key, title, city, body, kind):
    width, height = 1080, 810
    top, bottom = CITIES[city]['colors']
    image = gradient(width, height, bottom, top)
    draw = ImageDraw.Draw(image)
    rng = random.Random(key)
    draw.ellipse([width - 300, 80, width - 140, 240], fill=(255, 236, 179))
    mountains(draw, width, 560, key, tuple(max(0, c - 40) for c in top))
    mountains(draw, width, 640, key + 'b', tuple(max(0, c - 70) for c in top))
    if '湖' in body or '海' in title:
        draw.rectangle([0, 640, width, height], fill=(133, 193, 233))
        for _ in range(12):
            y = rng.randint(660, height - 40)
            x = rng.randint(0, width - 200)
            draw.line([(x, y), (x + rng.randint(60, 180), y)], fill=(214, 234, 248), width=4)
    draw.rounded_rectangle([40, 40, 40 + 220, 100], radius=28, fill=(255, 255, 255))
    draw.text((62, 50), f'{city} · {kind}', font=font(30), fill=top)
    draw.text((60, 130), title, font=font(72), fill=(255, 255, 255))
    paragraph(draw, (62, 240), body, 34, 760, (255, 255, 255))
    footer(draw, width, height)
    return image


def guide_card(city):
    info = CITIES[city]
    width, height = 1080, 1440
    top, bottom = info['colors']
    image = gradient(width, height, top, bottom)
    draw = ImageDraw.Draw(image)
    mountains(draw, width, 340, city, tuple(min(255, c + 30) for c in bottom), peak=90)
    draw.text((60, 70), f'{city}旅行攻略', font=font(86), fill=(255, 255, 255))
    draw.text((64, 185), '一图看懂 · 收藏备用', font=font(36), fill=(255, 255, 255))
    spots = [m for m in MATERIALS if m[3] == city and m[1] == 'spot']
    y = 380
    sections = [
        ('必去景点', '、'.join(m[2] for m in spots)),
        ('什么时候去', info['season']),
        ('交通', info['traffic']),
        ('必吃美食', info['food']),
    ]
    for heading, text in sections:
        box_top = y
        lines = wrap(draw, text, 36, width - 200)
        box_bottom = box_top + 90 + len(lines) * 52 + 20
        draw.rounded_rectangle([50, box_top, width - 50, box_bottom], radius=28, fill=(255, 255, 255))
        draw.rounded_rectangle([80, box_top + 26, 92, box_top + 70], radius=6, fill=top)
        draw.text((110, box_top + 22), heading, font=font(42), fill=top)
        paragraph(draw, (110, box_top + 90), text, 36, width - 200, (60, 60, 60))
        y = box_bottom + 30
    footer(draw, width, height)
    return image


def route_map(route):
    key, name, city, days, _tags, summary, _weather, items = route
    width, height = 1080, 1440
    top, bottom = CITIES[city]['colors']
    image = gradient(width, height, (250, 248, 240), (235, 230, 215))
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, width, 230], fill=top)
    draw.text((60, 50), name, font=font(68), fill=(255, 255, 255))
    draw.text((64, 145), summary, font=font(32), fill=(255, 255, 255))
    stops = [item for item in items if item[2] != '集合出发']
    per_row = 4
    rows = math.ceil(len(stops) / per_row)
    map_top, row_gap = 300, 170
    map_bottom = map_top + 60 + rows * row_gap
    column_width = (width - 160) / per_row
    points = []
    for index, _ in enumerate(stops):
        row, column = divmod(index, per_row)
        if row % 2 == 1:
            column = per_row - 1 - column
        points.append((80 + column_width * (column + 0.5), map_top + 70 + row * row_gap))
    draw.rounded_rectangle([40, map_top - 20, width - 40, map_bottom], radius=30, fill=(255, 255, 255), outline=bottom, width=3)
    for i in range(len(points) - 1):
        draw.line([points[i], points[i + 1]], fill=bottom, width=10)
    palette = [top, (230, 126, 34), (142, 68, 173), (39, 174, 96), (192, 57, 43)]
    for index, (point, stop) in enumerate(zip(points, stops)):
        color = palette[(stop[0] - 1) % len(palette)]
        x, y = point
        draw.ellipse([x - 28, y - 28, x + 28, y + 28], fill=color, outline=(255, 255, 255), width=5)
        draw.text((x, y), str(index + 1), font=font(28), fill=(255, 255, 255), anchor='mm')
        label_y = y + 42
        for line in wrap(draw, stop[2], 26, column_width - 20)[:2]:
            left, top_, right, bottom_ = draw.textbbox((x, label_y), line, font=font(26), anchor='ma')
            draw.rectangle([left - 6, top_ - 4, right + 6, bottom_ + 4], fill=(255, 255, 255))
            draw.text((x, label_y), line, font=font(26), fill=(60, 60, 60), anchor='ma')
            label_y += 34
    y = map_bottom + 40
    for day in range(1, days + 1):
        color = palette[(day - 1) % len(palette)]
        draw.rounded_rectangle([60, y, 200, y + 52], radius=26, fill=color)
        draw.text((130, y + 26), f'第{day}天', font=font(30), fill=(255, 255, 255), anchor='mm')
        line = ' → '.join(f'{item[1]} {item[2]}' for item in items if item[0] == day and item[2] != '集合出发')
        y = paragraph(draw, (220, y + 6), line, 30, width - 290, (60, 60, 60), 1.4) + 24
    draw.text((60, height - 70), f'{TAG} · 示意图，非实景照片', font=font(26), fill=(120, 120, 120))
    return image


def save(image, name):
    image.save(os.path.join(IMAGES, name), 'JPEG', quality=82, optimize=True)
    return f'images/{name}'


def main():
    os.makedirs(IMAGES, exist_ok=True)
    for old in os.listdir(IMAGES):
        os.remove(os.path.join(IMAGES, old))
    kind_label = {'spot': '景点', 'restaurant': '餐厅', 'hotel': '酒店'}
    materials = []
    for city in CITIES:
        materials.append({'key': f'guide-{city}', 'kind': 'guide', 'title': f'{city}旅行攻略', 'city': city, 'tags': ['攻略', TAG],
                          'body': f"{CITIES[city]['season']}{CITIES[city]['traffic']}必吃：{CITIES[city]['food']}",
                          'images': [save(guide_card(city), f'guide-{SLUG[city]}.jpg')]})
    for key, kind, title, city, tags, body in MATERIALS:
        materials.append({'key': key, 'kind': kind, 'title': title, 'city': city, 'tags': tags + [TAG], 'body': body,
                          'images': [save(spot_card(key, title, city, body, kind_label[kind]), f'{key}.jpg')]})
    routes = []
    for route in ROUTES:
        key, name, city, days, tags, summary, weather, items = route
        map_key = f'{key}-map'
        materials.append({'key': map_key, 'kind': 'route', 'title': f'{name}路线图', 'city': city, 'tags': ['路线图', TAG],
                          'body': summary, 'images': [save(route_map(route), f'{map_key}.jpg'), f'images/guide-{SLUG[city]}.jpg']})
        route_items = []
        for day, time, title, material, note in items:
            linked = map_key if material == '__map__' else material
            route_items.append({'day': day, 'time': time, 'title': title, 'material': linked, 'note': note})
        routes.append({'key': key, 'name': name, 'city': city, 'days': days, 'tags': tags, 'summary': summary,
                       'weatherCity': weather, 'items': route_items})
    seed = {'name': '云南示例数据', 'tag': TAG, 'materials': materials, 'routes': routes}
    with open(os.path.join(ROOT, 'seed.json'), 'w', encoding='utf-8') as handle:
        json.dump(seed, handle, ensure_ascii=False, indent=2)
    print(f'{len(materials)} materials, {len(routes)} routes, {len(os.listdir(IMAGES))} images')


if __name__ == '__main__':
    main()
