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

function initializeConfig(environment) {
  let domains = [];
  let configError = null;

  if (environment.TARGET_DOMAINS) {
    try {
      const parsedDomains = typeof environment.TARGET_DOMAINS === 'string'
        ? JSON.parse(environment.TARGET_DOMAINS)
        : environment.TARGET_DOMAINS;

      if (!Array.isArray(parsedDomains) || parsedDomains.length === 0) {
        throw new Error("必须是一个非空数组。");
      }
      domains = parsedDomains;
    } catch (error) {
      configError = `配置错误: 环境变量 TARGET_DOMAINS 格式不正确。详情: ${error.message}`;
    }
  } else {
    configError = "配置缺失: 环境变量 TARGET_DOMAINS 未设置。";
  }

  const retries = parseInt(environment.RETRY_COUNT, 10);
  const maxRetries = isNaN(retries) ? DEFAULT_CONFIG.retryCount : retries;

  const delay = parseInt(environment.RETRY_DELAY, 10);
  const retryDelay = isNaN(delay) ? DEFAULT_CONFIG.retryDelay : delay;

  return {
    domains,
    retries: maxRetries,
    delay: retryDelay,
    userAgent: DEFAULT_CONFIG.userAgent,
    error: configError,
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
        cf: { cacheTtl: 0 },
      });

      if (response.ok) {
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
  return {
    domain,
    status: "失败",
    statusCode: isHttpError ? lastKnownError.code : null,
    attempts,
    error: isHttpError ? `HTTP 错误: ${lastKnownError.code}` : (lastKnownError ? lastKnownError.message : "未知错误"),
  };
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

function createJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
  });
}

function createHtmlResponse(htmlContent) {
  return new Response(htmlContent, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
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
  .results-section, .usage-panel { width: 100%; background: rgba(255, 255, 255, 0.9); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 24px; padding: 30px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1); }
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
  @media (max-width: 768px) {
    body { padding: 15px; } .header { padding: 30px 25px; } h1 { font-size: 28px; }
    .result-item { flex-wrap: wrap; align-items: center; gap: 8px; } .result-tags { margin-left: 0; }
  }
`;

const HTML_SCRIPT = `
  const triggerButton = document.getElementById('triggerButton');
  const statusDiv = document.getElementById('status');
  const resultsDiv = document.getElementById('results');
  const resultsSection = document.getElementById('resultsSection');

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
    
    <div id="resultsSection" class="results-section">
      <h2 class="section-title">执行结果</h2>
      <div id="results" class="results-container"></div>
    </div>

    <div class="usage-panel">
      <h2 class="section-title">💡 配置与使用指南</h2>
      <div class="usage-content">
        <p><strong>第一步：设置要保活的网站 (必需)</strong></p>
        <p>在 Worker 的 <strong>"设置"</strong> → <strong>"变量和机密"</strong> 页面，添加一个名为 <code>TARGET_DOMAINS</code> 的环境变量。</p>
        <ul>
          <li>
            <strong>单个网站示例：</strong><br>
            复制这行代码，然后把里面的网址换成您自己的：<br>
            <code>["https://www.my-site.com"]</code><button class="copy-code-button">复制</button>
          </li>
          <li>
            <strong>多个网站示例：</strong><br>
            复制这行代码，然后把里面的网址都换成您自己的：<br>
            <code>["https://site-a.com", "https://site-b.com"]</code><button class="copy-code-button">复制</button>
          </li>
        </ul>

        <p><strong>第二步：设置定时计划 (必需)</strong></p>
        <p>在 Worker 的 <strong>"触发器"</strong> 页面，添加一个 <strong>"Cron 触发器"</strong>。这是用来设定脚本自动执行频率的。</p>
        <ul>
          <li>在 “Cron 触发器” 设置中，您可以直接从<strong>下拉列表</strong>中选择一个合适的执行频率（例如 <code>每 5 分钟</code>）。</li>
        </ul>

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
                答：完全不需要。真正的保活任务是在Cloudflare云端根据您的“定时计划”自动运行的。这个页面只是一个方便您手动测试和检查配置的工具。</li>
            <li><strong>问：手动触发和自动执行有什么区别？</strong><br>
                答：手动触发（点击按钮）是立即执行一次保活任务，方便您测试。自动执行（Cron触发器）是系统在后台根据您设定的时间自动运行，这是实现保活的核心。</li>
            <li><strong>问：如何检查后台运行情况？</strong><br>
                答：您可以随时在 Worker 管理界面的 <strong>"日志"</strong> 页面，查看到由 Cron 触发器执行的所有后台任务的详细记录。</li>
        </ul>
      </div>
    </div>
  </div>
  <script>${HTML_SCRIPT}</script>
</body>
</html>`;
}

export default {
  async scheduled(event, env, ctx) {
    console.log(`[定时任务] 触发于: ${getLocalTimestamp()}`);
    const config = initializeConfig(env);
    const taskReport = await executeAllWakeups(config);
    logTaskResults(taskReport);
    console.log(`[定时任务] 执行完毕。`);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return createHtmlResponse(getHtmlPage());
    }

    if (request.method === 'POST' && url.pathname === '/run-tasks') {
      const config = initializeConfig(env);
      const taskReport = await executeAllWakeups(config);
      return createJsonResponse({
        timestamp: getLocalTimestamp(),
        summary: taskReport.summary,
        results: taskReport.outcomes,
      });
    }

    if (url.pathname === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    return new Response("路径或方法未找到", { status: 404 });
  }
};