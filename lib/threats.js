// dsh-long-term-memory — lightweight threat scan for memory content.
//
// A small, conservative, dependency-free pattern set for memory entries:
// entries are user- or model-curated text that gets injected into the system
// prompt, so a poisoned entry (prompt injection, system-prompt exfiltration,
// role hijacking, C2-style promptware) would persist for the whole session
// and across sessions.
//
// Two callers use it:
//   - `memory_write` refuses content that matches (fail closed at write time);
//   - the per-assembly injected digest replaces matching entries with a
//     `[BLOCKED: ...]` placeholder, so a poisoned-on-disk entry cannot reach
//     the system prompt while the original stays visible for the user to
//     inspect and remove.
//
// The patterns are intentionally narrow to avoid false positives on ordinary
// user notes (e.g. "remember to ignore old instructions" is itself a prompt
// hijack, but a note like "the API ignores unknown fields" must pass).

/** @type {{id: string, re: RegExp}[]} */
const PATTERNS = [
  // English instruction-override
  {
    id: 'instr-override',
    re: /\b(ignore|disregard|overlook|forget|skip)\b[^.!?\n]{0,40}\b(previous|prior|all|above|earlier)\b[^.!?\n]{0,30}\b(instructions?|prompts?|directives?|rules?|guidelines?)\b/i,
  },
  // "disregard your/all/any rules" without an explicit "previous"
  {
    id: 'disregard-rules',
    re: /\bdisregard\b[^.!?\n]{0,20}\b(your|all|any)\b[^.!?\n]{0,20}\b(instructions|rules|guidelines|restrictions|filters|safety)\b/i,
  },
  // Bypass-restriction phrasing ("act as if you have no restrictions")
  {
    id: 'bypass-restrictions',
    re: /\bact\s+as\s+(if|though)\b[^.!?\n]{0,40}\b(no|don'?t have|without)\b[^.!?\n]{0,30}\b(restrictions|limits|rules|filters|safety|guardrails)\b/i,
  },
  // Remove-filters phrasing ("respond without restrictions/limitations")
  {
    id: 'remove-filters',
    re: /\b(respond|answer|reply)\b[^.!?\n]{0,20}\bwithout\b[^.!?\n]{0,30}\b(restrictions|limitations|filters|safety|guardrails|rules)\b/i,
  },
  // English system-prompt exfiltration
  {
    id: 'sysprompt-leak',
    re: /\b(reveal|print|show|display|output|leak|dump|repeat|recite)\b[^.!?\n]{0,40}\b(system prompt|system message|instructions?|prompt template|persona)\b/i,
  },
  // "output the system/initial prompt" (verb-anchored leak)
  {
    id: 'leak-initial-prompt',
    re: /\boutput\b[^.!?\n]{0,30}\b(system|initial|full)\b[^.!?\n]{0,20}\bprompt\b/i,
  },
  // Role hijack ("you are now ChatGPT", "act as a different model", …)
  {
    id: 'role-hijack',
    re: /\byou\b[^.!?\n]{0,30}\b(are|now act as|must pretend to be)\b[^.!?\n]{0,40}\b(chapt?gpt|claude|gemini|llama|gpt-\d|a different (ai|model|assistant)|an? ai)\b/i,
  },
  // "pretend you are / pretend to be" role hijack
  {
    id: 'role-pretend',
    re: /\bpretend\b[^.!?\n]{0,20}\b(you are|to be)\b/i,
  },
  // "you have been updated/upgraded to" — fake-version identity override
  {
    id: 'fake-update',
    re: /\byou have been\b[^.!?\n]{0,20}\b(updated|upgraded|patched)\b[^.!?\n]{0,20}\bto\b/i,
  },
  // Jailbreak shorthand: "DAN" / "do anything now" / "developer mode"
  {
    id: 'jailbreak',
    re: /\b(do anything now|developer mode|unrestricted mode|jailbroken?)\b/i,
  },
  // "Repeat everything above / all previous text" — transcript exfiltration
  {
    id: 'repeat-above',
    re: /\b(repeat|print|output|echo|copy)\b[^.!?\n]{0,30}\b(everything|all|the (above|previous|conversation|transcript|history))\b[^.!?\n]{0,20}\b(above|previous|so far|history)?\b/i,
  },
  // Credential exfiltration: send/post/upload keys or tokens somewhere
  {
    id: 'cred-exfil',
    re: /\b(send|post|upload|exfiltrate|transmit|leak)\b[^.!?\n]{0,40}\b(api[ _-]?keys?|secrets?|tokens?|passwords?|credentials?|authorization)\b[^.!?\n]{0,30}\b(to|via|through|at|using)\b[^.!?\n]{0,40}\b(https?:\/\/|\bapi\b|\bwebhook\b|\bendpoint\b|\bemail\b)/i,
  },
  // curl/wget exfil of secrets from env/secret files
  {
    id: 'exfil-curl-wget',
    re: /\b(curl|wget)\b[^$\n!?]{0,80}\$\{?\w*?(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)\w*/i,
  },
  // Reading secret files (cat .env / credentials / .netrc …)
  {
    id: 'read-secrets',
    re: /\b(cat|type|print)\b[^.!?\n]{0,60}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i,
  },
  // C2-style promptware: register/connect/report/beacon with an agent "you must"
  {
    id: 'c2-forced-action',
    re: /\byou must\b[^.!?\n]{0,30}\b(register|connect|report|beacon|join)\b/i,
  },
  // C2 vocabulary: "command and control", "c2 server/channel", known frameworks
  {
    id: 'c2-vocabulary',
    re: /\b(command and control|c2 (server|channel|infrastructure|beacon)|cobalt\s*strike|metasploit|brainworm)\b/i,
  },
  // HTML comment / hidden-div injection
  {
    id: 'html-injection',
    re: /<!--[^>]{0,512}(ignore|override|system|secret|hidden)[^>]{0,512}-->|<div\s+style\s*=\s*["'][^"']{0,2048}display\s*:\s*none/i,
  },
  // Chinese instruction-override (忽略/无视 + 之前/所有 + 指令/提示/规则)
  {
    id: 'instr-override-cn',
    re: /(忽略|无视|忘掉|不要遵守|不必遵守)[^。！？\n]{0,20}(之前|先前|以上|所有|全部)[^。！？\n]{0,15}(指令|指示|要求|规则|提示|guidelines?)/,
  },
  // Chinese system-prompt exfiltration (打印/输出/泄露 + 系统提示/提示词)
  {
    id: 'sysprompt-leak-cn',
    re: /(打印|输出|显示|泄露|复述|重复)[^。！？\n]{0,20}(系统提示|系统消息|提示词|persona|instructions?)/,
  },
  // Chinese jailbreak / unrestricted-mode shorthand
  {
    id: 'jailbreak-cn',
    re: /(越狱|解除限制|不受限制模式|开发者模式|自由模式)/,
  },
  // Chinese transcript exfiltration (把全部/以上内容 输出/发给…)
  {
    id: 'repeat-above-cn',
    re: /(把|将)[^。！？\n]{0,15}(全部|所有|以上|整个)[^。！？\n]{0,15}(内容|对话|消息|历史|记录)[^。！？\n]{0,15}(输出|打印|发给|发送|复制|贴出)/,
  },
  // Chinese role hijack ("你现在是/假装你是")
  {
    id: 'role-hijack-cn',
    re: /(你现在是|假装你是|从现在起你就是|你现在的身份是)/,
  },
  // Marker injection: raw chat-format tags that would splice a fake role turn
  {
    id: 'marker-inject',
    re: /<\|?(im_start|im_end|system|user|assistant)[_|>]/i,
  },
]

/**
 * Scan `text` for known threat patterns.
 * @param {string} text - the content to scan.
 * @returns {string[]} the ids of every matched pattern (empty when clean).
 */
export function scanThreats(text) {
  const hits = []
  for (const pattern of PATTERNS) {
    if (pattern.re.test(String(text ?? ''))) hits.push(pattern.id)
  }
  return hits
}

/** All pattern ids, for documentation/tests. */
export const THREAT_PATTERN_IDS = PATTERNS.map((p) => p.id)

export default scanThreats
