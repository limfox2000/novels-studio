# 贡献指南

感谢参与 novels-studio。请先阅读以下约定，再提交 Issue 或 Pull Request。

## 开发环境

```bash
pnpm install
python -m pip install -r requirements.txt
pnpm build
```

本地联调：

```bash
python server.py     # 8768
pnpm dev             # 5173，/api 自动代理到 8768
```

模型与生图配置见 README 的「配置」一节。没有配置时，画布与本地存档仍可正常使用。

## 提交规范

- 一个 PR 聚焦一件事，避免夹带无关重构。
- 提交信息使用 `<type>(<scope>) <summary>`，例如 `feat(书架) 支持更换封面`；类型可用 `feat` / `fix` / `refactor` / `docs` / `chore`。
- 涉及交互或视觉变更时，请在 PR 描述中附截图或录屏。
- 改动生成协议、存档结构或编辑记忆模板时，请说明向后兼容策略与验证方式。

## 安全红线

- **绝不提交**真实 API Key、服务器地址、SSH 凭据、`.env` 或 `*config.json`。
- 新增外部服务调用必须经过 `server.py` 代理，不要在浏览器端硬编码密钥。
- 发现安全问题时不要开公开 Issue，请按 [SECURITY.md](SECURITY.md) 私下报告。

## 代码风格

- TypeScript 严格模式，`pnpm build` 必须通过。
- 复用 `src/components/ui/` 的设计系统原语；图标使用 `lucide-react` 具名导入。
- 状态逻辑放在 stores/engines/services，组件尽量只负责展示与交互。
- 保持中文界面文案与现有术语一致（作品、画布、节点、卷、章节、编辑室等）。

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。技术分歧请就事论事，人身攻击与骚扰不受欢迎。

## 许可证

提交贡献即表示同意以项目的 [MIT License](LICENSE) 授权你的贡献。
