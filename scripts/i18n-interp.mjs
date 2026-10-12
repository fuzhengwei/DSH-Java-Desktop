#!/usr/bin/env node
/**
 * i18n interp: 把含中文的带插值模板串替换为 t("key", { v0, v1, ... })，
 * 模板文本中的插值位置以 {{v0}} 占位登记进 zh-CN.json。
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
const ZH_PATH = path.join(SRC, "i18n", "locales", "zh-CN.json");

const hasCJK = (s) => /[\u4e00-\u9fff]/.test(s);

const zh = JSON.parse(fs.readFileSync(ZH_PATH, "utf8"));

function walk(d, acc) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name === "i18n") continue;
      walk(f, acc);
    } else if (/\.(tsx?|ts)$/.test(e.name)) acc.push(f);
  }
  return acc;
}

const files = walk(SRC, []);
let totalNew = 0;
let filesChanged = 0;

for (const file of files) {
  const code = fs.readFileSync(file, "utf8");
  let ast;
  try {
    ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
  } catch { continue; }

  const base = path.basename(file).replace(/\.tsx?$/, "");
  // 该文件当前最大序号
  let maxIdx = -1;
  const keyRe = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)$`);
  for (const k of Object.keys(zh)) {
    const m = k.match(keyRe);
    if (m) maxIdx = Math.max(maxIdx, parseInt(m[1], 10));
  }
  let counter = maxIdx + 1;

  const edits = [];
  traverse(ast, {
    TemplateLiteral(p) {
      const node = p.node;
      if (node.expressions.length === 0) return;
      const parts = node.quasis.map((q) => q.value.raw);
      if (!parts.some(hasCJK)) return;
      // 跳过 t() 的参数
      if (p.parent.type === "CallExpression" && p.parent.callee.type === "Identifier" && p.parent.callee.name === "t") return;
      edits.push({ path: p, parts, exprs: node.expressions });
    },
  });

  if (edits.length === 0) continue;

  // 确保文件内有 t 绑定（此前 fixup 已注入，双保险）
  let hasT = false;
  traverse(ast, {
    Program(p) { hasT = !!p.scope.bindings.t; },
  });
  if (!hasT) {
    const rel = path.relative(SRC, file);
    const depth = rel.split(path.sep).length - 1;
    const importPath = depth === 0 ? "./i18n" : "../".repeat(depth) + "i18n";
    const imp = t.importDeclaration(
      [t.importDefaultSpecifier(t.identifier("i18n"))],
      t.stringLiteral(importPath),
    );
    ast.program.body.unshift(imp);
    const bindDecl = t.variableDeclaration("const", [
      t.variableDeclarator(
        t.identifier("t"),
        t.callExpression(
          t.memberExpression(t.memberExpression(t.identifier("i18n"), t.identifier("t")), t.identifier("bind")),
          [t.identifier("i18n")],
        ),
      ),
    ]);
    let lastImportIdx = -1;
    ast.program.body.forEach((n, i) => { if (t.isImportDeclaration(n)) lastImportIdx = i; });
    ast.program.body.splice(lastImportIdx + 1, 0, bindDecl);
  }

  for (const e of edits) {
    const key = `${base}.${counter++}`;
    // 模板文本：quasis[i] + {{vi}}
    let tmpl = "";
    for (let i = 0; i < e.parts.length; i++) {
      tmpl += e.parts[i];
      if (i < e.exprs.length) tmpl += `{{v${i}}}`;
    }
    zh[key] = tmpl;
    totalNew++;

    // 替换：t("key", { v0: expr0, v1: expr1, ... })
    const objProps = e.exprs.map((expr, i) =>
      t.objectProperty(t.identifier(`v${i}`), expr),
    );
    const call = t.callExpression(t.identifier("t"), [
      t.stringLiteral(key),
      t.objectExpression(objProps),
    ]);
    // JSXAttribute 值位置需包表达式容器
    if (e.path.parent?.type === "JSXAttribute") {
      e.path.replaceWith(t.jsxExpressionContainer(call));
    } else {
      e.path.replaceWith(call);
    }
  }

  fs.writeFileSync(file, generate(ast, { compact: false, jsescOption: { minimal: true } }).code, "utf8");
  filesChanged++;
}

fs.writeFileSync(ZH_PATH, JSON.stringify(zh, null, 2) + "\n");
console.log(`files changed: ${filesChanged}`);
console.log(`new keys: ${totalNew}`);
console.log(`total keys: ${Object.keys(zh).length}`);
