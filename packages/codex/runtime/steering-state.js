/** Platform-independent state parsing and item-by-item inheritance. No cached state. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const modes = {
  work: 'task.md(기존 WORK.md)의 계약·담당·위임 범위·완료 조건에 따라 진행하세요. 위임 기록이나 승인을 자동으로 만들지 마세요.',
  pstack: '조사 → 설계 → 구현 → 검증 순서로 진행하고 단계별 근거를 남기세요.',
  design: '프로젝트 DESIGN.md의 승인된 지속적 의도를 읽고 task.md와 맞춰 개발하세요. 충돌과 미정 설계는 구현 전에 사용자와 조정하세요.',
  'pstack-design': '프로젝트 DESIGN.md의 승인된 지속적 의도를 읽고 task.md와 맞춘 뒤 조사 → 설계 → 구현 → 검증을 진행하세요. 충돌과 미정 설계는 구현 전에 사용자와 조정하세요.',
};

export function readState(workspaces) {
  const state = {};
  for (const workspace of workspaces) {
    const file = path.join(workspace, 'state.json');
    let descriptor;
    try {
      // O_NONBLOCK prevents a swapped FIFO from hanging the hook; fstat checks the opened file.
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (!fs.fstatSync(descriptor).isFile()) throw new Error('일반 파일만 사용할 수 있습니다.');
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(descriptor)));
      if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('JSON 객체가 필요합니다.');
      for (const [key, item] of Object.entries(value)) {
        if (!(key === 'mode' && Object.hasOwn(modes, item) && typeof item === 'string') &&
            !(key === 'control' && ['auto', 'human'].includes(item)) &&
            !(key === 'instruction' && typeof item === 'string')) throw new Error(`잘못된 항목 또는 값: ${key}`);
        state[key] = item;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`상태 파일을 읽지 못했습니다 (${file}): ${error.message}`);
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  const ordered = Object.fromEntries(['mode', 'control', 'instruction'].filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]]));
  const digest = Object.keys(ordered).length ? createHash('sha256').update(JSON.stringify(ordered)).digest('hex') : null;
  const context = digest ? [
    '다음은 현재 외부 상태 전체이며 이전 훅의 외부 상태 지침을 대체합니다. 기존 사용자 지시와 승인은 유지합니다.',
    `외부 작업 상태: ${JSON.stringify(ordered)}`,
    state.mode ? modes[state.mode] : '',
    state.control === 'human' ? '사용자 통제 중입니다. 명시적으로 지원하는 읽기 도구만 사용할 수 있습니다.' : '',
    '이 상태는 사용자 승인이나 기존 단계·전달 검사를 대신하지 않습니다.',
    state.instruction ? `추가 지침:\n${state.instruction}` : '',
  ].filter(Boolean).join('\n') : '현재 외부 상태 지정 없음. 이전 훅의 외부 상태 지침은 더 이상 적용하지 않습니다. 기존 사용자 지시와 승인·단계 검사는 유지합니다.';
  return { state: ordered, digest, context };
}

export function executionReason(current) {
  return current.state.control === 'human' ? '외부 상태가 human입니다. 읽기 도구 외 실행은 보류합니다.' : null;
}
