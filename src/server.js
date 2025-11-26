const express = require('express');
const redis = require('redis');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// 静态文件服务（如果public目录存在）
try {
  if (require('fs').statSync('public').isDirectory()) {
    app.use(express.static('public'));
  }
} catch(e) {
  // 如果public目录不存在，则不启用静态文件服务
  console.log('注意: public目录不存在，跳过静态文件服务');
}

const DEFAULT_CONFIG = {
  retryCount: 2,
  retryDelay: 2000,
  userAgent: "KeepAlive-Worker/2.0",
};

function getLocalTimestamp() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

class RedisClient {
  constructor() {
    this.client = redis.createClient({
      url: `redis://:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`
    });
    
    this.client.on('error', (err) => {
      console.error('Redis连接错误:', err);
    });
    
    this.client.on('connect', () => {
      console.log('Redis连接成功');
    });
  }

  async connect() {
    try {
      await this.client.connect();
      return true;
    } catch (error) {
      console.error('Redis连接失败:', error);
      return false;
    }
  }

  async getDomains() {
    try {
      const value = await this.client.get('domains');
      let domains = value ? JSON.parse(value) : [];

      // 兼容旧格式：如果是字符串数组，则转换为对象格式并保存
      if (domains.length > 0 && typeof domains[0] === 'string') {
        domains = domains.map(domain => ({
          domain: domain,
          verificationCode: this.generateVerificationCode(),
          addedAt: new Date().toISOString()
        }));
        // 保存转换后的格式
        await this.setDomains(domains);
      }
      return domains;
    } catch (error) {
      console.error('获取域名列表失败:', error);
      return [];
    }
  }

  // 生成随机验证码
  generateVerificationCode() {
    return Math.random().toString(36).substring(2, 10).toUpperCase();
  }

  async getDomainConfig(domain) {
    try {
      const value = await this.client.get(`domain:${domain}`);
      if (!value) {
        return { interval: 5 }; // 默认5分钟
      }
      const config = JSON.parse(value);

      // 计算下一次保活时间（从当前时间算起的下次执行时间）
      const now = new Date().getTime();
      if (config.lastChecked) {
        const lastCheckedTime = new Date(config.lastChecked).getTime();
        const timeSinceLastCheck = now - lastCheckedTime;
        const intervalInMs = config.interval * 60 * 1000; // interval是分钟，转换为毫秒

        // 计算从上次检查到现在需要多少个完整的间隔周期
        const completedIntervals = Math.floor(timeSinceLastCheck / intervalInMs);
        const nextCheckTime = lastCheckedTime + (completedIntervals + 1) * intervalInMs;

        // 如果下一个检查时间已经过去，则设置为从现在开始的下一个周期
        if (nextCheckTime <= now) {
          config.nextCheckTime = new Date(now + intervalInMs).toISOString();
        } else {
          config.nextCheckTime = new Date(nextCheckTime).toISOString();
        }
      } else {
        // 如果从未检查过，下次检查时间是现在加上间隔
        config.nextCheckTime = new Date(now + (config.interval * 60 * 1000)).toISOString();
      }

      return config;
    } catch (error) {
      console.error('获取域名配置失败:', error);
      return { interval: 5 };
    }
  }

  async getAllDomainConfigs() {
    try {
      const domains = await this.getDomains();
      const configs = [];

      for (const domainEntry of domains) {
        const config = await this.getDomainConfig(domainEntry.domain);
        configs.push({
          domain: domainEntry.domain,
          interval: config.interval || 5,
          lastChecked: config.lastChecked || null,
          nextCheckTime: config.nextCheckTime || null
        });
      }

      return configs;
    } catch (error) {
      console.error('获取所有域名配置失败:', error);
      return [];
    }
  }

  async addDomain(domain, interval = 5) {
    try {
      const domains = await this.getDomains();
      const existingDomain = domains.find(item => item.domain === domain);
      
      let verificationCode;
      if (!existingDomain) {
        verificationCode = this.generateVerificationCode();
        domains.push({
          domain: domain,
          verificationCode: verificationCode,
          addedAt: new Date().toISOString()
        });
        await this.setDomains(domains);
      } else {
        verificationCode = existingDomain.verificationCode;
      }
      
      const config = await this.getDomainConfig(domain);
      config.interval = parseInt(interval);
      await this.client.set(`domain:${domain}`, JSON.stringify(config));
      return { success: true, verificationCode };
    } catch (error) {
      console.error('添加域名失败:', error);
      return { success: false, error: error.message };
    }
  }

  async updateDomainInterval(domain, interval) {
    try {
      const config = await this.getDomainConfig(domain);
      config.interval = parseInt(interval);
      await this.client.set(`domain:${domain}`, JSON.stringify(config));
      return true;
    } catch (error) {
      console.error('更新域名保活间隔失败:', error);
      return false;
    }
  }

  async updateDomainLastChecked(domain) {
    try {
      const config = await this.getDomainConfig(domain);
      config.lastChecked = new Date().toISOString();
      await this.client.set(`domain:${domain}`, JSON.stringify(config));
      return true;
    } catch (error) {
      console.error('更新域名检查时间失败:', error);
      return false;
    }
  }

  async removeDomain(domain, verificationCode) {
    try {
      const domains = await this.getDomains();
      const index = domains.findIndex(item => item.domain === domain);
      if (index > -1) {
        const domainEntry = domains[index];
        // 检查是否为管理员验证码
        const isAdminCode = verificationCode === process.env.ADMIN_VERIFICATION_CODE;
        
        // 验证验证码（管理员验证码或域名验证码）
        if (!isAdminCode && domainEntry.verificationCode !== verificationCode) {
          return { success: false, error: '验证码错误，请检查后重试' };
        }
        domains.splice(index, 1);
        await this.setDomains(domains);
        await this.client.del(`domain:${domain}`);
        return { success: true, isAdmin: isAdminCode };
      }
      return { success: false, error: '域名不存在' };
    } catch (error) {
      console.error('删除域名失败:', error);
      return { success: false, error: error.message };
    }
  }

  async setDomains(domains) {
    try {
      await this.client.set('domains', JSON.stringify(domains));
      return true;
    } catch (error) {
      console.error('设置域名列表失败:', error);
      return false;
    }
  }

  async disconnect() {
    try {
      await this.client.disconnect();
    } catch (error) {
      console.error('Redis断开连接失败:', error);
    }
  }

  // 保存域名访问日志
  async saveDomainLog(domain, logData) {
    try {
      const logEntry = {
        timestamp: new Date().toISOString(),
        ...logData
      };

      // 获取现有日志，保留最新的50条记录
      const logs = await this.getDomainLogs(domain, 50);
      logs.push(logEntry);

      // 只保留最新的50条记录
      if (logs.length > 50) {
        logs.splice(0, logs.length - 50);
      }

      await this.client.set(`domain:${domain}:logs`, JSON.stringify(logs));
      return true;
    } catch (error) {
      console.error('保存域名日志失败:', error);
      return false;
    }
  }

  // 获取域名访问日志
  async getDomainLogs(domain, limit = 20) {
    try {
      const value = await this.client.get(`domain:${domain}:logs`);
      const allLogs = value ? JSON.parse(value) : [];

      // 返回最新的limit条记录
      return allLogs.slice(-limit).reverse(); // 倒序以显示最新的在前面
    } catch (error) {
      console.error('获取域名日志失败:', error);
      return [];
    }
  }

  // 清空域名日志
  async clearDomainLogs(domain) {
    try {
      await this.client.del(`domain:${domain}:logs`);
      return true;
    } catch (error) {
      console.error('清空域名日志失败:', error);
      return false;
    }
  }
}

async function initializeConfig() {
  let domains = [];
  let configError = null;
  let redisClient = null;

  if (process.env.REDIS_HOST && process.env.REDIS_PORT && process.env.REDIS_PASSWORD) {
    redisClient = new RedisClient();
    const connected = await redisClient.connect();
    if (connected) {
      const domainObjects = await redisClient.getDomains();
      // 提取域名字符串用于保活任务
      domains = domainObjects.map(obj => obj.domain);
      if (domains.length === 0) {
        configError = "Redis中暂无域名配置，请通过前端界面添加域名。";
      }
    } else {
      configError = "Redis连接失败，请检查连接配置。";
    }
  } else if (process.env.TARGET_DOMAINS) {
    try {
      const parsedDomains = JSON.parse(process.env.TARGET_DOMAINS);
      if (!Array.isArray(parsedDomains) || parsedDomains.length === 0) {
        throw new Error("必须是一个非空数组。");
      }
      domains = parsedDomains;
    } catch (error) {
      configError = `配置错误: 环境变量 TARGET_DOMAINS 格式不正确。详情: ${error.message}`;
    }
  } else {
    configError = "配置缺失: 请配置Redis连接信息或设置环境变量 TARGET_DOMAINS。";
  }

  const retries = parseInt(process.env.RETRY_COUNT, 10);
  const maxRetries = isNaN(retries) ? DEFAULT_CONFIG.retryCount : retries;

  const delay = parseInt(process.env.RETRY_DELAY, 10);
  const retryDelay = isNaN(delay) ? DEFAULT_CONFIG.retryDelay : delay;

  return {
    domains,
    retries: maxRetries,
    delay: retryDelay,
    userAgent: DEFAULT_CONFIG.userAgent,
    error: configError,
    redisClient,
  };
}

async function performWakeup(domain, config) {
  let attempts = 0;
  let lastKnownError = null;
  const url = domain.startsWith('http') ? domain : `https://${domain}`;

  while (attempts <= config.retries) {
    attempts++;
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': `${config.userAgent}`,
          'Accept': '*/*',
          'Cache-Control': 'no-cache',
        },
      });

      if (response.ok) {
        // 保存成功日志
        if (config.redisClient) {
          await config.redisClient.saveDomainLog(domain, {
            status: "成功",
            statusCode: response.status,
            url: url,
            attempts: attempts
          });
        }
        return { domain, status: "成功", statusCode: response.status, attempts, error: null };
      }
      lastKnownError = { type: "http_error", code: response.status };
    } catch (error) {
      lastKnownError = { type: "network_error", message: error.message };
    }

    if (attempts <= config.retries) {
      await sleep(config.delay);
    }
  }

  const isHttpError = lastKnownError && lastKnownError.type === "http_error";
  const result = {
    domain,
    status: "失败",
    statusCode: isHttpError ? lastKnownError.code : null,
    attempts,
    error: isHttpError ? `HTTP 错误: ${lastKnownError.code}` : (lastKnownError ? lastKnownError.message : "未知错误"),
  };

  // 保存失败日志
  if (config.redisClient) {
    await config.redisClient.saveDomainLog(domain, {
      status: "失败",
      statusCode: isHttpError ? lastKnownError.code : null,
      url: url,
      attempts: attempts,
      error: result.error
    });
  }

  return result;
}

async function executeAllWakeups(config) {
  if (config.error) {
    return { summary: config.error, outcomes: [] };
  }

  const allTasks = config.domains.map(domain => performWakeup(domain, config));
  const settledOutcomes = await Promise.allSettled(allTasks);

  const finalOutcomes = settledOutcomes.map((outcome, index) => {
    if (outcome.status === "fulfilled") {
      return outcome.value;
    }
    return {
      domain: config.domains[index] || "未知域名",
      status: "系统错误",
      statusCode: null,
      attempts: config.retries + 1,
      error: outcome.reason.message || "一个未知的系统级错误发生",
    };
  });

  return {
    summary: `已处理 ${config.domains.length} 个域名。`,
    outcomes: finalOutcomes,
  };
}

function logTaskResults(taskReport) {
  console.log(`[任务报告] ${taskReport.summary}`);
  if (taskReport.outcomes.length === 0) return;

  taskReport.outcomes.forEach(result => {
    const icon = result.status === '成功' ? '✅' : '❌';
    const details = result.error ? `错误: ${result.error}` : `状态码: ${result.statusCode}`;
    console.log(`${icon} ${result.domain} | 状态: ${result.status} | 尝试: ${result.attempts}次 | ${details}`);
  });

  const successCount = taskReport.outcomes.filter(r => r.status === '成功').length;
  const failureCount = taskReport.outcomes.length - successCount;
  console.log(`[任务摘要] 总数: ${taskReport.outcomes.length}, 成功: ${successCount}, 失败: ${failureCount}。`);
}

const HTML_STYLE = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
  @keyframes fadeIn { from { opacity: 0; transform: translateY(15px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
  @keyframes gradient { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
  * { box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    margin: 0; padding: 20px; min-height: 100vh;
    background: linear-gradient(-45deg, #e8f5e8, #f0f8ff, #f5f0ff, #fff5ee);
    background-size: 400% 400%; animation: gradient 15s ease infinite;
    color: #2c3e50; line-height: 1.6;
  }
  .main-container { max-width: 800px; margin: 0 auto; display: flex; flex-direction: column; align-items: center; gap: 25px; }
  .header { text-align: center; background: rgba(255, 255, 255, 0.9); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 24px; padding: 40px 50px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1); width: 100%; }
  h1 { font-size: 36px; font-weight: 700; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; margin: 0 0 15px 0; }
  .subtitle { color: #64748b; font-size: 16px; font-weight: 400; margin: 0 0 35px 0; opacity: 0.8; }
  .trigger-button { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); color: white; border: none; padding: 18px 36px; border-radius: 50px; font-size: 16px; font-weight: 600; cursor: pointer; transition: all 0.3s; box-shadow: 0 8px 25px rgba(79, 172, 254, 0.3); min-width: 200px; }
  .trigger-button:hover:not(:disabled) { transform: translateY(-3px) scale(1.05); box-shadow: 0 15px 35px rgba(79, 172, 254, 0.4); animation: bounce 1s infinite; }
  .trigger-button:disabled { background: linear-gradient(135deg, #cbd5e1 0%, #94a3b8 100%); cursor: not-allowed; }
  #status { font-size: 15px; font-weight: 500; min-height: 25px; text-align: center; padding: 10px 20px; border-radius: 12px; background: rgba(255, 255, 255, 0.6); backdrop-filter: blur(5px); border: 1px solid rgba(255, 255, 255, 0.3); margin-top: 20px; }
  .results-section, .usage-panel, .domains-section { width: 100%; background: rgba(255, 255, 255, 0.9); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 24px; padding: 30px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1); }
  .results-section { display: none; }
  .results-section.show { display: block; animation: fadeIn 0.6s ease-out; }
  .section-title { font-size: 20px; font-weight: 600; color: #1e293b; text-align: center; margin: 0 0 25px 0; padding-bottom: 15px; border-bottom: 2px solid #e2e8f0; }
  .result-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #eef2f7; animation: fadeIn 0.5s ease-out forwards; }
  .result-item:last-child { border-bottom: none; }
  .result-domain { font-weight: 500; color: #334155; flex-grow: 1; word-break: break-all; }
  .result-tags { display: flex; gap: 8px; flex-shrink: 0; margin-left: 15px; }
  .result-tag { padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 500; white-space: nowrap; }
  .tag-success { background-color: #dcfce7; color: #166534; }
  .tag-error { background-color: #fee2e2; color: #991b1b; }
  .tag-attempts { background-color: #f1f5f9; color: #475569; }
  .usage-content { font-size: 14px; color: #475569; line-height: 1.8; }
  .usage-content strong { color: #1e293b; font-weight: 600; }
  .usage-content code { background-color: #e2e8f0; padding: 3px 7px; border-radius: 6px; font-family: 'Courier New', Courier, monospace; font-size: 13px; border: 1px solid #cbd5e1; }
  .usage-content ul { padding-left: 20px; list-style-position: inside; }
  .usage-content li { margin-bottom: 12px; }
  .copy-code-button { background-color: #f1f5f9; border: 1px solid #cbd5e1; color: #475569; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; margin-left: 10px; }
  .copy-code-button:hover { background-color: #e2e8f0; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 25px 0; }
  
  .domain-input-group { display: flex; gap: 10px; margin-bottom: 20px; align-items: flex-end; }
  .domain-input-wrapper { flex: 1; }
  .domain-input { width: 100%; padding: 12px 16px; border: 2px solid #e2e8f0; border-radius: 12px; font-size: 14px; transition: all 0.3s; }
  .domain-input:focus { outline: none; border-color: #4facfe; box-shadow: 0 0 0 3px rgba(79, 172, 254, 0.1); }
  .interval-input-wrapper { width: 150px; }
  .interval-input { width: 100%; padding: 12px 16px; border: 2px solid #e2e8f0; border-radius: 12px; font-size: 14px; transition: all 0.3s; }
  .interval-input:focus { outline: none; border-color: #4facfe; box-shadow: 0 0 0 3px rgba(79, 172, 254, 0.1); }
  .input-label { display: block; font-size: 12px; color: #64748b; margin-bottom: 4px; font-weight: 500; }
  .add-domain-btn { background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; padding: 12px 20px; border-radius: 12px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.3s; white-space: nowrap; }
  .add-domain-btn:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(16, 185, 129, 0.3); }
  .add-domain-btn:disabled { background: linear-gradient(135deg, #cbd5e1 0%, #94a3b8 100%); cursor: not-allowed; }
  
  .domain-list { max-height: 300px; overflow-y: auto; }
  .domain-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: #f8fafc; border-radius: 12px; margin-bottom: 8px; animation: fadeIn 0.3s ease-out; }
  .domain-item:hover { background: #f1f5f9; }
  .domain-info { flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .domain-url { font-weight: 500; color: #334155; word-break: break-all; }
  .domain-interval { font-size: 12px; color: #64748b; }
  .domain-interval strong { color: #059669; }
  .verification-code { font-size: 12px; color: #64748b; margin-top: 4px; }
  .code-text { font-family: 'Courier New', monospace; background: #e2e8f0; padding: 2px 6px; border-radius: 6px; font-weight: 600; }
  
  /* 验证码弹窗样式 */
  .verification-modal { display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0, 0, 0, 0.5); backdrop-filter: blur(5px); }
  .verification-modal-content { background-color: #fefefe; margin: 15% auto; padding: 30px; border: none; border-radius: 16px; width: 90%; max-width: 400px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04); animation: modalFadeIn 0.3s ease-out; }
  @keyframes modalFadeIn { from { opacity: 0; transform: scale(0.9) translateY(-20px); } to { opacity: 1; transform: scale(1) translateY(0); } }
  .verification-modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .verification-modal-title { font-size: 18px; font-weight: 600; color: #1e293b; margin: 0; }
  .close-verification-modal { color: #94a3b8; font-size: 24px; font-weight: bold; cursor: pointer; transition: color 0.2s; }
  .close-verification-modal:hover { color: #475569; }
  .verification-modal-body { margin-bottom: 20px; }
  .verification-message { font-size: 14px; color: #64748b; margin-bottom: 15px; line-height: 1.5; }
  .verification-input { width: 100%; padding: 12px 16px; border: 2px solid #e2e8f0; border-radius: 12px; font-size: 14px; font-family: 'Courier New', monospace; font-weight: 600; text-align: center; letter-spacing: 1px; transition: all 0.3s; }
  .verification-input:focus { outline: none; border-color: #4facfe; box-shadow: 0 0 0 3px rgba(79, 172, 254, 0.1); }
  .verification-modal-footer { display: flex; gap: 10px; justify-content: flex-end; }
  .verification-cancel-btn { background: #f1f5f9; color: #475569; border: none; padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
  .verification-cancel-btn:hover { background: #e2e8f0; }
  .verification-confirm-btn { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: white; border: none; padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
  .verification-confirm-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(239, 68, 68, 0.3); }
  .verification-confirm-btn:disabled { background: #cbd5e1; cursor: not-allowed; transform: none; box-shadow: none; }
  
  /* 验证码通知样式 */
  .verification-notification {
    position: fixed;
    top: 20px;
    right: 20px;
    background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
    border: 1px solid #f59e0b;
    border-radius: 12px;
    padding: 16px 20px;
    box-shadow: 0 10px 25px -5px rgba(245, 158, 11, 0.25);
    z-index: 2000;
    max-width: 350px;
    animation: slideInRight 0.3s ease-out;
  }
  @keyframes slideInRight { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
  @keyframes slideOutRight { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
  .notification-header { display: flex; align-items: center; margin-bottom: 10px; }
  .notification-icon { width: 20px; height: 20px; margin-right: 8px; color: #d97706; }
  .notification-title { font-weight: 600; color: #92400e; font-size: 14px; }
  .notification-body { color: #78350f; font-size: 13px; line-height: 1.4; }
  .notification-code { 
    background: #fff; 
    border: 1px solid #fbbf24; 
    border-radius: 6px; 
    padding: 8px 12px; 
    font-family: 'Courier New', monospace; 
    font-weight: 700; 
    font-size: 16px; 
    text-align: center; 
    letter-spacing: 2px; 
    margin: 10px 0;
    color: #92400e;
  }
  .notification-close { 
    position: absolute; 
    top: 8px; 
    right: 8px; 
    background: none; 
    border: none; 
    font-size: 18px; 
    cursor: pointer; 
    opacity: 0.7; 
    transition: opacity 0.2s;
  }
  .notification-close:hover { opacity: 1; }
  
  /* 错误通知样式 */
  .error-notification {
    position: fixed;
    top: 20px;
    right: 20px;
    background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
    border: 1px solid #ef4444;
    border-radius: 12px;
    padding: 16px 20px;
    box-shadow: 0 10px 25px -5px rgba(239, 68, 68, 0.25);
    z-index: 2000;
    max-width: 350px;
    animation: slideInRight 0.3s ease-out;
  }
  .error-notification .notification-header .notification-icon { color: #dc2626; }
  .error-notification .notification-title { color: #991b1b; }
  .error-notification .notification-body { color: #7f1d1d; }
  .error-notification .notification-close { color: #991b1b; }
  .domain-actions { display: flex; gap: 8px; align-items: center; }
  .logs-domain-btn { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; border: none; padding: 6px 12px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.3s; }
  .logs-domain-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(59, 130, 246, 0.3); }
  .delete-domain-btn { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: white; border: none; padding: 6px 12px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.3s; }
  .delete-domain-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(239, 68, 68, 0.3); }

  .logs-modal { display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0, 0, 0, 0.5); }
  .logs-modal-content { background-color: #fefefe; margin: 2% auto; padding: 20px; border: none; border-radius: 12px; width: 90%; max-width: 800px; max-height: 90vh; overflow-y: auto; }
  .logs-modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #e2e8f0; }
  .logs-modal-title { font-size: 20px; font-weight: 600; margin: 0; }
  .close-logs-modal { color: #aaa; float: right; font-size: 28px; font-weight: bold; cursor: pointer; }
  .close-logs-modal:hover { color: #000; }
  .logs-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  .logs-table th, .logs-table td { padding: 10px; text-align: left; border-bottom: 1px solid #e2e8f0; }
  .logs-table th { background-color: #f8fafc; font-weight: 600; }
  .log-status-success { color: #16a34a; font-weight: 600; }
  .log-status-failed { color: #dc2626; font-weight: 600; }
  .logs-actions { display: flex; justify-content: space-between; margin-top: 15px; }
  .clear-logs-btn { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; border: none; padding: 8px 16px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.3s; }
  .clear-logs-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(245, 158, 11, 0.3); }

  .empty-domains { text-align: center; color: #64748b; font-style: italic; padding: 20px; }
  .loading { text-align: center; color: #64748b; padding: 20px; }

  /* 底部链接样式 */
  .footer { text-align: center; padding: 20px; margin-top: 20px; color: #64748b; font-size: 14px; }
  .footer a { color: #4facfe; text-decoration: none; font-weight: 500; transition: color 0.2s; }
  .footer a:hover { color: #00f2fe; text-decoration: underline; }
  .verification-help { background: rgba(79, 172, 254, 0.1); border: 1px solid rgba(79, 172, 254, 0.2); border-radius: 8px; padding: 12px; margin-top: 10px; font-size: 13px; }
  .verification-help strong { color: #0369a1; }

  @media (max-width: 768px) {
    body { padding: 15px; } .header { padding: 30px 25px; } h1 { font-size: 28px; }
    .result-item { flex-wrap: wrap; align-items: center; gap: 8px; } .result-tags { margin-left: 0; }
    .domain-input-group { flex-direction: column; } .domain-input { width: 100%; }
  }
`;

const HTML_SCRIPT = `
  const triggerButton = document.getElementById('triggerButton');
  const statusDiv = document.getElementById('status');
  const resultsDiv = document.getElementById('results');
  const resultsSection = document.getElementById('resultsSection');
  const domainInput = document.getElementById('domainInput');
  const intervalInput = document.getElementById('intervalInput');
  const addDomainBtn = document.getElementById('addDomainBtn');
  const domainsList = document.getElementById('domainsList');

  function createResultItem(result) {
    const item = document.createElement('div');
    item.className = 'result-item';
    const isSuccess = result.status === '成功';
    const icon = isSuccess ? '✅' : '❌';
    const domainPart = \`<div class="result-domain">\${icon} \${result.domain}</div>\`;
    const statusTag = \`<span class="result-tag \${isSuccess ? 'tag-success' : 'tag-error'}">\${result.status}</span>\`;
    const attemptsTag = \`<span class="result-tag tag-attempts">尝试: \${result.attempts}</span>\`;
    let detailsTag = '';
    if (result.error) {
      detailsTag = \`<span class="result-tag tag-error">\${result.error}</span>\`;
    } else {
      detailsTag = \`<span class="result-tag tag-success">状态码: \${result.statusCode}</span>\`;
    }
    const tagsPart = \`<div class="result-tags">\${statusTag}\${attemptsTag}\${detailsTag}</div>\`;
    item.innerHTML = domainPart + tagsPart;
    return item;
  }

  function createDomainItem(domainConfig) {
    const item = document.createElement('div');
    item.className = 'domain-item';
    const intervalText = domainConfig.interval === 60 ? '1小时' : domainConfig.interval + '分钟';

    // 格式化下一次保活时间
    let nextCheckText = '未知';
    if (domainConfig.nextCheckTime) {
      const nextCheckDate = new Date(domainConfig.nextCheckTime);
      // 格式化为更易读的日期时间格式
      nextCheckText = nextCheckDate.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }

    item.innerHTML = '<div class="domain-info">' +
      '<div class="domain-url">' + domainConfig.domain + '</div>' +
      '<div class="domain-interval">保活间隔: <strong>' + intervalText + '</strong> | 下次保活: <strong>' + nextCheckText + '</strong></div>' +
      '</div>' +
      '<div class="domain-actions">' +
      '<button class="logs-domain-btn" data-domain="' + encodeURIComponent(domainConfig.domain) + '">日志</button>' +
      '<button class="delete-domain-btn" data-domain="' + encodeURIComponent(domainConfig.domain) + '">删除</button>' +
      '</div>';

    const logsBtn = item.querySelector('.logs-domain-btn');
    logsBtn.addEventListener('click', () => {
      showDomainLogs(decodeURIComponent(logsBtn.dataset.domain));
    });

    const deleteBtn = item.querySelector('.delete-domain-btn');
    deleteBtn.addEventListener('click', () => {
      const domain = decodeURIComponent(deleteBtn.dataset.domain);
      showVerificationModal(domain);
    });

    return item;
  }

  async function loadDomains() {
    domainsList.innerHTML = '<div class="loading">加载中...</div>';
    try {
      const response = await fetch('/api/domains');
      if (!response.ok) throw new Error('加载失败');
      const data = await response.json();

      domainsList.innerHTML = '';
      if (data.domains && data.domains.length > 0) {
        data.domains.forEach(domainConfig => {
          domainsList.appendChild(createDomainItem(domainConfig));
        });
      } else {
        domainsList.innerHTML = '<div class="empty-domains">暂无域名，请添加要保活的网站</div>';
      }
    } catch (error) {
      domainsList.innerHTML = '<div class="empty-domains">加载域名列表失败</div>';
      console.error('加载域名失败:', error);
    }
  }

  async function addDomain() {
    const domain = domainInput.value.trim();
    const interval = intervalInput.value.trim();

    if (!domain) {
      statusDiv.textContent = '❌ 请输入域名';
      return;
    }

    addDomainBtn.disabled = true;
    addDomainBtn.textContent = '添加中...';

    try {
      const response = await fetch('/api/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, interval: parseInt(interval) })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '添加失败');

      statusDiv.textContent = '✨ ' + data.message;
      if (data.verificationCode) {
        showVerificationNotification(data.verificationCode);
      }
      domainInput.value = '';
      intervalInput.value = '5';
      loadDomains();
    } catch (error) {
      statusDiv.textContent = '❌ 添加域名失败: ' + error.message;
    } finally {
      addDomainBtn.disabled = false;
      addDomainBtn.textContent = '添加域名';
    }
  }

  triggerButton.addEventListener('click', async () => {
    triggerButton.disabled = true;
    triggerButton.textContent = '正在执行中...';
    statusDiv.textContent = '正在向服务器发送请求，请稍候...';
    resultsDiv.innerHTML = '';
    resultsSection.classList.remove('show');

    try {
      const response = await fetch('/run-tasks', { method: 'POST' });
      if (!response.ok) throw new Error('服务器响应错误: ' + response.status);
      const data = await response.json();

      statusDiv.textContent = \`✨ 执行完成于 \${data.timestamp} | \${data.summary}\`;

      if (data.results && data.results.length > 0) {
        data.results.forEach(result => resultsDiv.appendChild(createResultItem(result)));
        resultsSection.classList.add('show');
      }
    } catch (error) {
      statusDiv.textContent = '❌ 执行失败: ' + error.message;
    } finally {
      triggerButton.disabled = false;
      triggerButton.textContent = '手动触发保活任务';
    }
  });

  addDomainBtn.addEventListener('click', addDomain);
  domainInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addDomain();
  });

  document.querySelectorAll('.copy-code-button').forEach(button => {
    button.addEventListener('click', (e) => {
      const codeElement = e.target.closest('li').querySelector('code');
      navigator.clipboard.writeText(codeElement.innerText).then(() => {
        e.target.textContent = '已复制!';
        setTimeout(() => { e.target.textContent = '复制'; }, 2000);
      }).catch(err => {
        console.error('复制失败: ', err);
        e.target.textContent = '失败';
      });
    });
  });

  // 显示域名日志的函数
  function showDomainLogs(domain) {
    const modal = document.getElementById('logsModal');
    const title = document.getElementById('logsModalTitle');
    const tableBody = document.getElementById('logsTableBody');
    const clearLogsBtn = document.getElementById('clearLogsBtn');

    title.textContent = '域名日志 - ' + domain;

    // 清空现有内容并显示加载状态
    tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center;">加载中...</td></tr>';

    // 获取日志数据
    fetch('/api/domains/' + encodeURIComponent(domain) + '/logs')
      .then(response => response.json())
      .then(data => {
        if (data.logs && data.logs.length > 0) {
          tableBody.innerHTML = '';
          data.logs.forEach(log => {
            const row = document.createElement('tr');

            // 格式化时间
            const logTime = new Date(log.timestamp).toLocaleString('zh-CN', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            });

            // 设置状态文本和样式
            const statusClass = log.status === '成功' ? 'log-status-success' : 'log-status-failed';
            const statusText = '<span class="' + statusClass + '">' + log.status + '</span>';

            // 处理状态码（如果成功则显示状态码，如果失败但没有状态码则显示N/A）
            const statusCodeText = log.statusCode ? log.statusCode : 'N/A';

            // 处理错误信息
            const errorText = log.error ? log.error : (log.status === '失败' ? '未知错误' : '');

            row.innerHTML =
              '<td>' + logTime + '</td>' +
              '<td>' + statusText + '</td>' +
              '<td>' + statusCodeText + '</td>' +
              '<td>' + (log.attempts || 1) + '</td>' +
              '<td>' + errorText + '</td>';

            tableBody.appendChild(row);
          });
        } else {
          tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center;">暂无日志</td></tr>';
        }
      })
      .catch(error => {
        console.error('获取日志失败:', error);
        tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center;">获取日志失败: ' + error.message + '</td></tr>';
      });

    // 设置清空日志按钮事件
    clearLogsBtn.onclick = function() {
      if (confirm('确定要清空 ' + domain + ' 的所有日志吗？')) {
        fetch('/api/domains/' + encodeURIComponent(domain) + '/logs', { method: 'DELETE' })
          .then(response => response.json())
          .then(data => {
            if (data.message) {
              statusDiv.textContent = '✨ ' + data.message;
              // 重新加载日志
              showDomainLogs(domain);
            } else {
              statusDiv.textContent = '❌ 清空日志失败';
            }
          })
          .catch(error => {
            statusDiv.textContent = '❌ 清空日志失败: ' + error.message;
          });
      }
    };

    // 显示模态框
    modal.style.display = 'block';
  }

  // 关闭模态框的函数
  function closeLogsModal() {
    const modal = document.getElementById('logsModal');
    modal.style.display = 'none';
  }

  // 点击模态框外部关闭模态框
  window.onclick = function(event) {
    const modal = document.getElementById('logsModal');
    if (event.target === modal) {
      closeLogsModal();
    }
  };

  // 设置关闭按钮事件
  document.getElementById('closeLogsModal').onclick = closeLogsModal;

  // 验证码通知和弹窗相关函数
  let currentDomain = '';

  function showVerificationNotification(code) {
    const notificationContainer = document.getElementById('notificationContainer');
    
    const notification = document.createElement('div');
    notification.className = 'verification-notification';
    notification.innerHTML = 
      '<button class="notification-close" onclick="this.parentElement.remove()">&times;</button>' +
      '<div class="notification-header">' +
        '<svg class="notification-icon" fill="currentColor" viewBox="0 0 20 20">' +
          '<path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>' +
        '</svg>' +
        '<span class="notification-title">重要：验证码已生成</span>' +
      '</div>' +
      '<div class="notification-body">' +
        '您的域名验证码如下，请立即保存！此验证码只显示一次，删除域名时需要使用。' +
        '<div class="notification-code">' + code + '</div>' +
        '<small>⚠️ 请截图或记录此验证码，关闭后将无法再次查看</small>' +
      '</div>';
    
    notificationContainer.appendChild(notification);
    
    // 10秒后自动关闭
    setTimeout(() => {
      if (notification.parentElement) {
        notification.style.animation = 'slideOutRight 0.3s ease-out';
        setTimeout(() => notification.remove(), 300);
      }
    }, 10000);
  }

  function showErrorNotification(message) {
    const notificationContainer = document.getElementById('notificationContainer');
    
    const notification = document.createElement('div');
    notification.className = 'error-notification';
    notification.innerHTML = 
      '<button class="notification-close" onclick="this.parentElement.remove()">&times;</button>' +
      '<div class="notification-header">' +
        '<svg class="notification-icon" fill="currentColor" viewBox="0 0 20 20">' +
          '<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/>' +
        '</svg>' +
        '<span class="notification-title">验证码错误</span>' +
      '</div>' +
      '<div class="notification-body">' +
        message +
      '</div>';
    
    notificationContainer.appendChild(notification);
    
    // 5秒后自动关闭
    setTimeout(() => {
      if (notification.parentElement) {
        notification.style.animation = 'slideOutRight 0.3s ease-out';
        setTimeout(() => notification.remove(), 300);
      }
    }, 5000);
  }

  function showAdminNotification() {
    const notificationContainer = document.getElementById('notificationContainer');
    
    const notification = document.createElement('div');
    notification.className = 'verification-notification';
    notification.style.background = 'linear-gradient(135deg, #ddd6fe 0%, #c4b5fd 100%)';
    notification.style.borderColor = '#8b5cf6';
    notification.innerHTML = 
      '<button class="notification-close" onclick="this.parentElement.remove()">&times;</button>' +
      '<div class="notification-header">' +
        '<svg class="notification-icon" fill="currentColor" viewBox="0 0 20 20" style="color: #7c3aed;">' +
          '<path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z"/>' +
          '<path fill-rule="evenodd" d="M4 5a2 2 0 012-2 1 1 0 000 2H6a2 2 0 100 4h2a2 2 0 100-4h-.5a1 1 0 000-2H8a2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5z" clip-rule="evenodd"/>' +
        '</svg>' +
        '<span class="notification-title" style="color: #6b21a8;">管理员操作</span>' +
      '</div>' +
      '<div class="notification-body" style="color: #6b21a8;">' +
        '已使用管理员权限删除域名' +
      '</div>';
    
    notificationContainer.appendChild(notification);
    
    // 5秒后自动关闭
    setTimeout(() => {
      if (notification.parentElement) {
        notification.style.animation = 'slideOutRight 0.3s ease-out';
        setTimeout(() => notification.remove(), 300);
      }
    }, 5000);
  }

  function showVerificationModal(domain) {
    currentDomain = domain;
    document.getElementById('verificationMessage').innerHTML = 
      '请输入验证码以删除域名: <strong>' + domain + '</strong><br><br>' +
      '注意：验证码只在添加域名时显示一次，请妥善保存。<br>' +
      '<small style="color: #dc2626;">管理员可使用管理员验证码删除任意域名</small>';
    document.getElementById('verificationInput').value = '';
    document.getElementById('verificationModal').style.display = 'block';
    document.getElementById('verificationInput').focus();
  }

  function closeVerificationModal() {
    document.getElementById('verificationModal').style.display = 'none';
    currentDomain = '';
  }

  // 确认删除按钮事件
  document.getElementById('confirmVerificationBtn').addEventListener('click', async () => {
    const code = document.getElementById('verificationInput').value.trim();
    
    if (!code) {
      statusDiv.textContent = '❌ 验证码不能为空';
      return;
    }

    try {
      const response = await fetch('/api/domains/' + encodeURIComponent(currentDomain) + '/' + encodeURIComponent(code), { method: 'DELETE' });
      const data = await response.json();
      
      if (!response.ok) {
        if (response.status === 401) {
          showErrorNotification('验证码错误，请检查后重试');
          // 清空输入框并重新聚焦
          document.getElementById('verificationInput').value = '';
          document.getElementById('verificationInput').focus();
        } else {
          showErrorNotification(data.error || '删除失败');
        }
        return;
      }
      
      statusDiv.textContent = '✨ ' + data.message;
      
      // 如果是管理员操作，显示特殊通知
      if (data.message && data.message.includes('管理员操作')) {
        showAdminNotification();
      }
      
      closeVerificationModal();
      loadDomains();
    } catch (error) {
      statusDiv.textContent = '❌ 删除域名失败: ' + error.message;
    }
  });

  // 点击弹窗外部关闭
  window.onclick = function(event) {
    const modal = document.getElementById('verificationModal');
    if (event.target == modal) {
      closeVerificationModal();
    }
  }

  // 回车键确认
  document.getElementById('verificationInput').addEventListener('keypress', function(event) {
    if (event.key === 'Enter') {
      document.getElementById('confirmVerificationBtn').click();
    }
  });

  loadDomains();
`;

function getHtmlPage() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KeepAlive Worker - 操作面板</title>
  <style>${HTML_STYLE}</style>
</head>
<body>
  <div class="main-container">
    <div class="header">
      <h1>KeepAlive Worker ⚡</h1>
      <p class="subtitle">一个用于防止网站休眠的简单工具</p>
      <button id="triggerButton" class="trigger-button">手动触发保活任务</button>
      <div id="status">点击按钮开始手动测试保活功能</div>
    </div>

    <div class="domains-section">
      <h2 class="section-title">🌐 域名管理</h2>
      <div class="domain-input-group">
        <div class="domain-input-wrapper">
          <label class="input-label">域名</label>
          <input type="text" id="domainInput" class="domain-input" placeholder="输入域名，如: https://example.com">
        </div>
        <div class="interval-input-wrapper">
          <label class="input-label">保活间隔</label>
          <input type="number" id="intervalInput" class="interval-input" min="1" max="1440" value="5" placeholder="分钟">
        </div>
        <button id="addDomainBtn" class="add-domain-btn">添加域名</button>
      </div>
      <div id="domainsList" class="domain-list">
        <div class="loading">加载中...</div>
      </div>
    </div>

    <div id="resultsSection" class="results-section">
      <h2 class="section-title">执行结果</h2>
      <div id="results" class="results-container"></div>
    </div>

    <div class="usage-panel">
      <h2 class="section-title">💡 配置与使用指南</h2>
      <div class="usage-content">
        <p><strong>域名管理说明：</strong></p>
        <p>现在您可以直接通过前端界面管理要保活的网站域名，无需手动编辑环境变量。添加的域名会自动保存到Redis数据库中。</p>

        <p><strong>设置定时计划 (必需)</strong></p>
        <p>系统会根据环境变量中的CRON_SCHEDULE设置自动执行保活任务，默认为每5分钟执行一次。</p>

        <p><strong>可选配置：</strong></p>
        <p>以下为可选的环境变量，不设置也能正常工作：</p>
        <ul>
          <li><code>RETRY_COUNT</code>: 访问失败后的重试次数。默认为 2 次。</li>
          <li><code>RETRY_DELAY</code>: 每次重试的间隔时间（单位：毫秒）。默认为 2000 (即2秒)。</li>
        </ul>

        <hr>

        <p><strong>常见问题解答 (FAQ)</strong></p>
        <ul>
            <li><strong>问：我需要一直开着这个网页吗？</strong><br>
                答：完全不需要。真正的保活任务是在后台根据定时计划自动运行的。这个页面只是一个方便您手动测试和检查配置的工具。</li>
            <li><strong>问：手动触发和自动执行有什么区别？</strong><br>
                答：手动触发（点击按钮）是立即执行一次保活任务，方便您测试。自动执行是系统在后台根据您设定的时间自动运行，这是实现保活的核心。</li>
            <li><strong>问：如何检查后台运行情况？</strong><br>
                答：您可以查看控制台日志来了解后台任务的执行情况。</li>
            <li><strong>问：域名数据保存在哪里？</strong><br>
                答：域名数据保存在Redis数据库中，确保数据的持久化和可靠性。</li>
        </ul>
      </div>
    </div>
  </div>

  <!-- 日志模态框 -->
  <div id="logsModal" class="logs-modal">
    <div class="logs-modal-content">
      <div class="logs-modal-header">
        <h2 id="logsModalTitle" class="logs-modal-title">域名日志</h2>
        <span id="closeLogsModal" class="close-logs-modal">&times;</span>
      </div>
      <div id="logsContent">
        <table class="logs-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>状态</th>
              <th>状态码</th>
              <th>尝试次数</th>
              <th>错误信息</th>
            </tr>
          </thead>
          <tbody id="logsTableBody">
            <!-- 日志条目将通过JavaScript动态添加 -->
          </tbody>
        </table>
      </div>
      <div class="logs-actions">
        <button id="clearLogsBtn" class="clear-logs-btn">清空日志</button>
      </div>
    </div>
  </div>

  <!-- 验证码通知容器 -->
  <div id="notificationContainer"></div>
  
  <!-- 验证码弹窗 -->
  <div id="verificationModal" class="verification-modal">
    <div class="verification-modal-content">
      <div class="verification-modal-header">
        <h3 class="verification-modal-title">输入验证码</h3>
        <span class="close-verification-modal" onclick="closeVerificationModal()">&times;</span>
      </div>
      <div class="verification-modal-body">
        <p class="verification-message" id="verificationMessage">请输入验证码以删除此域名：</p>
        <input type="text" id="verificationInput" class="verification-input" placeholder="请输入验证码" maxlength="20">
      </div>
      <div class="verification-modal-footer">
        <button class="verification-cancel-btn" onclick="closeVerificationModal()">取消</button>
        <button class="verification-confirm-btn" id="confirmVerificationBtn">确认删除</button>
      </div>
    </div>
  </div>

  <!-- 底部链接 -->
  <div class="footer">
    <p>
      <a href="https://github.com/15515151/keep-alive-worker" target="_blank" rel="noopener noreferrer">
        📂 KeepAlive Worker - GitHub项目
      </a>
    </p>
    <div class="verification-help">
      <strong>忘记验证码？</strong> 如果您忘记了域名的删除验证码，请前往GitHub项目页面提交Issue，联系管理员协助删除域名。
    </div>
  </div>

  <script>${HTML_SCRIPT}</script>
</body>
</html>`;
}

// API路由
app.get('/', (req, res) => {
  res.send(getHtmlPage());
});

app.post('/run-tasks', async (req, res) => {
  const config = await initializeConfig();
  const taskReport = await executeAllWakeups(config);
  res.json({
    timestamp: getLocalTimestamp(),
    summary: taskReport.summary,
    results: taskReport.outcomes,
  });
});

app.get('/api/domains', async (req, res) => {
  const config = await initializeConfig();
  if (config.redisClient) {
    const domains = await config.redisClient.getDomains();
    // 获取每个域名的完整配置信息
    const domainConfigs = await config.redisClient.getAllDomainConfigs();
    
    // 合并验证码信息到配置中，但不返回验证码
    const result = domainConfigs.map(domainConfig => {
      const domainEntry = domains.find(d => d.domain === domainConfig.domain);
      return {
        domain: domainConfig.domain, // 确保domain是字符串
        interval: domainConfig.interval,
        lastChecked: domainConfig.lastChecked,
        nextCheckTime: domainConfig.nextCheckTime
        // 不返回验证码和添加时间，保持安全性
      };
    });
    
    res.json({ domains: result });
  } else {
    res.status(500).json({ error: config.error });
  }
});

app.post('/api/domains', async (req, res) => {
  const config = await initializeConfig();
  if (!config.redisClient) {
    return res.status(500).json({ error: 'Redis未配置' });
  }

  try {
    const { domain, interval } = req.body;
    
    if (!domain) {
      return res.status(400).json({ error: '域名不能为空' });
    }

    const result = await config.redisClient.addDomain(domain, interval || 5);
    if (result.success) {
      const domains = await config.redisClient.getDomains();
      // 过滤掉验证码和添加时间，防止泄露
      const safeDomains = domains.map(d => ({
        domain: d.domain
        // 不返回验证码和添加时间
      }));
      res.json({ 
        message: '域名添加成功', 
        domains: safeDomains,
        verificationCode: result.verificationCode
      });
    } else {
      res.status(500).json({ error: result.error || '添加域名失败' });
    }
  } catch (error) {
    res.status(400).json({ error: '请求格式错误' });
  }
});

app.get('/api/domains/:domain/config', async (req, res) => {
  const config = await initializeConfig();
  if (!config.redisClient) {
    return res.status(500).json({ error: 'Redis未配置' });
  }

  try {
    const domain = decodeURIComponent(req.params.domain);
    const domainConfig = await config.redisClient.getDomainConfig(domain);
    res.json(domainConfig);
  } catch (error) {
    res.status(500).json({ error: '获取域名配置失败' });
  }
});


app.delete('/api/domains/:domain/:verificationCode', async (req, res) => {
  const config = await initializeConfig();
  if (!config.redisClient) {
    return res.status(500).json({ error: 'Redis未配置' });
  }

  const domain = decodeURIComponent(req.params.domain);
  const verificationCode = decodeURIComponent(req.params.verificationCode);
  const result = await config.redisClient.removeDomain(domain, verificationCode);

  if (result.success) {
        const domains = await config.redisClient.getDomains();
        // 过滤掉验证码和添加时间，防止泄露
        const safeDomains = domains.map(d => ({
          domain: d.domain
          // 不返回验证码和添加时间
        }));
        const message = result.isAdmin ? '域名删除成功（管理员操作）' : '域名删除成功';
        res.json({ message, domains: safeDomains });
      } else {
        // 验证码错误返回401，其他错误返回400
        const statusCode = result.error && result.error.includes('验证码错误') ? 401 : 400;
        res.status(statusCode).json({ error: result.error || '删除域名失败' });
      }
});

// 获取域名日志
app.get('/api/domains/:domain/logs', async (req, res) => {
  const config = await initializeConfig();
  if (!config.redisClient) {
    return res.status(500).json({ error: 'Redis未配置' });
  }

  const domain = decodeURIComponent(req.params.domain);
  const limit = parseInt(req.query.limit) || 20;

  const logs = await config.redisClient.getDomainLogs(domain, limit);

  res.json({
    domain,
    logs,
    count: logs.length
  });
});

// 清空域名日志
app.delete('/api/domains/:domain/logs', async (req, res) => {
  const config = await initializeConfig();
  if (!config.redisClient) {
    return res.status(500).json({ error: 'Redis未配置' });
  }

  const domain = decodeURIComponent(req.params.domain);
  const success = await config.redisClient.clearDomainLogs(domain);

  if (success) {
    res.json({ message: '日志清空成功' });
  } else {
    res.status(500).json({ error: '清空日志失败' });
  }
});

// 定时任务
async function runScheduledTask() {
  console.log(`[定时任务] 触发于: ${getLocalTimestamp()}`);
  const config = await initializeConfig();

  if (config.redisClient) {
    const domainConfigs = await config.redisClient.getAllDomainConfigs();
    const currentTime = new Date();

    for (const domainConfig of domainConfigs) {
      const shouldCheck = await shouldCheckDomain(domainConfig, currentTime);
      if (shouldCheck) {
        console.log(`[保活任务] 检查域名: ${domainConfig.domain} (间隔: ${domainConfig.interval}分钟)`);

        // 为单个域名执行保活任务
        const singleConfig = {
          ...config,
          domains: [domainConfig.domain]
        };

        const taskReport = await executeAllWakeups(singleConfig);

        // 更新最后检查时间
        await config.redisClient.updateDomainLastChecked(domainConfig.domain);

        // 记录结果
        if (taskReport.outcomes.length > 0) {
          const result = taskReport.outcomes[0];
          const icon = result.status === '成功' ? '✅' : '❌';
          const details = result.error ? `错误: ${result.error}` : `状态码: ${result.statusCode}`;
          console.log(`${icon} ${result.domain} | 状态: ${result.status} | 尝试: ${result.attempts}次 | ${details}`);
        }
      } else {
        console.log(`[跳过] 域名 ${domainConfig.domain} 未到达保活时间`);
      }
    }
  } else {
    // 如果没有Redis，使用原来的逻辑
    const taskReport = await executeAllWakeups(config);
    logTaskResults(taskReport);
  }

  console.log(`[定时任务] 执行完毕。`);
}

// 检查是否需要检查该域名
async function shouldCheckDomain(domainConfig, currentTime) {
  // 如果从未检查过，需要检查
  if (!domainConfig.lastChecked) {
    return true;
  }

  const lastChecked = new Date(domainConfig.lastChecked);
  const minutesSinceLastCheck = (currentTime - lastChecked) / (1000 * 60);

  // 如果距离上次检查的时间超过了设定的间隔，需要检查
  return minutesSinceLastCheck >= domainConfig.interval;
}

// 启动服务器
async function startServer() {
  try {
    // 初始化Redis连接
    const config = await initializeConfig();
    if (config.redisClient) {
      console.log('Redis连接已建立');
    }

    // 启动定时任务
    const cronSchedule = process.env.CRON_SCHEDULE || '*/1 * * * *'; // 更改为每分钟执行一次
    cron.schedule(cronSchedule, runScheduledTask);
    console.log(`定时任务已启动，执行计划: ${cronSchedule}`);

    // 启动服务器
    app.listen(PORT, () => {
      console.log(`服务器运行在 http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('服务器启动失败:', error);
    process.exit(1);
  }
}

startServer();