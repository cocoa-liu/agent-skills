# Agent Skills · 团队常用技能库

把重复使用的 AI 工作流程整理成可安装、可复用的 skill。先按场景找到工具，再复制示例开始使用。

当前提供 **Codex** 的安装与调用说明；其他客户端尚未完成适配验证。首批技能从已有自定义技能导入，处于团队试用阶段。

## 按场景选择

| 我想做什么 | Skill | 需要提供 | 可以得到 |
| --- | --- | --- | --- |
| 审查一个 PR，检查代码位置、模块归属和项目规范 | [PR 代码审查](skills/pr-code-review/SKILL.md) · `pr-code-review` | PR 链接，或当前仓库的 PR 编号 | 有文件位置和证据的审查报告、可复制的评论草稿；默认不发布评论，不审查测试质量 |
| 看懂一个 PR、模块或仓库，并能继续维护 | [源码阅读导读](skills/code-reading-guide/SKILL.md) · `code-reading-guide` | PR 链接或本地仓库路径，以及想理解的范围 | 含真实源码、执行过程和理解检查的离线 HTML；PR 支持逐行标色、批注与进度保存 |

维护人：[@cocoa-liu](https://github.com/cocoa-liu)。每个新 skill 都应在本表说明用途、输入和产物。

## 开始使用

以下命令适用于 macOS / Linux，需要 Git、Python 3.10+ 和 Codex。读取 GitHub PR 时，建议安装并登录 GitHub CLI（`gh auth login`），或使用已连接的代码平台工具。私有仓库需要先获得访问权限。

### 1. 获取仓库

```bash
git clone git@github.com:cocoa-liu/agent-skills.git
cd agent-skills
```

### 2. 只安装需要的 skill

```bash
# 查看可用技能
python3 scripts/install.py --list

# 安装 PR 审查；默认目标是 ~/.agents/skills
python3 scripts/install.py pr-code-review

# 需要源码导读时再安装
python3 scripts/install.py code-reading-guide
```

安装器创建指向本地仓库的软链接，已有同名目录或指向其他位置的链接会报错，不会覆盖。请保留克隆目录。

Codex 支持从 `~/.agents/skills` 加载用户级技能，也支持在项目的 `.agents/skills` 中加载技能及软链接。安装后未出现时可重启 Codex。见 [OpenAI 官方技能说明](https://learn.chatgpt.com/docs/build-skills)。

如只想在某个项目使用，可以指定目标目录：

```bash
python3 scripts/install.py --target /path/to/project/.agents/skills pr-code-review
```

项目内的安装链接指向本机路径，不适合直接提交给同事共用；同事应在各自机器安装。Windows 用户可手动把所需的整个 `skills/<名称>` 文件夹复制到用户目录下的 `.agents/skills/`，更新时同步替换该文件夹。

### 3. 在 Codex 对话里调用

审查 PR：

```text
使用 $pr-code-review 审查这个 PR：<PR 链接>。
重点检查代码位置、模块归属和项目规范，输出审查结果和评论草稿。
```

读懂代码：

```text
使用 $code-reading-guide 带我读这个 PR：<PR 链接>。
我对这个模块不熟悉，请从整体流程讲起，生成可以离线打开和批注的 HTML。
```

导读生成器使用 Python 标准库和 Git。若要自动检查 HTML 交互，需要另外准备 Node.js、Playwright 和浏览器；未运行浏览器检查时应明确说明。详细数据格式见 [导读数据说明](skills/code-reading-guide/references/guide-data.md)。

## 更新与移除

软链接安装的技能会跟随本地仓库内容更新。在克隆目录执行：

```bash
git pull --ff-only
```

需要固定版本时，检出选定的提交；需要稳定发布时，由维护者发布版本标签。不要把安装目录作为独立副本修改，改动应在仓库中提交 PR。

移除某个软链接安装的 skill，例如 PR 审查：

```bash
unlink "$HOME/.agents/skills/pr-code-review"
```

该命令只移除链接；手动复制安装的目录请先确认内容，再自行移除。

## 常见问题

- **仓库提示不存在**：先确认登录账号拥有私有仓库访问权限，以及 Git 的 SSH 认证已配置。
- **安装提示同名冲突**：查看目标路径，决定保留旧版还是先备份再替换；安装器不会自动替你删除。
- **Codex 中出现重复技能**：检查是否在用户级、项目级或旧的安装位置装过同名技能，选择保留其中一份。
- **源码导读缺少脚本或模板**：需要安装完整文件夹，不能只复制 `SKILL.md`。
- **结果不符合预期**：提 Issue 时附上 skill 名称、仓库提交号、输入示例和预期结果。示例可用最小复现。

## 部门如何共同维护

建议由部门 GitHub Organization 持有仓库，使用 Team 分配访问权限，并指定维护人审核 PR。当前仓库先由 `cocoa-liu` 维护；获得访问权限的同事可按上面的流程安装。

新同事从本页选择场景；贡献者按 [贡献指南](CONTRIBUTING.md) 添加技能和调用示例。先收录经过实际使用的工作流程，再根据反馈扩展目录。若后续需要统一插件安装入口，可以基于此目录打包分发。

## 仓库结构

```text
agent-skills/
├── README.md                   # 场景目录、安装与调用入口
├── CONTRIBUTING.md             # 新增与更新约定
├── scripts/install.py          # 按需安装，检测同名冲突
├── skills/
│   ├── pr-code-review/
│   │   ├── SKILL.md            # 给 AI 的执行说明
│   │   └── agents/openai.yaml
│   └── code-reading-guide/
│       ├── SKILL.md
│       ├── agents/
│       ├── scripts/
│       ├── references/
│       └── assets/
└── .github/                    # 维护人和 PR 模板
```

技能目录统一使用小写英文和连字符；中文名称、场景说明和操作指引放在首页，方便同事浏览。
