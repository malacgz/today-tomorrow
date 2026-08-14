/**
 * 「今天和明天」服务器 — Render 部署版
 * ============================================================
 * 功能：
 *   1. 任务数据同步（GET/POST/DELETE /api/tasks）
 *   2. 推送通知（Web Push + VAPID）
 *   3. 定时推送（cron）
 *
 * 环境变量（在 Render Dashboard 中设置）：
 *   VAPID_PUBLIC_KEY  — VAPID 公钥（不设则用默认值）
 *   VAPID_PRIVATE_KEY — VAPID 私钥（不设则用默认值）
 *
 * 注意：Render 免费版会在15分钟无活动后休眠。
 *   建议用 UptimeRobot 每10分钟 ping /health 保活。
 *   休眠后数据会丢失，客户端会在下次连接时自动重新同步。
 * ============================================================
 */

const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// 数据持久化（文件存储）
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');

function loadTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); }
  catch { return []; }
}
function saveTasks(tasks) {
  try { fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2)); } catch (e) { console.error('[存储] 保存任务失败:', e.message); }
}
function loadSubscriptions() {
  try { return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); }
  catch { return []; }
}
function saveSubscriptions(subs) {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2)); } catch (e) { console.error('[存储] 保存订阅失败:', e.message); }
}

// ---------------------------------------------------------------------------
// VAPID 密钥
// ---------------------------------------------------------------------------
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@today-tomorrow.app';
const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY || 'BMx0MQ6gxHeRaTIQOsVKhmbNHkWdjx1y1skUv0wF-Ru0W12gaK8EFg2ty5bWMi1utVpKqsScyCqSWiPSkCpuBo4',
  privateKey: process.env.VAPID_PRIVATE_KEY || 'Y2Eo0DNRDEynedIRz-thGTZHOYl5ETaqXI2lW2i0o88'
};
webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);

// ---------------------------------------------------------------------------
// 中间件
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '10mb' }));

// CORS — 允许 GitHub Pages 跨域访问
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// 请求日志
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ===========================================================================
// 任务数据同步接口
// ===========================================================================

// 获取所有任务
app.get('/api/tasks', (req, res) => {
  const tasks = loadTasks().filter(t => !t.deleted);
  res.json(tasks);
});

// 新增/更新任务（upsert）
app.post('/api/tasks', (req, res) => {
  const task = req.body;
  if (!task || !task.id) return res.status(400).json({ error: '任务必须包含 id 字段' });

  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === task.id);

  if (idx >= 0) {
    // 合并：如果传入的 updated_at 更新则覆盖
    const existing = tasks[idx];
    if (!task.updated_at || !existing.updated_at || task.updated_at >= existing.updated_at) {
      tasks[idx] = { ...existing, ...task, updated_at: task.updated_at || Date.now() };
    }
  } else {
    tasks.push({ ...task, updated_at: task.updated_at || Date.now() });
  }

  saveTasks(tasks);
  res.json({ success: true, task: tasks.find(t => t.id === task.id) });
});

// 批量同步（客户端推送所有本地任务）
app.post('/api/tasks/batch', (req, res) => {
  const incomingTasks = req.body;
  if (!Array.isArray(incomingTasks)) return res.status(400).json({ error: '需要任务数组' });

  const tasks = loadTasks();
  let updated = 0;

  for (const task of incomingTasks) {
    if (!task.id) continue;
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) {
      if (!task.updated_at || !tasks[idx].updated_at || task.updated_at >= tasks[idx].updated_at) {
        tasks[idx] = { ...tasks[idx], ...task };
        updated++;
      }
    } else {
      tasks.push(task);
      updated++;
    }
  }

  saveTasks(tasks);
  res.json({ success: true, updated, total: tasks.length });
});

// 删除任务（软删除）
app.delete('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === id);

  if (idx >= 0) {
    tasks[idx].deleted = true;
    tasks[idx].updated_at = Date.now();
    saveTasks(tasks);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '任务不存在' });
  }
});

// ===========================================================================
// 推送通知接口
// ===========================================================================

// 获取 VAPID 公钥
app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// 订阅推送
app.post('/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: '无效的订阅对象' });
  }

  const subs = loadSubscriptions();
  const idx = subs.findIndex(s => s.endpoint === subscription.endpoint);
  if (idx >= 0) subs[idx] = subscription;
  else subs.push(subscription);

  saveSubscriptions(subs);
  console.log(`[订阅] 当前订阅者: ${subs.length}`);
  res.json({ success: true });
});

// 手动触发测试推送
app.get('/trigger', async (req, res) => {
  const type = req.query.type;
  let title = '今天和明天 · 测试推送', body = '推送功能正常工作！';

  if (type === 'morning') {
    title = '今天和明天'; body = '新的一天开始了，今天有任务等着你完成';
  } else if (type === 'night') {
    title = '今天和明天'; body = '该规划明天的任务了，花5分钟安排好明天';
  } else if (type === 'friday') {
    title = '今天和明天'; body = '周五了，花15分钟总结本周、规划下周';
  }

  const count = await sendPushNotification(title, body);
  res.json({ success: true, message: `${title} - ${body}`, subscribers: count });
});

// ===========================================================================
// 发送推送通知
// ===========================================================================
async function sendPushNotification(title, body) {
  const subscriptions = loadSubscriptions();
  if (subscriptions.length === 0) {
    console.log('[推送] 当前没有订阅者');
    return 0;
  }

  const payload = JSON.stringify({
    title, body,
    icon: 'icon.svg',
    badge: 'icon.svg',
    tag: 'today-tomorrow',
    data: { url: '/' }
  });

  console.log(`[推送] 向 ${subscriptions.length} 个订阅者发送: ${title} - ${body}`);

  const results = await Promise.allSettled(
    subscriptions.map(sub =>
      webpush.sendNotification(sub, payload)
        .then(() => { console.log(`[推送] 成功: ${sub.endpoint.slice(0, 50)}...`); return true; })
        .catch(err => {
          console.error(`[推送] 失败: ${err.statusCode} ${err.message}`);
          if (err.statusCode === 410 || err.statusCode === 404) removeSubscription(sub.endpoint);
          return false;
        })
    )
  );

  const success = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(`[推送] 完成: ${success}/${subscriptions.length} 成功`);
  return subscriptions.length;
}

function removeSubscription(endpoint) {
  const subs = loadSubscriptions();
  const filtered = subs.filter(s => s.endpoint !== endpoint);
  if (filtered.length !== subs.length) saveSubscriptions(filtered);
}

// ===========================================================================
// 定时推送（时区 Asia/Shanghai）
// ===========================================================================

// 每周五 16:00 — 规划下周提醒
cron.schedule('0 16 * * 5', () => {
  console.log('\n===== 定时任务 周五 16:00 (北京时间) =====');
  sendPushNotification('今天和明天 · 周五规划提醒', '本周即将结束，花10分钟规划下周计划吧');
}, { timezone: 'Asia/Shanghai' });

// ===========================================================================
// 健康检查 & 根路径
// ===========================================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'today-tomorrow',
    uptime: process.uptime(),
    tasks: loadTasks().filter(t => !t.deleted).length,
    subscribers: loadSubscriptions().length,
    vapidConfigured: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
  });
});

app.get('/', (req, res) => {
  res.json({
    name: '今天和明天 · 服务器',
    endpoints: {
      'GET /api/tasks': '获取所有任务',
      'POST /api/tasks': '新增/更新任务',
      'POST /api/tasks/batch': '批量同步任务',
      'DELETE /api/tasks/:id': '删除任务',
      'GET /vapid-public-key': '获取 VAPID 公钥',
      'POST /subscribe': '订阅推送通知',
      'GET /trigger?type=morning|night|friday': '手动触发推送',
      'GET /health': '健康检查'
    },
    scheduledPushes: ['每周五 16:00 规划下周提醒']
  });
});

// ===========================================================================
// 启动
// ===========================================================================
app.listen(PORT, () => {
  console.log('================================================================');
  console.log('  「今天和明天」服务器已启动');
  console.log('================================================================');
  console.log(`  端口: ${PORT}`);
  console.log(`  VAPID 公钥: ${vapidKeys.publicKey}`);
  console.log(`  任务数: ${loadTasks().filter(t => !t.deleted).length}`);
  console.log(`  订阅数: ${loadSubscriptions().length}`);
  console.log('----------------------------------------------------------------');
  console.log('  定时推送 (Asia/Shanghai):');
  console.log('    · 每天 22:00 — 该规划明天的任务了');
  console.log('    · 每天 10:00 — 新的一天开始了');
  console.log('    · 每周五 16:00 — 周总结与下周规划');
  console.log('================================================================');
});
