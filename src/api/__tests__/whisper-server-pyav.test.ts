/**
 * Issue #155: faster-whisper passes metadata_errors to av.open(), but PyAV
 * 19 removed that keyword. Run the real server script with small fake modules
 * so this checks the compatibility boundary without downloading a model.
 *
 * Run: npx vitest run src/api/__tests__/whisper-server-pyav.test.ts
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repo = join(__dirname, '../../..')

const fakeAv = `
class _Container:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False


def open(*args, **kwargs):
    if "metadata_errors" in kwargs:
        raise TypeError("open() got an unexpected keyword argument 'metadata_errors'")
    return _Container()
`

const fakeFasterWhisper = `
import av


class _Segment:
    text = "hello from fake audio"


class _Info:
    language = "en"


class WhisperModel:
    def __init__(self, *args, **kwargs):
        pass

    def transcribe(self, audio_path):
        with av.open(audio_path, mode="r", metadata_errors="ignore"):
            pass
        return [_Segment()], _Info()
`

function runServer(script: string): Record<string, unknown>[] {
  const modules = mkdtempSync(join(tmpdir(), 'locally-uncensored-whisper-'))
  const audio = join(modules, 'sample.wav')
  writeFileSync(join(modules, 'av.py'), fakeAv)
  writeFileSync(join(modules, 'faster_whisper.py'), fakeFasterWhisper)
  writeFileSync(audio, 'not real audio, only a path for the stub')

  try {
    const pythonPath = [modules, process.env.PYTHONPATH]
      .filter((value): value is string => Boolean(value))
      .join(delimiter)
    const output = execFileSync('python3', [script], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: pythonPath },
      input: [
        JSON.stringify({ action: 'status' }),
        JSON.stringify({ action: 'transcribe', path: audio }),
        JSON.stringify({ action: 'quit' }),
        '',
      ].join('\n'),
      timeout: 30_000,
    })
    return output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } finally {
    rmSync(modules, { recursive: true, force: true })
  }
}

describe('#155 PyAV 19 compatibility', () => {
  it.each(['public/whisper_server.py', 'src-tauri/resources/whisper_server.py'])(
    'transcribes when %s receives the keyword removed by PyAV 19',
    (relativeScript) => {
      const responses = runServer(join(repo, relativeScript))
      expect(responses).toEqual([
        { status: 'ready', backend: 'faster-whisper' },
        { status: 'ready', backend: 'faster-whisper' },
        { transcript: 'hello from fake audio', language: 'en' },
        { status: 'stopped' },
      ])
    },
  )

  it('keeps the development and packaged server copies identical', () => {
    expect(readFileSync(join(repo, 'public/whisper_server.py'), 'utf8'))
      .toBe(readFileSync(join(repo, 'src-tauri/resources/whisper_server.py'), 'utf8'))
  })
})
