/** Explicit idea delegation: capture the request and require a concrete brief. */
import * as common from './harness_common.js';

export const BRIEF_FIELDS = ['대상 사용자', '위임한 결정', '제약·비목표'];
const PLACEHOLDER = /^(?:todo|tbd|미정|작성 필요|\.\.\.|…|-)$/i;

export function capture(event) {
  if (event?.hook_event_name !== 'UserPromptSubmit' || typeof event.prompt !== 'string'
      || !/^아이디어 위임(?:\s|$)/u.test(event.prompt.trim())) return null;
  const match = /^아이디어 위임[ \t]+([a-z0-9][a-z0-9._-]{0,79})\s+([\s\S]+)$/u.exec(event.prompt.trim());
  common.require(match && !['.', '..'].includes(match[1]) && match[2].trim()
    && !PLACEHOLDER.test(match[2].trim()), '정확한 명령: 아이디어 위임 TASK <맡길 아이디어 원문>');
  const [session_id, turn_id] = common.event_proof(event);
  return {
    task: match[1],
    delegation: {
      idea: match[2].trim(), prompt: event.prompt.trim(), session_id, turn_id,
      event: 'UserPromptSubmit',
    },
  };
}

export function request(control) {
  if (control.delegation === undefined) return null;
  const value = control.delegation;
  common.require(value && typeof value === 'object' && typeof value.idea === 'string'
    && value.idea.trim() && typeof value.prompt === 'string' && value.prompt.trim()
    && typeof value.session_id === 'string' && value.session_id
    && typeof value.turn_id === 'string' && value.turn_id && value.event === 'UserPromptSubmit',
  '아이디어 위임의 사용자 이벤트 기록이 손상됐습니다.');
  return value;
}

export function scaffold(text, delegated) {
  if (!delegated || /^## 위임 브리프[ \t]*$/mu.test(text)) return text;
  return text.trimEnd() + '\n\n## 위임 브리프\n\n'
    + BRIEF_FIELDS.map(label => `- ${label}: 작성 필요`).join('\n') + '\n';
}

export function brief(text, delegated) {
  if (!delegated) return null;
  const headings = [...text.matchAll(/^## 위임 브리프[ \t]*\r?$/gmu)];
  const matches = [...text.matchAll(/^## 위임 브리프[ \t]*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gmu)];
  common.require(headings.length === 1 && matches.length === 1, '아이디어 위임에는 작업 기록의 ## 위임 브리프가 하나 필요합니다. work.js brief TASK를 실행하세요.');
  const result = {};
  for (const label of BRIEF_FIELDS) {
    const fields = [...matches[0][1].matchAll(new RegExp(`^[ \\t]*(?:-[ \\t]*)?${label}[ \\t]*:[ \\t]*(.*)$`, 'gmu'))];
    const value = fields[0]?.[1].trim();
    common.require(fields.length === 1 && value && !PLACEHOLDER.test(value), `위임 브리프의 ${label} 내용을 작성하세요.`);
    result[label] = value;
  }
  return result;
}

export function require_file(record, delegated) {
  if (!delegated) return;
  common.require(record && typeof record.file === 'string' && record.file
    && typeof record.file_sha256 === 'string',
  '아이디어 위임의 각 단계에는 --evidence @파일로 실제 근거를 연결하세요.');
}
