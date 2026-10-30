#!/usr/bin/env node
/**
 * 从星邮上游（Cortico World 扩展）同步源码，并打上「DSH 可运行」的两处补丁。
 *
 * 用法：
 *   node build.mjs                       # 默认从 ~/.dsh/ext-src/starpost 同步
 *   STARDIR=/path/to/starpost node build.mjs
 *
 * 为什么要打补丁：Node 24 的「只擦除类型」模式不支持 TypeScript 的参数属性
 * （constructor(private readonly x: T)），星邮有两处用到。补丁把它们改成
 * 显式形参 + 构造体内赋值，语义完全等价，其余源码一字不改。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SRC = process.env.STARDIR || join(process.env.HOME || '', '.dsh', 'ext-src', 'starpost')
const VENDOR = join(ROOT, 'vendor')

if (!existsSync(join(SRC, 'src', 'world.ts'))) {
  console.error(`找不到星邮源码：${SRC}\n用 STARDIR=<starpost 目录> 指定。`)
  process.exit(1)
}

// ── 1. 拷源码与静态资源 ────────────────────────────────────────────
rmSync(VENDOR, { recursive: true, force: true })
mkdirSync(join(VENDOR, 'starpost'), { recursive: true })
for (const file of ['world.ts', 'config.ts', 'notifications.ts', 'quota.ts', 'stickers.ts', 'ENV_PROMPT.md']) {
  cpSync(join(SRC, 'src', file), join(VENDOR, 'starpost', file))
}
cpSync(join(SRC, 'package.json'), join(VENDOR, 'package.json'))
if (existsSync(join(SRC, 'emoji'))) cpSync(join(SRC, 'emoji'), join(VENDOR, 'emoji'), { recursive: true })

// ── 2. 两处参数属性 → 显式赋值 ─────────────────────────────────────
const PATCHES = [
  {
    file: 'starpost/world.ts',
    from: '  constructor(private readonly cfg: StarpostConfigSection, private readonly botDir: string, _packageDir: string, private readonly dataDir: string, private readonly timezone: string, private readonly secret: (name: string) => string, private readonly clock: () => number = Date.now, private readonly extensionVersion: () => unknown = () => JSON.parse(readFileSync(STARPOST_PACKAGE_FILE, \'utf8\')).version) {',
    to: `  constructor(cfg: StarpostConfigSection, botDir: string, _packageDir: string, dataDir: string, timezone: string, secret: (name: string) => string, clock: () => number = Date.now, extensionVersion: () => unknown = () => JSON.parse(readFileSync(STARPOST_PACKAGE_FILE, 'utf8')).version) {
    this.cfg = cfg; this.botDir = botDir; this.dataDir = dataDir; this.timezone = timezone; this.secret = secret; this.clock = clock; this.extensionVersion = extensionVersion;`,
  },
  {
    file: 'starpost/stickers.ts',
    from: '  constructor(readonly directory: string, private readonly indexFile: string, private readonly qqIndexFile: string,\n    private readonly maxFiles = 10000, private readonly clock: () => number = Date.now) {',
    to: `  constructor(directory: string, indexFile: string, qqIndexFile: string,
    maxFiles = 10000, clock: () => number = Date.now) {
    this.directory = directory; this.indexFile = indexFile; this.qqIndexFile = qqIndexFile; this.maxFiles = maxFiles; this.clock = clock;`,
  },
]

for (const patch of PATCHES) {
  const path = join(VENDOR, patch.file)
  const text = readFileSync(path, 'utf8')
  if (!text.includes(patch.from)) {
    console.error(`补丁失配：${patch.file}\n上游改了构造函数签名，请更新 build.mjs 里的 PATCHES 再同步。`)
    process.exit(1)
  }
  writeFileSync(path, text.replace(patch.from, patch.to))
}

// ── 3. 把 .ts 编译成 .js ──────────────────────────────────────────
// 为什么必须编译：通过 `dsh plugin add file:xxx.tgz` 安装时，包落在
// `~/.dsh/profiles/web/node_modules/dsh-starpost/` 下，而 Node 拒绝对
// node_modules 里的 .ts 做类型擦除：
//   TypeError: Stripping types is currently unsupported for files under node_modules
// 所以包里只能交付 .js。（用 link: 安装时走的是真实路径，才不会被这条规则拦住。）
import { stripTypeScriptTypes } from 'node:module'

const outDir = join(VENDOR, 'starpost')
const tsFiles = readdirSync(outDir).filter((f) => f.endsWith('.ts'))
for (const file of tsFiles) {
  const ts = readFileSync(join(outDir, file), 'utf8')
  const js = stripTypeScriptTypes(ts, { mode: 'transform' })
    // 上游是 `.ts` 扩展名导入，编译后要改成 `.js`
    .replace(/((?:from|import)\s+['"]\.\/[^'"]+)\.ts(['"])/g, '$1.js$2')
  writeFileSync(join(outDir, file.replace(/\.ts$/, '.js')), js)
  rmSync(join(outDir, file))
}

// ── 4. 冒烟验证 ───────────────────────────────────────────────────
const world = await import(join(outDir, 'world.js'))
const count = world.STARPOST_TOOL_DECLS.length
if (!count) {
  console.error('冒烟失败：工具声明为空。')
  process.exit(1)
}
const version = JSON.parse(readFileSync(join(VENDOR, 'package.json'), 'utf8')).version
console.log(`✓ 同步完成：星邮 ${version}，${count} 个工具`)
console.log(`  ${world.STARPOST_TOOL_DECLS.map((t) => t.name).join(', ')}`)
