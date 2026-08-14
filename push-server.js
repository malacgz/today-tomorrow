/**
 * 「今天和明天」推送服务器 — Render 部署版
 * ============================================================
 * 环境变量配置（在 Render Dashboard 中设置）：
 *   VAPID_PUBLIC_KEY  — VAPID 公钥
 *   VAPID_PRIVATE_KEY — VAPID 私钥
 *   SUPABASE_URL     — Supabase 项目 URL
 *   SUPABASE_SERVICE_KEY — Supabase service_role key（用于读写 push_subscriptions 表）
 *
 * 如未设置 VAPID 环境变量，首次启动会自动生成。
 * 推送订阅存储在 Supabase 的 push_subscriptions 表中。
 * ============================================================
 */

const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ---------------------------------------------------------------------------
// VAPID 密钥管理
// ---------------------------------------------------------------------------
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@today-tomorrow.app';

function getVapidKeys() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (pub && priv) {
    console.log('[VAPID] 使用环境变量中的 VAPID 密钥');
    return { publicKey: pub, privateKey: priv };
  }
  // 没有环境变量则生成新的（注意：Render 重启后会丢失，必须设置环境变量）
  console.warn('[VAPID] 警告：未设置 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 环境变量，已临时生成。推送订阅将在重启后失效！');
  return webpush.generateVAPIDKeys();
}

const vapidKeys = getVapidKeys();
webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);

// ---------------------------------------------------------------------------
// Supabase 客户端（用于存储/读取推送订阅）
// ---------------------------------------------------------------------------
const SB_URL = process.env.SUPABASE_URL || 'https://uufbkzdbcgxmnlphggxa.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

let sbClient = null;
if (SB_KEY) {
  sbClient = createClient(SB_URL, SB_KEY);
  console.log('[Supabase] 客户端已初始化');
} else {
  console.warn('[Supabase] 未设置 SUPABASE_SERVICE_KEY，推送订阅将无法持久化');
}

// ---------------------------------------------------------------------------
// 内存中的订阅缓存（Supabase 不可用时的后备）
// ---------------------------------------------------------------------------
let subscriptionsCache = [];

async function loadSubscriptions() {
  if (sbClient) {
    try {
      const { data, error } = await sbClient
        .from('push_subscriptions')
        .select('endpoint, subscription');
      if (error) throw error;
      return (data || []).map(row => 
        typeof row.subscription === 'string' 
          ? JSON.parse(row.subscription) 
          : row.subscription
      );
    } catch (e) {
      console.error('[订阅] 从 Supabase 读取失败，使用缓存:', e.message);
    }
  }
  return subscriptionsCache;
}

async function saveSubscription(subscription) {
  const endpoint = subscription.endpoint;
  const subStr = JSON.stringify(subscription);
  
  if (sbClient) {
    try {
      const { error } = await sbClient
        .from('push_subscriptions')
        .upsert({ 
          endpoint, 
          subscription: subStr 
        });
      if (error) throw error;
      console.log('[订阅] 已保存到 Supabase:', endpoint);
    } catch (e) {
      console.error('[订阅] 保存到 Supabase 失败:', e.message);
    }
  }
  
  // 同时更新内存缓存
  const idx = subscriptionsCache.findIndex(s => s.endpoint === endpoint);
  if (idx >= 0) subscriptionsCache[idx] = subscription;
  else subscriptionsCache.push(subscription);
}

// ---------------------------------------------------------------------------
// 接口：返回 VAPID 公钥
// ---------------------------------------------------------------------------
app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// ---------------------------------------------------------------------------
// 接口：接收并存储推送订阅
// ---------------------------------------------------------------------------
app.post('/subscribe', async (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: '无效的订阅对象' });
  }
  await saveSubscription(subscription);
  res.json({ success: true, message: '订阅成功' });
});

// ---------------------------------------------------------------------------
// 接口：手动触发测试推送
// ---------------------------------------------------------------------------
app.get('/trigger', async (req, res) => {
  const type = req.query.type;
  let title = '今天和明天 · 测试推送', body = '推送功能正常工作！';
  
  if (type === 'morning') {
    title = '今天和明天';
    body = '新的一天开始了，今天有任务等着你完成';
  } else if (type === 'night') {
    title = '今天和明天';
    body = '该规划明天的任务了，花5分钟安排好明天';
  } else if (type === 'friday') {
    title = '今天和明天';
    body = '周五了，花15分钟总结本周、规划下周';
  }
  
  const count = await sendPushNotification(title, body);
  res.json({ 
    success: true, 
    message: `已触发推送：${title} - ${body}`, 
    subscribers: count 
  });
});

// ---------------------------------------------------------------------------
// 接口：查看订阅数量
// ---------------------------------------------------------------------------
app.get('/subscriptions/count', async (req, res) => {
  const subs = await loadSubscriptions();
  res.json({ count: subs.length });
});

// ---------------------------------------------------------------------------
// 健康检查（Render 需要）
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'today-tomorrow-push-server',
    timestamp: new Date().toISOString(),
    vapidConfigured: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
    supabaseConfigured: !!sbClient
  });
});

// ---------------------------------------------------------------------------
// 根路径：显示服务信息
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    name: '今天和明天 · 推送服务器',
    endpoints: {
      'GET /vapid-public-key': '获取 VAPID 公钥',
      'POST /subscribe': '订阅推送通知',
      'GET /trigger?type=morning|night|friday': '手动触发推送',
      'GET /subscriptions/count': '查看订阅数量',
      'GET /health': '健康检查'
    },
    scheduledPushes: [
      '每天 22:00 (北京时间) — 规划明天提醒',
      '每天 10:00 (北京时间) — 今日任务提醒',
      '每周五 16:00 (北京时间) — 周总结提醒'
    ]
  });
});

// ---------------------------------------------------------------------------
// 推送通知发送函数
// ---------------------------------------------------------------------------
async function sendPushNotification(title, body) {
  const subscriptions = await loadSubscriptions();
  if (subscriptions.length === 0) {
    console.log('[推送] 当前没有订阅者，跳过推送');
    return 0;
  }

  const payload = JSON.stringify({
    title: title,
    body: body,
    icon: 'icon.svg',
    badge: 'icon.svg',
    tag: 'today-tomorrow',
    data: { url: '/' }
  });

  console.log(`[推送] 准备向 ${subscriptions.length} 个订阅者发送...`);
  console.log(`[推送] 标题: ${title}`);
  console.log(`[推送] 内容: ${body}`);

  const results = await Promise.allSettled(
    subscriptions.map(subscription =>
      webpush.sendNotification(subscription, payload)
        .then(() => {
          console.log(`[推送] 发送成功: ${subscription.endpoint.slice(0, 50)}...`);
          return true;
        })
        .catch(error => {
          console.error(`[推送] 发送失败:`, error.statusCode, error.message);
          // 订阅失效则从 Supabase 删除
          if (error.statusCode === 410 || error.statusCode === 404) {
            removeSubscription(subscription.endpoint);
          }
          return false;
        })
    )
  );

  const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(`[推送] 本轮完成: ${successCount}/${subscriptions.length} 成功`);
  return subscriptions.length;
}

async function removeSubscription(endpoint) {
  if (sbClient) {
    try {
      await sbClient.from('push_subscriptions').delete().eq('endpoint', endpoint);
      console.log('[订阅] 已从 Supabase 删除失效订阅:', endpoint.slice(0, 50));
    } catch (e) {
      console.error('[订阅] 删除失败:', e.message);
    }
  }
  subscriptionsCache = subscriptionsCache.filter(s => s.endpoint !== endpoint);
}

// ---------------------------------------------------------------------------
// 定时推送任务（时区：Asia/Shanghai）
// ---------------------------------------------------------------------------

// 每天 22:00 —— 提醒规划明天的任务
cron.schedule('0 22 * * *', () => {
  console.log('\n===== 定时任务：每天 22:00 (北京时间) =====');
  sendPushNotification('今天和明天', '该规划明天的任务了，花5分钟安排好明天');
}, { timezone: 'Asia/Shanghai' });

// 每天 10:00 —— 新一天开始提醒
cron.schedule('0 10 * * *', () => {
  console.log('\n===== 定时任务：每天 10:00 (北京时间) =====');
  sendPushNotification('今天和明天', '新的一天开始了，今天有任务等着你完成');
}, { timezone: 'Asia/Shanghai' });

// 每周五 16:00 —— 周总结与下周规划
cron.schedule('0 16 * * 5', () => {
  console.log('\n===== 定时任务：每周五 16:00 (北京时间) =====');
  sendPushNotification('今天和明天', '周五了，花15分钟总结本周、规划下周');
}, { timezone: 'Asia/Shanghai' });

// ---------------------------------------------------------------------------
// 启动服务器
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log('============================================================');
  console.log('  「今天和明天」推送服务器已启动');
  console.log('============================================================');
  console.log(`  端口: ${PORT}`);
  console.log(`  VAPID 公钥: ${vapidKeys.publicKey}`);
  console.log(`  Supabase: ${sbClient ? '已连接' : '未配置'}`);
  console.log('------------------------------------------------------------');
  console.log('  定时推送任务（时区 Asia/Shanghai）:');
  console.log('    · 每天 22:00  —— 该规划明天的任务了');
  console.log('    · 每天 10:00  —— 新的一天开始了');
  console.log('    · 每周五 16:00 —— 周总结与下周规划');
  console.log('============================================================');
});
