import { describe, expect, it } from 'vitest';
import {
  sanitizeDisplayName,
  sanitizeProjectName,
  stripHiddenContext,
  truncateSessionTitle,
  visibleUserMessage,
} from '../../src/lib/text';
import { fileTypeMeta, pathBasename, pathDirname } from '../../src/lib/fileType';
import { buildRoomFeed, foldToolRuns } from '../../src/lib/room-feed';
import type { RoomEvent } from '../../src/lib/digital-human-client';

const human = { id: 'dh-1', displayName: '甲', avatarRef: '🤖', themeColor: '#123456' } as any;
const ev = (seq: number, type: string, payload: Record<string, unknown>, extra: Partial<RoomEvent> = {}): RoomEvent =>
  ({ seq, id: `e${seq}`, roomId: 'r1', type, payload, digitalHumanId: 'dh-1', ...extra } as RoomEvent);

describe('text.ts 名称清洗（与后端 WorkspaceRegistryService 对齐）', () => {
  it('sanitizeProjectName 把非法字符替换为下划线', () => {
    expect(sanitizeProjectName('my project/测试:v1')).toBe('my_project_测试_v1');
  });

  it('sanitizeProjectName 空格同样视为非法字符被替换（与后端规则一致）', () => {
    // 空格被逐个替换为下划线；trim 只去除首尾空白，替换后的下划线会保留
    expect(sanitizeProjectName('  a   b  ')).toBe('__a___b__');
  });

  it('sanitizeDisplayName 剥离 emoji，空结果回退原名', () => {
    expect(sanitizeDisplayName('🚀DSH🚀')).toBe('DSH');
    expect(sanitizeDisplayName('🚀')).toBe('🚀');
  });
});

describe('text.ts 消息展示还原', () => {
  it('stripHiddenContext 剥掉隐藏上下文块', () => {
    expect(stripHiddenContext('正文<hidden-context>工程注入</hidden-context>尾巴')).toBe('正文尾巴');
  });

  it('stripHiddenContext 兜底剥离早期「[当前选择的工程]」尾巴', () => {
    expect(stripHiddenContext('正文\n[当前选择的工程]/tmp/x')).toBe('正文');
  });

  it('visibleUserMessage 还原被 harness 包装的首条消息', () => {
    const wrapped = '请先使用可用工具完成下面的任务，……\n\n用户原始请求：帮我写周报';
    expect(visibleUserMessage(wrapped)).toBe('帮我写周报');
    expect(visibleUserMessage('普通消息')).toBe('普通消息');
  });

  it('truncateSessionTitle 截断加省略号', () => {
    const long = '一'.repeat(100);
    const out = truncateSessionTitle(long, 20);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('fileType.ts 文件类型识别', () => {
  it('按扩展名映射类别', () => {
    expect(fileTypeMeta('a/b/c.docx').kindLabel).toBe('Word 文档');
    expect(fileTypeMeta('report.xlsx').kindLabel).toBe('表格');
    expect(fileTypeMeta('arch.drawio').kindLabel).toBe('Draw.io 图表');
    expect(fileTypeMeta('main.tsx').kindLabel).toBe('代码');
    expect(fileTypeMeta('photo.PNG').kindLabel).toBe('图片');
  });

  it('目录与未知扩展名', () => {
    expect(fileTypeMeta('any/path', 'dir').kindLabel).toBe('文件夹');
    expect(fileTypeMeta('noext').kindLabel).toBe('文件');
  });

  it('basename 与 dirname（dirname 输出正斜杠且不带前导斜杠）', () => {
    expect(pathBasename('/a/b/c.txt')).toBe('c.txt');
    expect(pathDirname('/a/b/c.txt')).toBe('a/b');
  });
});

describe('room-feed.ts 事件归一化（房间叙事核心）', () => {
  it('同 taskId 流式累加 + 定稿覆盖为同一条', () => {
    const feed = buildRoomFeed([
      ev(1, 'MESSAGE_CREATED', { role: 'digital_human', content: '' }, { taskId: 't1' }),
      ev(2, 'MESSAGE_CHUNK', { text: '第一' }, { taskId: 't1' }),
      ev(3, 'MESSAGE_CHUNK', { text: '第二' }, { taskId: 't1' }),
      ev(4, 'MESSAGE_CREATED', { role: 'digital_human', content: '定稿内容' }, { taskId: 't1' }),
    ], [human]);
    const msgs = feed.filter((f) => f.kind === 'human-message');
    expect(msgs).toHaveLength(1);
    const m = msgs[0] as any;
    expect(m.content).toBe('定稿内容');
    expect(m.streaming).toBe(false);
  });

  it('TOOL_CALL/TOOL_RESULT 按 callId 配对，状态收口不永久转圈', () => {
    const feed = buildRoomFeed([
      ev(1, 'TOOL_CALL', { toolName: 'shell_execute', callId: 'c1', summary: '执行命令' }),
      ev(2, 'TOOL_RESULT', { toolName: 'shell_execute', callId: 'c1', status: 'success', summary: '' }),
    ], [human]);
    const tools = feed.filter((f) => f.kind === 'tool') as any[];
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe('success');
    expect(tools[0].resultSummary).toBe('（无输出）');
  });

  it('重复 TOOL_CALL（上游双发）合并进已有卡片', () => {
    const feed = buildRoomFeed([
      ev(1, 'TOOL_CALL', { toolName: 'fs_read', callId: 'c9', summary: '读文件' }),
      ev(2, 'TOOL_CALL', { toolName: 'fs_read', callId: 'c9', summary: '' }),
    ], [human]);
    const tools = feed.filter((f) => f.kind === 'tool');
    expect(tools).toHaveLength(1);
  });

  it('用户回显消息剥掉 hidden-context', () => {
    const feed = buildRoomFeed([
      ev(1, 'MESSAGE_CREATED', { role: 'user', content: '目标<hidden-context>注入</hidden-context>' }),
    ], [human]);
    expect((feed[0] as any).content).toBe('目标');
  });

  it('foldToolRuns 折叠同数字人连续工具为 tool-group', () => {
    const feed = buildRoomFeed([
      ev(1, 'TOOL_CALL', { toolName: 'a', callId: 'c1' }),
      ev(2, 'TOOL_RESULT', { toolName: 'a', callId: 'c1', status: 'success', summary: 'x' }),
      ev(3, 'TOOL_CALL', { toolName: 'b', callId: 'c2' }),
      ev(4, 'TOOL_RESULT', { toolName: 'b', callId: 'c2', status: 'success', summary: 'y' }),
    ], [human]);
    const rows = foldToolRuns(feed as any);
    expect(rows.filter((r: any) => r.kind === 'tool-group')).toHaveLength(1);
    expect((rows.find((r: any) => r.kind === 'tool-group') as any).runs).toHaveLength(2);
  });

  it('空事件列表返回空 feed', () => {
    expect(buildRoomFeed([], [])).toEqual([]);
  });
});
