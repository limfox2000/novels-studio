# 安全策略

## 报告漏洞

请通过 GitHub 仓库的 **Security → Report a vulnerability**（Security Advisory）私下报告，不要创建公开 Issue。

报告中请包含：

- 受影响的版本或提交；
- 复现步骤与影响范围；
- 如涉及密钥泄露，请说明泄露位置，但**不要在报告中粘贴完整密钥**。

维护者会尽快确认并在修复后公开致谢（如你愿意）。

## 支持范围

仅对默认分支 `main` 的最新代码提供安全修复。

## 部署安全清单

- API Key 只放在服务端 `qwenconfig.json` / `scriptconfig.json` / `imgconfig.json` / `vidconfig.json`，并设置 `chmod 600`。
- 不要提交 `.env`、配置文件或任何真实服务器地址。
- 生产环境使用 HTTPS，并限制后端管理接口的访问来源。
- 定期轮换 API Key；怀疑泄露时立即在服务商侧吊销。
