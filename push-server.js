/**
 * 「今天和明天」PWA 推送服务器
 * ============================================================
 *
 * 使用方法：
 *   1. npm install          （安装 express, web-push, node-cron）
 *   2. node push-server.js  （启动服务器，默认监听 3000 端口）
 *   3. 手机和电脑连接同一 WiFi，手机浏览器访问 http://电脑IP:3000
 *      - 安装 PWA：
 *        · iOS：用 Safari 打开后点击「分享」->「添加到主屏幕」
 *        · Android：用 Chrome 打开后点击菜单「添加到主屏幕 / 安装应用」
 *   4. 在 PWA 页面点击「开启推送通知」按钮订阅
 *   5. 注意：手机端 Web Push 需要 HTTPS 环境。
 *      如果只在局域网 HTTP 下使用，iOS 可能无法接收推送。
 *      建议使用 ngrok 内网穿透获取 HTTPS 地址：
 *        npx ngrok http 3000
 *      然后用手机访问 ngrok 提供的 https://xxx.ngrok-free.app 地址安装 PWA。
 *
 * 首次运行时会自动生成 VAPID 密钥对并保存到 vapid-keys.json。
 * 订阅信息保存在 subscriptions.json。
 * ============================================================
 */

const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = 3000;

// 中间件：解析 JSON 请求体
app.use(express.json());
// 中间件：托管当前目录下的静态文件（index.html, manifest.json, sw.js, icon.svg 等）
app.use(express.static(__dirname));

// ---------------------------------------------------------------------------
// VAPID 密钥管理：首次运行时自动生成，后续从文件读取
// ---------------------------------------------------------------------------
const VAPID_KEYS_FILE = path.join(__dirname, 'vapid-keys.json');
const SUBSCRIPTIONS_FILE = path.join(__dirname, 'subscriptions.json');

const VAPID_SUBJECT = 'mailto:admin@today-tomorrow.local';

function loadVapidKeys() {
  if (fs.existsSync(VAPID_KEYS_FILE)) {
    const data = fs.readFileSync(VAPID_KEYS_FILE, 'utf-8');
    return JSON.parse(data);
  }
  // 首次运行：生成新的 VAPID 密钥对
  const keys = webpush.generateVAPIDKeys();
  const payload = {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey
  };
  fs.writeFileSync(VAPID_KEYS_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  console.log('[VAPID] 首次运行，已自动生成 VAPID 密钥对并保存到 vapid-keys.json');
  return payload;
}

function loadSubscriptions() {
  if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
    try {
      const data = fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      console.error('[订阅] 读取 subscriptions.json 失败，将使用空列表:', e.message);
      return [];
    }
  }
  return [];
}

function saveSubscriptions(subscriptions) {
  fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2), 'utf-8');
}

const vapidKeys = loadVapidKeys();

// 配置 web-push
webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);

// ---------------------------------------------------------------------------
// 接口：返回 VAPID 公钥（前端订阅时需要）
// ---------------------------------------------------------------------------
app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// ---------------------------------------------------------------------------
// 接口：接收并存储推送订阅
// ---------------------------------------------------------------------------
app.post('/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: '无效的订阅对象' });
  }

  const subscriptions = loadSubscriptions();

  // 去重：如果该 endpoint 已存在则更新，否则新增
  const index = subscriptions.findIndex(
    (sub) => sub.endpoint === subscription.endpoint
  );
  if (index >= 0) {
    subscriptions[index] = subscription;
    console.log('[订阅] 更新已有订阅:', subscription.endpoint);
  } else {
    subscriptions.push(subscription);
    console.log('[订阅] 新增订阅:', subscription.endpoint);
  }

  saveSubscriptions(subscriptions);
  res.json({ success: true, message: '订阅成功' });
});

// ---------------------------------------------------------------------------
// 接口：返回今日任务摘要
// ---------------------------------------------------------------------------
app.get('/api/today-tasks', (req, res) => {
  const now = new Date();
  // 转换为 Asia/Shanghai 时区的日期信息
  const shanghaiDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekday = weekdays[shanghaiDate.getDay()];
  const dateStr = `${shanghaiDate.getFullYear()}年${shanghaiDate.getMonth() + 1}月${shanghaiDate.getDate()}日 ${weekday}`;

  res.json({
    date: dateStr,
    summary: '今天和明天 - 任务提醒',
    todayTasks: [
      '查看今日待办事项',
      '完成重要的任务',
      '晚上回顾今天的进度'
    ],
    reminder: '新的一天开始了，今天有任务等着你完成'
  });
});

// ---------------------------------------------------------------------------
// 推送通知发送函数
// ---------------------------------------------------------------------------
function sendPushNotification(title, body) {
  const subscriptions = loadSubscriptions();
  if (subscriptions.length === 0) {
    console.log('[推送] 当前没有订阅者，跳过推送');
    return;
  }

  const payload = JSON.stringify({
    title: title,
    body: body,
    icon: 'icon.svg',
    badge: 'icon.svg',
    data: {
      url: '/'
    }
  });

  console.log(`[推送] 准备向 ${subscriptions.length} 个订阅者发送通知...`);
  console.log(`[推送] 标题: ${title}`);
  console.log(`[推送] 内容: ${body}`);

  const promises = subscriptions.map((subscription) => {
    return webpush
      .sendNotification(subscription, payload)
      .then(() => {
        console.log(`[推送] 发送成功: ${subscription.endpoint}`);
      })
      .catch((error) => {
        console.error(`[推送] 发送失败: ${subscription.endpoint}`, error.statusCode, error.message);
        // 如果订阅失效（410 Gone / 404 Not Found），则从列表中移除
        if (error.statusCode === 410 || error.statusCode === 404) {
          console.log(`[推送] 订阅已失效，正在移除: ${subscription.endpoint}`);
          const allSubs = loadSubscriptions();
          const filtered = allSubs.filter(
            (sub) => sub.endpoint !== subscription.endpoint
          );
          saveSubscriptions(filtered);
        }
      });
  });

  Promise.all(promises).then(() => {
    console.log('[推送] 本轮推送完成');
  });
}

// ---------------------------------------------------------------------------
// 定时推送任务（时区：Asia/Shanghai）
// ---------------------------------------------------------------------------

// 每天 22:00 —— 提醒规划明天的任务
cron.schedule(
  '0 22 * * *',
  () => {
    console.log('\n===== 定时任务触发：每天 22:00 =====');
    sendPushNotification('今天和明天', '该规划明天的任务了，花5分钟安排好明天');
  },
  {
    timezone: 'Asia/Shanghai'
  }
);

// 每天 10:00 —— 新一天开始提醒
cron.schedule(
  '0 10 * * *',
  () => {
    console.log('\n===== 定时任务触发：每天 10:00 =====');
    sendPushNotification('今天和明天', '新的一天开始了，今天有任务等着你完成');
  },
  {
    timezone: 'Asia/Shanghai'
  }
);

// 每周五 16:00 —— 周总结与下周规划
cron.schedule(
  '0 16 * * 5',
  () => {
    console.log('\n===== 定时任务触发：每周五 16:00 =====');
    sendPushNotification('今天和明天', '周五了，花15分钟总结本周、规划下周');
  },
  {
    timezone: 'Asia/Shanghai'
  }
);

// ---------------------------------------------------------------------------
// 接口：手动触发测试推送（用于验证推送是否正常工作）
// 访问 http://localhost:3000/trigger?type=morning 触发"早上提醒"
// 访问 http://localhost:3000/trigger?type=night 触发"晚间规划"
// 访问 http://localhost:3000/trigger 触发默认测试推送
// ---------------------------------------------------------------------------
app.get('/trigger', (req, res) => {
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
  
  sendPushNotification(title, body);
  res.json({ success: true, message: `已触发推送：${title} - ${body}`, subscribers: loadSubscriptions().length });
});

// ---------------------------------------------------------------------------
// 接口：查看当前订阅数量
// ---------------------------------------------------------------------------
app.get('/subscriptions/count', (req, res) => {
  res.json({ count: loadSubscriptions().length });
});

// ---------------------------------------------------------------------------
// 获取本机局域网 IP 地址
// ---------------------------------------------------------------------------
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // 跳过 IPv6 和回环地址，只取 IPv4 的局域网地址
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ---------------------------------------------------------------------------
// 启动服务器
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log('============================================================');
  console.log('  「今天和明天」PWA 推送服务器已启动');
  console.log('============================================================');
  console.log(`  VAPID 公钥: ${vapidKeys.publicKey}`);
  console.log('------------------------------------------------------------');
  console.log(`  本机访问:   http://localhost:${PORT}`);
  console.log(`  局域网访问: http://${localIP}:${PORT}`);
  console.log('------------------------------------------------------------');
  console.log('  定时推送任务（时区 Asia/Shanghai）:');
  console.log('    · 每天 22:00  —— 该规划明天的任务了');
  console.log('    · 每天 10:00  —— 新的一天开始了');
  console.log('    · 每周五 16:00 —— 周总结与下周规划');
  console.log('------------------------------------------------------------');
  console.log('  提示: 手机端推送需要 HTTPS，建议使用 ngrok 内网穿透:');
  console.log('        npx ngrok http 3000');
  console.log('============================================================');
});
