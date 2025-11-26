# 保活脚本 (Keep Alive Worker)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/canaan723/keep-alive-worker)

一个 Cloudflare Worker 脚本，通过定期访问指定域名，可以防止 Render 等平台的免费服务因无人访问而休眠。

## ✨ 特性

- **一键部署**: 通过 Cloudflare Workers 轻松部署。
- **定时触发**: 按预设的计划（默认为每 5 分钟）自动执行。
- **多目标支持**: 可同时保活多个服务的 URL。
- **手动触发**: 提供一个简单的网页界面，用于手动触发验证保活任务。
- **零成本**: 完全在 Cloudflare Workers 的免费套餐内运行。

## 🚀 部署指南

### 准备工作

1.  一个 **GitHub** 账号: [点此注册](https://github.com/signup).
2.  一个 **Cloudflare** 账号: [点此注册](https://dash.cloudflare.com/sign-up).

### 一键部署步骤

1.  点击上方的 "Deploy with Workers" 按钮或 [此链接](https://deploy.workers.cloudflare.com/?url=https://github.com/canaan723/keep-alive-worker) 开始部署。
2.  授权 Cloudflare 访问你的 GitHub 账号。建议选择授权 **All repositories** (所有仓库)。
    <img src="https://pub-88bc3c02afca49d3a2111ca780bf4061.r2.dev/blog/2025/10/20251020162954076.webp" alt="授权 Cloudflare 访问 GitHub" width="500">
3.  在部署页面，勾选 **创建专用 Git 存储库** 复选框，这将为你的项目创建一个私有仓库。
4.  在 **配置环境变量** 部分，设置 `URLS` 变量，填入你需要保活的服务地址。
    - **注意**: 值必须是 JSON 数组格式。
    - **示例**: `["https://service1.com", "https://service2.com"]`
    <img src="https://pub-88bc3c02afca49d3a2111ca780bf4061.r2.dev/blog/2025/10/20251018193806744.png" alt="配置环境变量" width="500">
5.  点击 **创建和部署**。部署完成后，页面将自动跳转到 Worker 的管理后台。

## 🛠️ 使用与验证

部署成功后，你可以验证 Worker 是否正常工作。

1.  在 Worker 的管理页面，你可以在 **设置** 选项卡的 **域和路由** 部分找到访问地址，或直接点击右上角的 **访问** 按钮。
    <img src="https://pub-88bc3c02afca49d3a2111ca780bf4061.r2.dev/blog/2025/10/20251018194259291.png" alt="访问 Worker 地址" width="500">
2.  打开的页面中，点击 **手动触发保活任务** 按钮来测试脚本。
3.  检查执行结果。如果出现失败，请返回 Worker 管理页面检查 `URLS` 环境变量的配置是否正确。
    <img src="https://pub-88bc3c02afca49d3a2111ca780bf4061.r2.dev/blog/2025/10/20251018194343672.png" alt="手动触发界面" width="500">

默认情况下，该 Worker 会每 5 分钟自动运行一次。

## 📜 查看日志

如果遇到问题，可以通过查看日志来排查。

1.  进入 Worker 管理页面的 **Observability** 选项卡。
2.  在这里你可以看到所有的执行记录，包括手动触发和定时触发。
    - `fetch - POST`: 手动触发的记录。
    - `cron - */5 * * * *`: 定时任务触发的记录。
3.  点击任意一条记录即可展开查看详细的日志输出。

<img src="https://pub-88bc3c02afca49d3a2111ca780bf4061.r2.dev/obsidian/2025/09/20250918173628083.png" alt="Cloudflare Worker 日志" width="500">
