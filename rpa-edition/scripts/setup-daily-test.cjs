// 一键配置“文件传输助手每天 06:00 / 10:00 / 18:00 各 10 条”的定时测试（不打开界面、不发送任何消息）。
// 先 npm run build（要用 dist-electron 里编译好的代码），并关闭旅游运营助手 RPA 版，然后：
//   set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron scripts\setup-daily-test.cjs "%APPDATA%\TravelBotRPA"
// 参数是软件的数据目录（里面有 travelbot.sqlite）。重复运行会跳过已导入的数据和已存在的任务。
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const dataDir = process.argv[2];
if (!dataDir || !existsSync(join(dataDir, 'travelbot.sqlite'))) {
  console.error(`找不到数据目录或 travelbot.sqlite：${dataDir || '（未指定）'}。请先打开一次软件再运行。`);
  process.exit(1);
}
const load = path => require(join(root, 'dist-electron', path));
const { TravelDatabase } = load('electron/services/database.js');
const repos = load('electron/infrastructure/repositories.js');
const svc = load('electron/application/services.js');
const { SampleDataService } = load('electron/application/sample-data.js');
const { LocalFileStore } = load('electron/infrastructure/file-store.js');
const { TemplateContentGenerator } = load('electron/infrastructure/template-generator.js');
const { JsonSendSettingsStore } = load('electron/infrastructure/settings-store.js');

const TARGET = '文件传输助手';
const TIMES = ['06:00', '10:00', '18:00'];
const PER_SLOT = 10;
const GAP_MINUTES = 3;

(async () => {
  const database = new TravelDatabase(join(dataDir, 'travelbot.sqlite'));
  const db = database.connection;
  repos.migrateOpsSchema(db);
  const materialRepo = new repos.MaterialRepository(db);
  const routeRepo = new repos.RouteRepository(db);
  const taskRepo = new repos.TaskRepository(db);
  const logs = new svc.LogService(new repos.LogRepository(db));
  const files = new LocalFileStore(join(dataDir, 'files'));
  const materials = new svc.MaterialService(materialRepo, routeRepo, files, { pickImages: async () => [] });
  const routes = new svc.RouteService(routeRepo, materialRepo);
  const contents = new svc.ContentService(new repos.ContentRepository(db), routes, materials, new TemplateContentGenerator(), logs, id => taskRepo.byContent(id));
  const sendStore = new JsonSendSettingsStore(join(dataDir, 'send-settings.json'));
  const groups = new svc.GroupService(new repos.GroupRepository(db), logs, () => null, () => sendStore.get());
  const tasks = new svc.TaskService(taskRepo, contents, groups, null, { forecastLine: async () => '' }, logs);
  const samples = new SampleDataService(join(root, 'sample-data'), materialRepo, files, routes, contents, logs, tasks, groups);

  // 1. 发送时段从 05:50 开始，06:00 的任务才能准点发（其余防封规则内置不可改；文件传输助手不受单群每天次数限制）。
  const settings = sendStore.get();
  settings.rpa.guard = { ...settings.rpa.guard, activeStart: '05:50' };
  sendStore.save(settings);
  console.log('发送时段：', `${settings.rpa.guard.activeStart}–${settings.rpa.guard.activeEnd}`);

  // 2. 云南示例数据（已导入的跳过）。
  const loaded = await samples.load('yunnan');
  console.log(`示例数据：新增素材 ${loaded.materials}、路线 ${loaded.routes}、群文案 ${loaded.contents}，跳过 ${loaded.skipped}`);

  // 3. 群：文件传输助手。
  let group = groups.list().find(item => item.name === TARGET);
  if (!group) { groups.add([TARGET]); group = groups.list().find(item => item.name === TARGET); }
  if (!group.enabled) group = groups.update({ id: group.id, enabled: true });
  console.log(`群：${group.name}（${group.enabled ? '启用' : '停用'}）`);

  // 4. 每天任务（这个群已有进行中的每天任务就不重复建）。
  const existing = tasks.list().filter(task => task.repeat === 'daily' && task.status === 'pending' && task.groupIds.includes(group.id));
  if (existing.length) {
    console.log(`已有 ${existing.length} 个发到“${TARGET}”的每天任务，跳过创建`);
  } else {
    const result = samples.planDaily({ name: 'yunnan', groupId: group.id, times: TIMES, perSlot: PER_SLOT, gapMinutes: GAP_MINUTES });
    console.log(`已创建 ${result.tasks} 个每天任务`);
  }
  const next = tasks.list().filter(task => task.groupIds.includes(group.id) && task.status === 'pending').map(task => new Date(task.nextRunAt)).sort((a, b) => a - b)[0];
  console.log(`下一次发送：${next ? next.toLocaleString('zh-CN', { hour12: false }) : '无'}`);
  database.close();
})().catch(error => { console.error('配置失败：', error?.message || error); process.exit(1); });
