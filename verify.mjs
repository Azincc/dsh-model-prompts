/**
 * Self-test for @local/dsh-model-prompts.
 *
 *   node verify.mjs                 # synthetic fixtures, deterministic asserts
 *   node verify.mjs <dump.json>     # also replays a real captured assembly
 *
 * The JSON form accepts the object this plugin's `dumpTo` writes or the raw
 * presentation shape `{ variables, sections, contexts }`; it prints the section
 * table before and after the transform so a real profile can be checked without
 * switching models.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CLAUDE_IDENTITY,
  DEFAULT_CONFIG,
  FILE_REFERENCE_COMPACT,
  GEMINI_IDENTITY,
  apply,
  familyOf,
  matchesModel,
  normalizeConfig,
  transformPresentation,
} from './index.js'

let failures = 0
let checks = 0

function check(label, fn) {
  checks += 1
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

function synthetic(model = 'gemini-4-argon-high') {
  return {
    variables: { model, provider: 'test' },
    sections: [
      { name: 'harness:identity', text: IDENTITY },
      { name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the {{model}} model.' },
      { name: 'context:file-reference', text: 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter.' },
      { name: 'ui:deliverable-file-references', text: 'Prefer showing the primary results within your final response. '.repeat(20).trim() },
      { name: 'app:web-surface', text: 'You are interacting with the user through the DeepSeek Harness Web GUI. '.repeat(10).trim() },
      { name: 'tool:read', text: 'Use the read tool — not shell commands — to inspect text files.' },
      { name: 'tool:goal', text: 'create_goal may infer goal intent from a direct human request.' },
    ],
    contexts: [
      { name: 'working-directory:current', text: 'Current working directory: "C:\\work".' },
      { name: 'harness:source', text: 'Current DeepSeek Harness implementation checkout: "C:\\dsh".' },
    ],
  }
}

const joined = (presentation) => [
  ...presentation.sections.map((section) => section.text),
  ...presentation.contexts.map((entry) => entry.text),
].join('\n')

console.log('defaults')
check('gemini model matches the shipped patterns', () => {
  assert.equal(matchesModel('gemini-4-argon-high', DEFAULT_CONFIG), true)
  assert.equal(matchesModel('claude-opus-4-6-thinking', DEFAULT_CONFIG), true)
})
check('other model families do not match', () => {
  assert.equal(matchesModel('go/deepseek-v4.1-flash', DEFAULT_CONFIG), false)
  assert.equal(matchesModel('gpt-6.2-sol', DEFAULT_CONFIG), false)
  assert.equal(matchesModel('', DEFAULT_CONFIG), false)
})
check('family resolution picks the identity key', () => {
  assert.equal(familyOf('gemini-4-neon-xhigh', DEFAULT_CONFIG.identities), 'gemini')
  assert.equal(familyOf('claude-sonnet-5-5-high', DEFAULT_CONFIG.identities), 'claude')
  assert.equal(familyOf('gpt-6.2-sol', DEFAULT_CONFIG.identities), undefined)
})
check('excludeModels overrides models', () => {
  const config = normalizeConfig({ models: ['gemini*'], excludeModels: ['gemini-4-hydrogen*'] })
  assert.equal(matchesModel('gemini-4-argon-high', config), true)
  assert.equal(matchesModel('gemini-4-hydrogen-xhigh', config), false)
})

console.log('transform')
const gemini = transformPresentation(synthetic(), { model: 'gemini-4-argon-high', config: normalizeConfig({}) })
check('drops the presentation and duplicated tool-advice sections', () => {
  const names = gemini.presentation.sections.map((section) => section.name)
  for (const dropped of ['ui:deliverable-file-references', 'app:web-surface']) {
    assert.equal(names.includes(dropped), false, `${dropped} should be dropped`)
  }
  assert.equal(names.includes('tool:read'), true)
  assert.equal(names.includes('tool:goal'), true)
})
check('keeps every behavioural guardrail section', () => {
  const names = gemini.presentation.sections.map((section) => section.name)
  for (const kept of ['context:file-reference', 'tool:read', 'tool:goal', 'deployment:persona-prefix']) {
    assert.equal(names.includes(kept), true, `${kept} should survive`)
  }
})
check('rewrites the harness identity for Gemini', () => {
  const identity = gemini.presentation.sections.find((section) => section.name === 'harness:identity')
  assert.equal(identity.text, GEMINI_IDENTITY)
  assert.equal(identity.text.includes('DeepSeek'), false)
})
check('compresses the file-reference rules', () => {
  const section = gemini.presentation.sections.find((entry) => entry.name === 'context:file-reference')
  assert.equal(section.text, FILE_REFERENCE_COMPACT)
})
check('scrubs the rejected literal from sections and contexts', () => {
  assert.equal(joined(gemini.presentation).includes('DeepSeek Harness'), false)
  assert.equal(joined(gemini.presentation).includes('Coding Harness'), true)
})
check('shrinks the prompt by more than half', () => {
  assert.ok(gemini.report.after.chars < gemini.report.before.chars * 0.5)
  assert.ok(gemini.report.after.chars < gemini.report.before.chars)
})
check('reports what it removed and compressed', () => {
  const dropped = gemini.report.droppedSections.map((entry) => entry.name)
  assert.ok(dropped.includes('ui:deliverable-file-references'))
  assert.ok(gemini.report.compressed.some((entry) => entry.name === 'context:file-reference'))
})

console.log('families and switches')
check('uses the Claude identity for Claude models', () => {
  const claude = transformPresentation(synthetic('claude-opus-4-6-thinking'), { model: 'claude-opus-4-6-thinking', config: normalizeConfig({}) })
  const identity = claude.presentation.sections.find((section) => section.name === 'harness:identity')
  assert.equal(identity.text, CLAUDE_IDENTITY)
})
check('keepSections overrides a drop', () => {
  const config = normalizeConfig({ keepSections: ['ui:deliverable-file-references'] })
  const result = transformPresentation(synthetic(), { model: 'gemini-4-argon-high', config })
  assert.equal(result.presentation.sections.some((section) => section.name === 'ui:deliverable-file-references'), true)
})
check('replaceIdentity=false keeps the original identity sentence', () => {
  const config = normalizeConfig({ replaceIdentity: false })
  const result = transformPresentation(synthetic(), { model: 'gemini-4-argon-high', config })
  const identity = result.presentation.sections.find((section) => section.name === 'harness:identity')
  assert.equal(identity.text, 'You are an AI agent powered by Coding Harness.')
})
check('adds the identity when the profile disabled it', () => {
  const presentation = synthetic()
  presentation.sections = presentation.sections.filter((section) => section.name !== 'harness:identity')
  const result = transformPresentation(presentation, { model: 'gemini-4-argon-high', config: normalizeConfig({}) })
  assert.equal(result.presentation.sections[0].name, 'harness:identity')
  assert.equal(result.presentation.sections[0].text, GEMINI_IDENTITY)
})
check('knowledgeRule and effortLine append to the identity', () => {
  const config = normalizeConfig({ knowledgeRule: 'Rule A.', effortLine: 'EFFORT LEVEL: 1.00.' })
  const result = transformPresentation(synthetic(), { model: 'gemini-4-argon-high', config })
  const identity = result.presentation.sections.find((section) => section.name === 'harness:identity')
  assert.ok(identity.text.startsWith(GEMINI_IDENTITY))
  assert.ok(identity.text.includes('Rule A.'))
  assert.ok(identity.text.endsWith('EFFORT LEVEL: 1.00.'))
})
check('scrub: [] disables literal replacement', () => {
  const config = normalizeConfig({ scrub: [] })
  const result = transformPresentation(synthetic(), { model: 'gemini-4-argon-high', config })
  assert.equal(joined(result.presentation).includes('DeepSeek Harness'), true)
})

console.log('listener')
{
  const listeners = []
  const ctx = { on: (event, listener) => listeners.push([event, listener]), logger: { warn() {} } }
  const dir = mkdtempSync(join(tmpdir(), 'model-prompts-'))
  const dump = join(dir, 'dump.json')
  try {
    apply(ctx, { models: ['gemini*'], dumpTo: dump })
    check('registers exactly one assemble listener', () => {
      assert.equal(listeners.length, 1)
      assert.equal(listeners[0][0], 'system-prompt/assemble')
    })
    const listener = listeners[0][1]
    const presentation = synthetic()

    const passInput = { ...presentation, variables: { model: 'go/deepseek-v4.1-flash' } }
    const passThrough = await listener(passInput, {}, async () => passInput)
    check('non-matching models pass through untouched', () => {
      assert.equal(passThrough, passInput)
    })

    const local = []
    const dryCtx = { on: (event, fn) => local.push([event, fn]), logger: { warn() {} } }
    apply(dryCtx, { models: ['gemini*'], dryRun: true, dumpTo: dump })
    const dry = await local[0][1](presentation, { modelSelection: { model: 'gemini-4-argon-high' } }, async () => presentation)
    check('dryRun returns the original presentation', () => {
      assert.equal(dry, presentation)
    })

    const tuned = await listener(presentation, { modelSelection: { model: 'gemini-4-argon-high' } }, async () => presentation)
    check('a Gemini assembly comes back tuned', () => {
      assert.notEqual(tuned, presentation)
      assert.equal(tuned.sections.some((section) => section.name === 'ui:deliverable-file-references'), false)
      assert.equal(joined(tuned).includes('DeepSeek Harness'), false)
    })
    check('dump is written for a matched model', () => {
      assert.equal(existsSync(dump), true)
      const payload = JSON.parse(readFileSync(dump, 'utf8'))
      assert.equal(payload.family, 'gemini')
      assert.ok(payload.after.chars < payload.before.chars)
      assert.ok(payload.droppedSections.length > 0)
      assert.equal('prompt' in payload, false)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const fixture = process.argv[2]
if (fixture !== undefined) {
  if (!existsSync(fixture)) {
    console.error(`\nfixture not found: ${fixture}`)
    process.exit(1)
  }
  const raw = JSON.parse(readFileSync(fixture, 'utf8'))
  const presentation = raw.presentation ?? raw
  const model = process.argv[3] ?? 'gemini-4-argon-high'
  const result = transformPresentation({
    sections: presentation.sections.map((section) => ({ name: section.name, text: section.text ?? '' })),
    contexts: (presentation.contexts ?? []).map((entry) => ({ name: entry.name, text: entry.text ?? '' })),
  }, { model, config: normalizeConfig({}) })
  console.log(`\nreal assembly replayed as ${model}`)
  console.log(`  before ${result.report.before.chars} chars / after ${result.report.after.chars} chars`)
  console.log('  kept:')
  for (const section of result.presentation.sections) {
    console.log(`    ${String(section.text.length).padStart(6)}  ${section.name}`)
  }
  console.log('  dropped:')
  for (const entry of result.report.droppedSections) {
    console.log(`    ${String(entry.chars).padStart(6)}  ${entry.name}`)
  }
  if (result.report.after.chars > 3000) {
    failures += 1
    console.log(`  FAIL tuned prompt is ${result.report.after.chars} chars, above the 3000-char target`)
  } else {
    console.log('  ok   tuned prompt stays inside the 2000-3000 char target')
  }
}

console.log(`\n${checks} checks, ${failures} failure(s)`)
if (failures > 0) process.exitCode = 1
