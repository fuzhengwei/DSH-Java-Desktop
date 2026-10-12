#!/usr/bin/env node
/**
 * i18n codemod: 扫描 src/ 下的 .tsx/.ts，把含中文的字符串字面量、模板串与 JSXText
 * 替换为 t("key") 调用，key 采用扁平命名（文件名.序号），并输出语言包 JSON。
 *
 * 用法: node scripts/i18n-codemod.mjs [--dry]
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
const LOCALES_DIR = path.join(ROOT, "src", "i18n", "locales");
const DRY = process.argv.includes("--dry");

const hasCJK = (s) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(s);

const dict = new Map();
let totalReplaced = 0;
let filesChanged = 0;

function keyFor(file, idx) {
  const base = path.basename(file).replace(/\.(tsx?|jsx?)$/, "");
  return `${base}.${idx}`;
}

const makeTCall = (key) =>
  t.callExpression(t.identifier("t"), [t.stringLiteral(key)]);

/** @returns {import("@babel/types").File | null} 返回修改后的 AST（需要写回），null 表示无改动 */
function processFile(file) {
  const code = fs.readFileSync(file, "utf8");
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });

  let hasUseTranslation = false;
  traverse(ast, {
    ImportDeclaration(p) {
      if (p.node.source.value === "react-i18next") {
        for (const spec of p.node.specifiers) {
          if (spec.imported?.name === "useTranslation") hasUseTranslation = true;
        }
      }
    },
  });

  const edits = [];
  let counter = 0;

  traverse(ast, {
    JSXText(p) {
      const raw = p.node.value;
      if (!raw || !hasCJK(raw)) return;
      const trimmed = raw.trim();
      if (!trimmed) return;
      const key = keyFor(file, counter++);
      edits.push({ type: "jsxtext", path: p, key, zh: trimmed });
    },
    StringLiteral(p) {
      if (!hasCJK(p.node.value)) return;
      if (p.parent.type === "ImportDeclaration") return;
      const key = keyFor(file, counter++);
      edits.push({ type: "string", path: p, key, zh: p.node.value });
    },
    TemplateLiteral(p) {
      if (p.node.expressions.length !== 0) return;
      const raw = p.node.quasis[0].value.raw;
      if (!hasCJK(raw)) return;
      const key = keyFor(file, counter++);
      edits.push({ type: "template", path: p, key, zh: raw });
    },
  });

  if (edits.length === 0) return null;

  for (const e of edits) {
    dict.set(e.key, { zh: e.zh, file: path.relative(SRC, file) });
  }
  totalReplaced += edits.length;

  if (DRY) return null;

  // 遍历结束后统一替换（此刻 replaceWith 安全）
  for (const e of edits) {
    if (e.type === "jsxtext") {
      e.path.replaceWith(t.jsxExpressionContainer(makeTCall(e.key)));
    } else if (e.path.parent?.type === "JSXAttribute") {
      // JSX 属性值不允许直接放调用表达式，需包表达式容器
      e.path.replaceWith(t.jsxExpressionContainer(makeTCall(e.key)));
    } else {
      e.path.replaceWith(makeTCall(e.key));
    }
  }

  if (!hasUseTranslation) {
    const imp = t.importDeclaration(
      [t.importSpecifier(t.identifier("useTranslation"), t.identifier("useTranslation"))],
      t.stringLiteral("react-i18next"),
    );
    ast.program.body.unshift(imp);
  }

  return ast;
}

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

const outputs = new Map();

for (const file of files) {
  const ast = processFile(file);
  if (!ast) continue;
  outputs.set(file, generate(ast, { compact: false, jsescOption: { minimal: true } }).code);
  filesChanged++;
}

console.log(`files scanned: ${files.length}`);
console.log(`files changed: ${filesChanged}`);
console.log(`strings collected: ${totalReplaced}`);
console.log(`dict entries: ${dict.size}`);

if (!DRY) {
  for (const [file, code] of outputs) {
    fs.writeFileSync(file, code, "utf8");
  }
  fs.mkdirSync(LOCALES_DIR, { recursive: true });
  const zh = {};
  const en = {};
  for (const [key, { zh: text }] of [...dict.entries()].sort()) {
    zh[key] = text;
    en[key] = "";
  }
  fs.writeFileSync(path.join(LOCALES_DIR, "zh-CN.json"), JSON.stringify(zh, null, 2) + "\n");
  fs.writeFileSync(path.join(LOCALES_DIR, "en.json"), JSON.stringify(en, null, 2) + "\n");
  console.log("locales written.");
}
