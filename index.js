/**
 * Model-family system-prompt tuning for Gemini and Claude models on DeepSeek
 * Harness.
 *
 * Long agent prompts that spend most of their budget on "how to use tool X"
 * move a model into a file-system mindset: it answers a generation request by
 * writing a small placeholder file instead of producing the artifact.  The
 * measured fix is a short prompt that keeps only the behavioural guardrails,
 * plus an identity wording that does not read like a harness manual.
 *
 * This plugin rewrites the presentation the `system-prompt/assemble` waterfall
 * delivers, but only when the assembling agent's model matches `models`
 * (Gemini and Claude by default).  For those models it:
 *
 *   1. drops presentation/deployment sections and duplicated tool advice;
 *   2. compresses `@`-file-reference rules to the one honest constraint;
 *   3. replaces the harness identity with a family-appropriate one;
 *   4. substitutes literal phrases some upstreams reject (e.g. "DeepSeek
 *      Harness" -> "Coding Harness").
 *
 * The transform never touches tool declarations: in DSH 0.2.2 the waterfall
 * returns prompt sections only, and tool schemas stay provider-owned.  Tool
 * count is therefore a plugin-composition decision, not something this bundle
 * can change; see README.
 *
 * @module @local/dsh-model-prompts
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Cordis plugin name. */
export const name = 'model-prompts'

/** Wait for the prompt registry before registering the waterfall listener. */
export const inject = ['systemPrompt']

/**
 * Identity used for Gemini models.  Wording follows the published Antigravity
 * prompt (identity paragraph plus the execution-discipline sentence rewritten
 * in Google's own register).  The official trailing `<USER_REQUEST>` contract
 * is deliberately absent: our messages carry no such tag, so keeping it would
 * be an unsatisfiable promise.
 */
export const GEMINI_IDENTITY = [
  'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.',
  'You are pair programming with a USER to solve their coding task, which may require creating a new codebase, modifying or debugging an existing one, or simply answering a question.',
  'Continue after tool results and finish only when the requested work is verified complete or a concrete blocker is reported — not with a promise of the next action.',
].join('\n')

/** Identity used for Claude models: the same discipline without a vendor persona. */
export const CLAUDE_IDENTITY = [
  'You are a coding assistant working with a USER to solve their coding task, which may require creating a new codebase, modifying or debugging an existing one, or simply answering a question.',
  'Continue after tool results and finish only when the requested work is verified complete or a concrete blocker is reported — not with a promise of the next action.',
].join('\n')

/**
 * Compressed `context:file-reference` replacement (the section is 407 chars on
 * DSH 0.2.2).  It keeps the honesty constraint and drops the path grammar that
 * the tool descriptions already explain.
 */
export const FILE_REFERENCE_COMPACT =
  'Tokens starting with @ are file paths the user referenced. Read their contents when needed; never claim to have read something you have not.'

/**
 * Optional factual-claim rule from the tuning guide: a single sentence that
 * replaces four numbered rules at a fraction of the size.
 */
export const KNOWLEDGE_RULE =
  'Rules for factual claims: never present a recalled value as the current state; flag anything time- or version-sensitive as "as of March 2026" unless verified with tools.'

/**
 * Sections whose content is presentation or deployment advice that the tool
 * schema or the runtime context already conveys.  These are the sections the
 * tuning guide removes for Gemini-class models.
 */
export const DEFAULT_DROP_SECTIONS = [
  'ui:deliverable-file-references',
  'app:web-surface',
  'harness:source',
  'tool:jobs',
  'tool:workflow',
  'tool:subagent',
  'tool:subagent_fork',
  'tool:video-gen',
]

/** Literal substitutions applied to every section and context text. */
export const DEFAULT_SCRUB = [['DeepSeek Harness', 'Coding Harness']]

/** Code defaults, also the shape {@link normalizeConfig} produces. */
export const DEFAULT_CONFIG = {
  enabled: true,
  models: ['gemini*', 'claude*'],
  excludeModels: [],
  identities: { gemini: GEMINI_IDENTITY, claude: CLAUDE_IDENTITY },
  identitySection: 'harness:identity',
  replaceIdentity: true,
  knowledgeRule: '',
  effortLine: '',
  dropSections: [...DEFAULT_DROP_SECTIONS],
  keepSections: [],
  compressSections: { 'context:file-reference': FILE_REFERENCE_COMPACT },
  scrub: DEFAULT_SCRUB.map((pair) => [...pair]),
  scrubContexts: true,
  dropContexts: [],
  dryRun: false,
  dumpTo: '',
  dumpText: false,
}

const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string')

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Compile one `*`/`?` glob into an anchored, case-insensitive matcher.
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  const source = escapeRegExp(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.')
  return new RegExp(`^${source}$`, 'i')
}

/**
 * Merge user configuration over the code defaults.  Arrays and the scrub table
 * replace their defaults when provided (an explicit `[]` disables them);
 * object maps merge per key.  Unknown fields are ignored so a config written
 * for a newer version cannot break activation.
 * @param {unknown} raw
 * @returns {typeof DEFAULT_CONFIG}
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const config = {
    ...DEFAULT_CONFIG,
    identities: { ...DEFAULT_CONFIG.identities },
    compressSections: { ...DEFAULT_CONFIG.compressSections },
    scrub: DEFAULT_CONFIG.scrub.map((pair) => [...pair]),
    dropSections: [...DEFAULT_CONFIG.dropSections],
    keepSections: [],
    models: [...DEFAULT_CONFIG.models],
    excludeModels: [],
    dropContexts: [],
  }

  if (typeof input.enabled === 'boolean') config.enabled = input.enabled
  if (typeof input.replaceIdentity === 'boolean') config.replaceIdentity = input.replaceIdentity
  if (typeof input.scrubContexts === 'boolean') config.scrubContexts = input.scrubContexts
  if (typeof input.dryRun === 'boolean') config.dryRun = input.dryRun
  if (typeof input.dumpText === 'boolean') config.dumpText = input.dumpText
  if (typeof input.identitySection === 'string' && input.identitySection.length > 0) {
    config.identitySection = input.identitySection
  }
  for (const key of ['knowledgeRule', 'effortLine', 'dumpTo']) {
    if (typeof input[key] === 'string') config[key] = input[key]
  }
  for (const key of ['models', 'excludeModels', 'keepSections', 'dropContexts']) {
    if (isStringArray(input[key])) config[key] = [...input[key]]
  }
  if (isStringArray(input.dropSections)) config.dropSections = [...input.dropSections]
  if (input.identities !== null && typeof input.identities === 'object') {
    for (const [family, text] of Object.entries(input.identities)) {
      if (typeof text === 'string') config.identities[family] = text
    }
  }
  if (input.compressSections !== null && typeof input.compressSections === 'object') {
    for (const [section, text] of Object.entries(input.compressSections)) {
      if (typeof text === 'string') config.compressSections[section] = text
      else if (text === null) delete config.compressSections[section]
    }
  }
  if (Array.isArray(input.scrub)) {
    const pairs = input.scrub.filter(
      (pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string' && pair[0] !== '',
    )
    config.scrub = pairs.map((pair) => [pair[0], pair[1]])
  }
  return config
}

/**
 * Whether the model id is covered by `models` and not excluded.
 * @param {string} model
 * @param {typeof DEFAULT_CONFIG} config
 * @returns {boolean}
 */
export function matchesModel(model, config) {
  const id = String(model ?? '')
  if (id === '') return false
  const included = config.models.some((pattern) => globToRegExp(pattern).test(id))
  if (!included) return false
  return !config.excludeModels.some((pattern) => globToRegExp(pattern).test(id))
}

/**
 * Resolve the identity family for a model id: the longest configured key that
 * appears in the id (`gemini`, `claude`, ...), case-insensitively.
 * @param {string} model
 * @param {Record<string, string>} identities
 * @returns {string | undefined}
 */
export function familyOf(model, identities) {
  const id = String(model ?? '').toLowerCase()
  if (id === '') return undefined
  const keys = Object.keys(identities).sort((a, b) => b.length - a.length)
  return keys.find((key) => key.length > 0 && id.includes(key.toLowerCase()))
}

/**
 * Build a text scrubber from `[from, to]` pairs.  Matching is case-insensitive
 * and the replacement is literal (no `$` group expansion).
 * @param {ReadonlyArray<readonly [string, string]>} pairs
 * @returns {(text: string) => string}
 */
export function makeScrubber(pairs) {
  if (pairs.length === 0) return (text) => String(text ?? '')
  const compiled = pairs.map(([from, to]) => [new RegExp(escapeRegExp(from), 'gi'), to])
  return (text) => {
    let result = String(text ?? '')
    for (const [pattern, replacement] of compiled) result = result.replace(pattern, () => replacement)
    return result
  }
}

/**
 * Append the optional knowledge rule and thinking-effort line to a text.
 * @param {string} text
 * @param {ReturnType<typeof normalizeConfig>} config
 * @returns {string}
 */
function withExtras(text, config) {
  let result = text
  if (config.knowledgeRule !== '') result = result === '' ? config.knowledgeRule : `${result}\n\n${config.knowledgeRule}`
  if (config.effortLine !== '') result = result === '' ? config.effortLine : `${result}\n${config.effortLine}`
  return result
}

/** Character count of a section/context list. */
const totalChars = (entries) => entries.reduce((sum, entry) => sum + entry.text.length, 0)

/**
 * Apply the tuning plan to one presentation.
 * @param {{sections: Array<{name: string, text: string}>, contexts: Array<{name: string, text: string}>}} presentation
 * @param {{model: string, provider?: string, config: ReturnType<typeof normalizeConfig>}} input
 * @returns {{presentation: typeof presentation, report: object}}
 */
export function transformPresentation(presentation, { model, provider, config }) {
  const scrub = makeScrubber(config.scrub)
  const family = familyOf(model, config.identities)
  const keep = new Set(config.keepSections)
  const dropped = []
  const compressed = []
  const before = {
    chars: totalChars(presentation.sections),
    sections: presentation.sections.map((section) => ({ name: section.name, chars: section.text.length })),
  }

  const sections = []
  let identitySeen = false
  for (const section of presentation.sections) {
    if (config.dropSections.includes(section.name) && !keep.has(section.name)) {
      dropped.push({ name: section.name, chars: section.text.length })
      continue
    }
    let text = section.text
    if (section.name === config.identitySection) {
      identitySeen = true
      const identity = config.replaceIdentity ? (config.identities[family] ?? '') : ''
      text = withExtras(identity !== '' ? identity : section.text, config)
    } else if (Object.hasOwn(config.compressSections, section.name)) {
      const replacement = config.compressSections[section.name]
      if (replacement !== section.text) compressed.push({ name: section.name, from: section.text.length, to: replacement.length })
      text = replacement
    }
    sections.push({ ...section, text: scrub(text) })
  }

  // A profile can disable the fixed harness identity; the tuned one then has to
  // be added rather than replaced.  It sorts first by construction (order -1000).
  if (!identitySeen && config.replaceIdentity && (config.identities[family] ?? '') !== '') {
    sections.unshift({ name: config.identitySection, text: scrub(withExtras(config.identities[family], config)) })
  }

  const dropContexts = new Set(config.dropContexts)
  const contexts = []
  const droppedContexts = []
  for (const entry of presentation.contexts) {
    if (dropContexts.has(entry.name)) {
      droppedContexts.push({ name: entry.name, chars: entry.text.length })
      continue
    }
    contexts.push({ ...entry, text: config.scrubContexts ? scrub(entry.text) : entry.text })
  }

  const tuned = { ...presentation, sections, contexts }
  const report = {
    matched: true,
    family: family ?? null,
    model: model ?? '',
    provider: provider ?? null,
    dryRun: config.dryRun,
    before: { ...before, totalChars: before.chars },
    after: {
      chars: totalChars(sections),
      sections: sections.map((section) => ({ name: section.name, chars: section.text.length })),
      contextChars: totalChars(contexts),
    },
    droppedSections: dropped,
    droppedContexts,
    compressed,
    identityReplaced: config.replaceIdentity && (config.identities[family] ?? '') !== '',
  }
  return { presentation: tuned, report }
}

/** Write the diagnostic dump atomically; a failed dump never breaks a request. */
function writeDump(file, payload, logger) {
  try {
    const target = resolve(file)
    mkdirSync(dirname(target), { recursive: true })
    const temporary = `${target}.tmp-${process.pid}`
    writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    logger?.warn?.(`model-prompts: dump to ${file} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Plugin entry: one `system-prompt/assemble` waterfall listener.  Assemblies for
 * models outside `models` pass through untouched; every failure inside the
 * transform falls back to the original presentation instead of failing a turn.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return
  ctx.logger?.info?.(
    `model-prompts active: models=${config.models.join(', ') || '(none)'} `
    + `drop=${config.dropSections.length} identity=${config.replaceIdentity ? 'family' : 'original'}`,
  )

  ctx.on('system-prompt/assemble', async (presentation, context, next) => {
    const upstream = await next()
    try {
      const model = String(
        upstream.variables?.model
        ?? context?.modelSelection?.model
        ?? context?.agent?.options?.model
        ?? '',
      )
      if (!matchesModel(model, config)) return upstream
      const provider = String(
        upstream.variables?.provider
        ?? context?.modelSelection?.provider
        ?? context?.agent?.options?.provider
        ?? '',
      )
      const { presentation: tuned, report } = transformPresentation(upstream, { model, provider, config })
      if (config.dumpTo !== '') {
        writeDump(config.dumpTo, {
          at: new Date().toISOString(),
          ...report,
          prompt: config.dumpText ? tuned.sections.map((section) => section.text).join('\n\n') : undefined,
        }, ctx.logger)
      }
      return config.dryRun ? upstream : tuned
    } catch (error) {
      ctx.logger?.warn?.(`model-prompts: transform failed, keeping the original prompt: ${error instanceof Error ? error.message : String(error)}`)
      return upstream
    }
  })
}
