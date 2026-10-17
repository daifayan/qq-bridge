// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import { safeFetch } from './safe-fetch.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function bingSearch(query) {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  // 搜索也使用同一条受限传输链路，重定向必须重新校验，正文最多 512K 字符。
  const res = await safeFetch(url.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`搜索服务 HTTP ${res.statusCode}`);
  const html = res.body;
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= 8) break;
  }
  return { query, results };
}

/**
 * 360 搜索（主搜索源）。
 *
 * 为什么不用必应做主源：必应在本机网络下对**较长的中文查询**会退化 ——
 * 「张函瑞」能返回正确结果，但「张函瑞是谁」「张函瑞 舞台」都退化成只匹配
 * 第一个字「张」，返回「张（汉语汉字）_百度百科」这类无关结果（加引号、
 * 加 mkt=zh-CN、加英文词都无法改善）。360 对同样这些查询能稳定返回相关结果。
 * 因此以 360 为主源、必应为兜底。
 */
async function so360Search(query) {
  const url = 'https://www.so.com/s?q=' + encodeURIComponent(query);
  const res = await safeFetch(url, 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`搜索服务 HTTP ${res.statusCode}`);
  const html = res.body;
  const results = [];
  const blocks = html.split(/<li[^>]*class="[^"]*res-list[^"]*"/i).slice(1);
  for (const block of blocks) {
    const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const hrefMatch =
      block.match(/data-mdurl="(https?:\/\/[^"]+)"/i) ?? block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const urlStr = hrefMatch ? decodeHtml(hrefMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    // 「其他人还搜了」这类推荐块没有真实标题，跳过
    if (!title || title.includes('其他人还搜了')) continue;
    results.push({ title, url: urlStr, snippet });
    if (results.length >= 8) break;
  }
  return { query, results };
}

/** 主源 360，失败或空结果时兜底必应，避免单一搜索源挂掉后完全查不到。 */
async function searchWeb(query) {
  const attempts = [];
  let anySuccess = false;
  try {
    const primary = await so360Search(query);
    anySuccess = true;
    if (primary.results.length > 0) return { ...primary, source: 'so.com' };
    attempts.push('so.com 返回 0 条');
  } catch (error) {
    attempts.push(`so.com 失败:${error?.message ?? error}`);
  }
  try {
    const fallback = await bingSearch(query);
    return { ...fallback, source: 'bing.com', note: attempts.join('; ') };
  } catch (error) {
    attempts.push(`bing.com 失败:${error?.message ?? error}`);
    // 两个源都挂了才算真失败：按工具错误上报，别伪装成"0 条结果"。
    if (!anySuccess) throw new Error(attempts.join('; '));
    return { query, results: [], note: attempts.join('; ') };
  }
}

const server = new McpServer({ name: 'web-search-safe', version: '0.1.5' });

server.tool(
  'web_search',
  '只读搜索网络资料（人物、时事、网络用语/梗/黑话），返回搜索结果的标题/URL/摘要。主源为 360 搜索、必应为兜底；对中文长查询比必应更可靠。仅用于查资料，不执行任何本地操作。',
  { query: z.string().describe('要搜索的关键词（人物名、事件、网络用语/梗等）') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await searchWeb(clean);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本/HTML 前 50000 字符。禁止访问内网/本机地址，不执行任何本地操作。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    try {
      const result = await safeFetch(url);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
