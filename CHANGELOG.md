# 更新记录

## 1.0.3

- `package.json` 补 `repository` / `homepage` / `bugs` / `keywords` / `author`（npm 页面和 DSH 插件列表能显示来源）。
- README 补仓库地址、一行安装命令（直接从 GitHub Release 拉）、`scripts/check.sh` 与 CI 说明。

## 1.0.2

- **修：用 tarball 安装会直接崩。** 之前 `vendor/` 交付的是 `.ts` 源码，而通过
  `dsh plugin add file:xxx.tgz` 安装时包落在 `~/.dsh/profiles/web/node_modules/` 下，
  Node 不允许对 node_modules 里的 `.ts` 做类型擦除，启动时抛
  `TypeError: Stripping types is currently unsupported for files under node_modules`。
  现在 `build.mjs` 会用 `module.stripTypeScriptTypes()` 把上游 `.ts` 编译成 `.js` 再交付，
  包里只有 `.js`。（用 `link:` 安装走真实路径，之前不受影响，所以本地一直没暴露。）
- 新增 `CHANGELOG.md`。

## 1.0.1

- 许可从误写的 AGPL-3.0 改成 **MIT**（上游 `cortico-world-starpost` 是 MIT），
  补 `LICENSE` 与 `NOTICE`（含上游署名与改动清单）。
- `engines.node` 修正为 `>=22.18`（22.18 起默认开启类型擦除，更早版本要加 flag）。
- README 修正：工具表按真实 `action` 枚举重写、安装与重启步骤写清楚、补齐已知限制。

## 1.0.0

- 首个版本：把星邮（上游 0.17.4）接进 DSH，17 个工具、合批注入、系统提示词注入、
  `/dsh-starpost/{state,panel,prompt}` 观测面。
