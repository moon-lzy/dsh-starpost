#!/bin/sh
# 本地自检（和 CI 跑的是同一套）。用法：sh scripts/check.sh
set -e
cd "$(dirname "$0")/.."
echo "1/4 语法"; node --check index.js
echo "2/4 vendor 里不许有 .ts（node_modules 下无法擦除类型）"
if find vendor -name '*.ts' | grep -q .; then echo "❌ 发现 .ts，先跑 node build.mjs"; exit 1; fi
echo "✅ 只有 .js"
echo "3/4 冒烟加载 World"
node -e "import('./vendor/starpost/world.js').then(m=>{const names=m.STARPOST_TOOL_DECLS.map(t=>t.name);console.log('工具',names.join(','));if(names.length!==1||names[0]!=='starpost_use')throw new Error('工具入口不对')})"
echo "4/4 打包预演"
# npm 默认往 ~/.npm 写缓存，本机那个目录是 root 的（EPERM，会假报红），
# 用临时缓存，别让权限问题冒充打包失败。
npm_config_cache="${TMPDIR:-/tmp}/dsh-starpost-npm-cache" npm pack --dry-run >/dev/null && echo "✅ 打包正常"
