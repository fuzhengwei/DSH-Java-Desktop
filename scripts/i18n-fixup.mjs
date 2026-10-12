#!/usr/bin/env node
/**
 * i18n fixup: 为所有使用了 t("...") 但缺少 hook 声明的组件文件
 * 注入 const { t } = useTranslation(); 到每个包含 t() 调用的函数体开头。
 * 同时处理：非组件模块（如 lib/*.ts）改用全局 i18n.t 导入。
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "i18n") continue;
      walk(full);
    } else if (/\.(tsx|ts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
}
walk(SRC);

let fixed = 0;

for (const file of files) {
  const code = fs.readFileSync(file, "utf8");
  if (!/\bt\(\s*["']/.test(code) && !/\bt\(/.test(code)) continue;
  // 快速排除：已有 hook 声明的文件（粗判）
  const rel = path.relative(SRC, file);

  const ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });

  // 判断该文件是否在 JSX/React 组件上下文（.tsx 或含 JSX 节点）
  let hasJSX = file.endsWith(".tsx");

  // 找出所有自由 t 标识符引用（未被局部声明遮蔽的）
  // 简化策略：
  // 1) 收集所有 scope 中名为 t 的 binding
  // 2) 若文件顶层 scope 无 t binding，且存在 t() 调用 → 需要注入
  let hasGlobalT = false;
  let tCallCount = 0;

  traverse(ast, {
    Program(p) {
      hasGlobalT = !!p.scope.bindings.t;
    },
    CallExpression(p) {
      if (t.isIdentifier(p.node.callee, { name: "t" })) {
        // 检查该 t 是否解析到全局（未绑定 = 自由变量）
        const binding = p.scope.getBinding("t");
        if (!binding) tCallCount++;
      }
    },
  });

  if (tCallCount === 0 || hasGlobalT) continue;

  // 统一策略：模块级导入 i18n 并绑定 t（适用于组件与工具函数，
  // 且支持模块顶层的常量数组调用；语言在启动时由系统 locale 决定）
  const depth = rel.split(path.sep).length - 1;
  const importPath = depth === 0 ? "./i18n" : "../".repeat(depth) + "i18n";
  let hasI18nImport = false;
  traverse(ast, {
    ImportDeclaration(p) {
      if (p.node.source.value.endsWith("/i18n") || p.node.source.value === "i18n") {
        hasI18nImport = true;
      }
    },
  });
  if (!hasI18nImport) {
    const imp = t.importDeclaration(
      [t.importDefaultSpecifier(t.identifier("i18n"))],
      t.stringLiteral(importPath),
    );
    ast.program.body.unshift(imp);
  }
  const bindDecl = t.variableDeclaration("const", [
    t.variableDeclarator(
      t.identifier("t"),
      t.callExpression(
        t.memberExpression(
          t.memberExpression(t.identifier("i18n"), t.identifier("t")),
          t.identifier("bind"),
        ),
        [t.identifier("i18n")],
      ),
    ),
  ]);
  let lastImportIdx = -1;
  ast.program.body.forEach((n, i) => {
    if (t.isImportDeclaration(n)) lastImportIdx = i;
  });
  ast.program.body.splice(lastImportIdx + 1, 0, bindDecl);

  fs.writeFileSync(file, generate(ast, { compact: false, jsescOption: { minimal: true } }).code, "utf8");
  fixed++;
  console.log(`[module] ${rel}`);
}

console.log(`fixed files: ${fixed}`);
