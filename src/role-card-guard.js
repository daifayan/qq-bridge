// 角色卡守卫：结构校验 + 备份恢复。
//
// 为什么需要（借阿深 check-persona.py 的教训）：
//   角色卡是被"分节读"的——少一节就读成空，全缺就变成没有人设的空壳。
//   更糟的是**不会报错**：下一次对话才会发现"它不像自己了"，那时候已经聊歪了。
//   所以每次保存前校验结构，坏了就地拒绝；启动时体检一次，坏了从最近的 .bak 恢复。
//
// 边界：只做结构判断，不改内容。角色卡怎么写得好看是人的事。
import fs from 'node:fs';
import path from 'node:path';

export const ROLE_LIMITS = {
  minChars: 800,        // 低于这个字符数基本是空壳/被清空
  maxChars: 6000,       // 桥接侧 currentRoleHint() 的硬上限，超了会被静默截断
  minSections: 3,       // 至少几个二级标题
  shrinkRatio: 0.5,     // 比上一版少了 50% 字符 → 视为误删/截断
};

/** 解析角色卡的二级标题（## 开头）。 */
export function sectionsOf(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

export function charCount(text) {
  return String(text ?? '').length;
}

/**
 * 体检一张角色卡。
 * @param {string} text 角色卡全文
 * @param {{previous?: string}} opts previous = 上一版全文（用来发现"被删了一半"）
 * @returns {{ok: boolean, chars: number, sections: string[], issues: string[], warnings: string[]}}
 */
export function inspectRoleCard(text, opts = {}) {
  const s = String(text ?? '');
  const chars = charCount(s);
  const sections = sectionsOf(s);
  const issues = [];
  const warnings = [];

  if (!s.trim()) issues.push('角色卡是空的');
  else if (chars < ROLE_LIMITS.minChars) issues.push(`只有 ${chars} 字（低于 ${ROLE_LIMITS.minChars}，像空壳或被清空）`);

  if (chars > ROLE_LIMITS.maxChars) issues.push(`${chars} 字，超过 ${ROLE_LIMITS.maxChars} 硬上限（会被静默截断）`);

  if (sections.length < ROLE_LIMITS.minSections) {
    issues.push(`只有 ${sections.length} 个二级标题（至少 ${ROLE_LIMITS.minSections} 个），结构可能被删坏`);
  }

  // 通用骨架：绝大多数角色卡都该有"性格"或"你是谁"这类段落
  if (s.trim() && !/性格|你是谁|人设|设定/.test(s)) {
    warnings.push('没找到"性格/你是谁/人设"这类关键词，确认一下是不是贴错文件了');
  }

  if (opts.previous && charCount(opts.previous) > 0) {
    const prevChars = charCount(opts.previous);
    if (chars < prevChars * ROLE_LIMITS.shrinkRatio) {
      issues.push(`比上一版少了 ${Math.round((1 - chars / prevChars) * 100)}%（上一版 ${prevChars} 字），可能是误删或截断`);
    }
    const prevSections = sectionsOf(opts.previous);
    if (prevSections.length >= ROLE_LIMITS.minSections && sections.length < prevSections.length) {
      const lost = prevSections.filter((t) => !sections.includes(t));
      if (lost.length) warnings.push(`少了这些节：${lost.slice(0, 5).join(' / ')}`);
    }
  }

  return { ok: issues.length === 0, chars, sections, issues, warnings };
}

/** 找同一目录下最新的备份（.bak-* 或 .bak）。 */
export function findLatestBackup(roleFile) {
  const dir = path.dirname(roleFile);
  const base = path.basename(roleFile);
  try {
    const cands = fs.readdirSync(dir)
      .filter((n) => n.startsWith(`${base}.bak`))
      .map((n) => {
        const full = path.join(dir, n);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* 读不到就跳过 */ }
        return { full, mtime };
      })
      .filter((x) => x.mtime > 0 && (() => {
        try { return fs.statSync(x.full).size > 0; } catch { return false; }
      })())
      .sort((a, b) => b.mtime - a.mtime);
    return cands[0]?.full ?? '';
  } catch {
    return '';
  }
}

/**
 * 从最近备份恢复角色卡（先把当前坏版本另存一份，便于事后查）。
 * @returns {{ok: boolean, restoredFrom?: string, savedBrokenAs?: string, error?: string}}
 */
export function restoreRoleCard(roleFile) {
  const backup = findLatestBackup(roleFile);
  if (!backup) return { ok: false, error: '没有可用备份' };
  try {
    const broken = `${roleFile}.broken-${Date.now()}`;
    if (fs.existsSync(roleFile)) fs.copyFileSync(roleFile, broken);
    fs.copyFileSync(backup, roleFile);
    return { ok: true, restoredFrom: backup, savedBrokenAs: broken };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 保存前校验；不通过就不写盘。
 * @returns {{ok: boolean, issues: string[], warnings: string[], chars: number, sections: string[]}}
 */
export function validateForSave(roleFile, nextText) {
  let previous = '';
  try { previous = fs.readFileSync(roleFile, 'utf8'); } catch { /* 新文件 */ }
  return inspectRoleCard(nextText, { previous });
}
