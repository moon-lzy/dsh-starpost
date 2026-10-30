#!/bin/sh
# 本地自检（和 CI 跑的是同一套）。用法：sh scripts/check.sh
set -e
cd "$(dirname "$0")/.."
echo "1/4 语法"; node --check index.js
echo "2/4 vendor 里不许有 .ts（node_modules 下无法擦除类型）"
if find vendor -name '*.ts' | grep -q .; then echo "❌ 发现 .ts，先跑 node build.mjs"; exit 1; fi
echo "✅ 只有 .js"
echo "3/4 冒烟加载 World"
node -e "import('./vendor/starpost/world.js').then(m=>{const n=m.STARPOST_TOOL_DECLS.length;console.log('工具数',n);if(n!==17)throw new Error('工具数不对')})"
echo "4/4 打包预演"; npm pack --dry-run >/dev/null && echo "✅ 打包正常"
