import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = process.cwd()
const FEATURE_DIR = path.join(ROOT, 'src', 'features')
const REQUIRED_FEATURES = ['avatar', 'browser', 'config', 'session', 'tester', 'voice']
const TEMPORARY_SIZE_EXCEPTIONS = new Set([
  path.join(ROOT, 'server', 'browser', 'index.js'),
  path.join(ROOT, 'src', 'features', 'session', 'useConversationRuntimeController.js'),
])

function walkJsFiles(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkJsFiles(full, results)
      continue
    }
    if (/\.(js|jsx)$/.test(entry.name)) {
      results.push(full)
    }
  }
  return results
}

test('architecture doc exists', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'ARCHITECTURE.md')), true)
})

test('each feature has a public index entrypoint', () => {
  for (const feature of REQUIRED_FEATURES) {
    const featureIndex = path.join(FEATURE_DIR, feature, 'index.js')
    assert.equal(fs.existsSync(featureIndex), true, `Missing ${featureIndex}`)
  }
})

test('non-exception JS modules stay under 900 lines', () => {
  const files = [
    ...walkJsFiles(path.join(ROOT, 'src')),
    ...walkJsFiles(path.join(ROOT, 'server')),
  ]

  const oversized = files
    .filter((file) => !TEMPORARY_SIZE_EXCEPTIONS.has(file))
    .map((file) => ({
      file,
      lines: fs.readFileSync(file, 'utf8').split(/\r?\n/).length,
    }))
    .filter((entry) => entry.lines > 900)

  assert.deepEqual(oversized, [])
})

test('Google runtime models are not older than Gemini 3.1', () => {
  const files = [
    path.join(ROOT, 'demo-content', 'default-app-config.json'),
    path.join(ROOT, 'server', 'defaultAppConfig.js'),
    path.join(ROOT, 'src', 'hooks', 'geminiLiveShared.js'),
    path.join(ROOT, 'src', 'features', 'session', 'sessionModels.js'),
  ]

  const offenders = files.flatMap((file) => {
    const text = fs.readFileSync(file, 'utf8')
    const matches = text.match(/models\/gemini-(?!3\.1-)\d[\w.-]+|gemini-(?!3\.1-)\d[\w.-]+/g) || []
    return matches.map((modelId) => ({ file, modelId }))
  })

  assert.deepEqual(offenders, [])
})
