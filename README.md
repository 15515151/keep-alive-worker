# KeepAlive Worker

一个用于防止网站休眠的简单工具，支持通过Web界面管理域名列表，使用Redis存储数据。

## 功能特性

- 🌐 可视化域名管理界面
- 🔄 自动定时保活任务
- 💾 Redis数据持久化存储
- 📊 实时执行结果展示
- 🐳 Docker容器化部署
- ⚡ 支持自定义重试策略

## 快速开始

### 本地开发

1. **安装依赖**
   ```bash
   npm install
   ```

2. **配置环境变量**
   复制并编辑 `.env` 文件：
   ```bash
   cp .env.example .env
   ```
   
   编辑 `.env` 文件，配置Redis连接信息：
   ```env
   # Redis连接配置
   REDIS_HOST=sjc1.clusters.zeabur.com
   REDIS_PORT=20248
   REDIS_PASSWORD=5wREB627txe4Hj9KdN8Qz0Js3oVhm1qT
   
   # 服务器配置
   PORT=3000
   
   # 保活配置
   RETRY_COUNT=2
   RETRY_DELAY=2000
   
   # 定时任务配置（cron表达式）
   CRON_SCHEDULE=*/5 * * * *
   ```

3. **启动服务**
   ```bash
   npm start
   ```
   
   或使用开发模式（自动重启）：
   ```bash
   npm run dev
   ```

4. **访问应用**
   打开浏览器访问 `http://localhost:3000`

### Docker部署

#### 使用Docker Compose（推荐）

1. **启动服务**
   ```bash
   docker-compose up -d
   ```

2. **查看日志**
   ```bash
   docker-compose logs -f
   ```

3. **停止服务**
   ```bash
   docker-compose down
   ```

#### 使用Docker

1. **构建镜像**
   ```bash
   docker build -t keep-alive-worker .
   ```

2. **运行容器**
   ```bash
   docker run -d \
     --name keep-alive-worker \
     -p 3000:3000 \
     -e REDIS_HOST=your_redis_host \
     -e REDIS_PORT=6379 \
     -e REDIS_PASSWORD=your_redis_password \
     keep-alive-worker
   ```

## 环境变量说明

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `REDIS_HOST` | Redis服务器地址 | - |
| `REDIS_PORT` | Redis服务器端口 | 6379 |
| `REDIS_PASSWORD` | Redis密码 | - |
| `PORT` | 应用服务端口 | 3000 |
| `RETRY_COUNT` | 访问失败重试次数 | 2 |
| `RETRY_DELAY` | 重试间隔时间（毫秒） | 2000 |
| `CRON_SCHEDULE` | 定时任务cron表达式 | `*/5 * * * *` |
| `TARGET_DOMAINS` | 备用域名配置（JSON数组） | - |

## API接口

### 域名管理

- `GET /api/domains` - 获取域名列表
- `POST /api/domains` - 添加域名
  ```json
  {
    "domain": "https://example.com"
  }
  ```
- `DELETE /api/domains/{domain}` - 删除域名

### 任务执行

- `POST /run-tasks` - 手动触发保活任务

## 部署到容器平台

### 部署到Zeabur

1. 创建Redis服务
2. 部署此应用，设置环境变量：
   - `REDIS_HOST`: Redis服务地址
   - `REDIS_PORT`: Redis服务端口
   - `REDIS_PASSWORD`: Redis密码

### 部署到Railway

1. 添加Redis插件
2. 部署应用，自动注入Redis连接信息

### 部署到其他平台

确保平台支持：
- Node.js 18+
- Redis连接
- 环境变量配置

## 常见问题

### Q: 如何修改定时任务频率？
A: 修改环境变量 `CRON_SCHEDULE`，使用标准cron表达式。

### Q: Redis连接失败怎么办？
A: 检查Redis服务是否正常运行，网络是否可达，密码是否正确。

### Q: 如何查看后台任务执行情况？
A: 查看应用日志，或通过Web界面手动触发测试。

## 许可证

MIT License