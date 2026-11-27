/** Windows parent-side launch and ownership for the private Job runner. */

import { controlPipe } from './control-spawn.ts'
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { devNull } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import { SubprocessError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  loadWin32ProcessBindings,
  probeCurrentTokenJobSupport,
} from '@deepseek-ai/dsh-win32-process'
import type { BoundProcessOwner, ManagedProcessLaunch } from './managed-owner.ts'
import {
  type SerializedRunnerError,
  type WindowsRunnerResult,
  deserializeRunnerError,
  parseWindowsRunnerResult,
} from './runner-protocol.ts'
import {
  runnerEnvironment,
  runnerInvocationAvailable,
  runnerStdio,
  spawnRunnerInvocation,
  WINDOWS_RUNNER_SELECTION,
} from './runner-launch.ts'
import type { RunnerInvocation } from './runner-launch.ts'

/** Maximum bytes of the private runner's own standard error retained for an abnormal-exit diagnostic. */
const RUNNER_STDERR_TAIL_BYTES = 4096

/**
 * Keep the last {@link RUNNER_STDERR_TAIL_BYTES} bytes of the private runner's standard error.
 * @param tail - bytes retained so far.
 * @param chunk - newly read bytes.
 * @returns the retained tail after appending `chunk`.
 */
function appendRunnerStderrTail(tail: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([tail, chunk])
  return combined.length <= RUNNER_STDERR_TAIL_BYTES
    ? combined
    : combined.subarray(combined.length - RUNNER_STDERR_TAIL_BYTES)
}

/**
 * Decode a retained runner standard-error tail, dropping a leading partial character and surrounding whitespace.
 * @param tail - retained runner standard-error bytes.
 * @returns UTF-8 text for the failure detail.
 */
function runnerStderrText(tail: Buffer): string {
  return tail.toString('utf8').replace(/^\uFFFD+/u, '').trim()
}

/**
 * Format the private runner's exit status, adding the unsigned 32-bit hex form of a nonzero exit code.
 * @param exitCode - runner exit code, or null when it reported no status.
 * @param signal - signal that terminated the runner, or null when it exited by status.
 * @returns a status phrase for the failure detail.
 */
function runnerExitStatus(exitCode: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) return `signal ${signal}`
  if (exitCode === null) return 'without an exit status'
  if (exitCode === 0) return 'exit code 0'
  return `exit code ${String(exitCode)} (0x${(exitCode >>> 0).toString(16).toUpperCase()})`
}

/**
 * Append a nonempty runner standard-error tail to a private-runner failure detail.
 * @param detail - failure detail naming the runner failure.
 * @param stderrTail - retained runner standard error.
 * @returns the detail, with `; runner stderr: <tail>` appended when the tail is nonempty.
 */
function withRunnerStderr(detail: string, stderrTail: string): string {
  return stderrTail === '' ? detail : `${detail}; runner stderr: ${stderrTail}`
}

/** Classify a failure on the private runner channel, keeping an already coded failure. */
function runnerIpcFailure(error: unknown): SubprocessError {
  if (error instanceof SubprocessError) return error
  return new SubprocessError(
    `subprocess-local: Windows runner IPC failed: ${String(error)}`,
    'SUBPROCESS_RUNNER_IPC_FAILED',
    { cause: error },
  )
}

/** Test seams for runner launch and dynamic capability checks. */
export interface WindowsJobInternals {
  spawn?: typeof spawn
  runnerInvocation?: RunnerInvocation
  resolveRunnerInvocation?: () => RunnerInvocation
  runnerAvailable?: (invocation: RunnerInvocation) => boolean
  loadWin32ProcessBindings?: typeof loadWin32ProcessBindings
  probeCurrentTokenJobSupport?: typeof probeCurrentTokenJobSupport
}

type RunnerProcess = Omit<ReturnType<typeof spawn>, 'send' | 'stdio'> & {
  send?: ReturnType<typeof spawn>['send']
  stdio: Array<Readable | Writable | null>
}

function isWindowsStartCancellationError(error: SerializedRunnerError): boolean {
  return error.name === 'Error'
    && error.message === 'subprocess target start was cancelled'
    && error.code === undefined
    && error.syscall === undefined
    && error.path === undefined
}

/**
 * Re-check the runner entry, bindings, and current Job capability for every spawn.
 * @param internals - optional runner and Win32 capability seams used by tests.
 * @returns whether the Windows native containment path is currently available.
 */
export function probeWindowsJob(internals: WindowsJobInternals = {}): boolean {
  try {
    const invocation = internals.runnerInvocation
      ?? (internals.resolveRunnerInvocation ?? spawnRunnerInvocation)()
    if (!(internals.runnerAvailable ?? runnerInvocationAvailable)(invocation)) return false
    const api = (internals.loadWin32ProcessBindings ?? loadWin32ProcessBindings)()
    ;(internals.probeCurrentTokenJobSupport ?? probeCurrentTokenJobSupport)(api)
    return true
  } catch {
    return false
  }
}

class WindowsJobOwner implements BoundProcessOwner {
  private cancellationReason: unknown
  private cancellationReasonSet = false
  private terminationSent = false

  constructor(
    private readonly runner: RunnerProcess,
    private readonly exited: Promise<void>,
    private readonly directResultType: () => WindowsRunnerResult['type'] | undefined,
    private readonly failInfrastructure: (error: unknown) => void,
  ) {
    void this.exited.catch(() => {})
  }

  signal(_signal: 'SIGTERM' | 'SIGKILL', cancellationReason?: unknown): void {
    if (!this.cancellationReasonSet) {
      this.cancellationReason = cancellationReason
      this.cancellationReasonSet = true
    }
    if (this.terminationSent || !this.runner.connected) return
    this.terminationSent = true
    try {
      this.runner.send?.({ type: 'terminate' }, (error) => {
        if (error === null || this.directResultType() !== undefined) return
        this.failInfrastructure(error)
        this.terminateForHostExit()
      })
    } catch (error) {
      this.failInfrastructure(error)
      this.terminateForHostExit()
    }
  }

  mapStartFailure(failure: unknown, serialized: SerializedRunnerError): unknown {
    return this.cancellationReasonSet && isWindowsStartCancellationError(serialized)
      ? this.cancellationReason
      : failure
  }

  async waitForExit(): Promise<void> {
    await this.exited
  }

  terminateForHostExit(): void {
    try { this.runner.kill('SIGKILL') } catch (_runnerKillFailed) { /* Host exit continues with other live runners. */ }
  }
}

/**
 * Launch one target through a runner that uniquely owns its Job handle.
 * @param spec - ordinary target request.
 * @param targetEnv - validated complete target environment.
 * @param internals - optional runner launch seams used by tests.
 * @returns direct streams, result, and runner-owned managed range.
 */
export function launchWindowsJob(
  spec: SubprocessSpawnSpec,
  targetEnv: Record<string, string>,
  internals: WindowsJobInternals = {},
): ManagedProcessLaunch {
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const [command, ...prefix] = invocation
  const ignoredStdinFd = spec.stdio.stdin === 'ignore' ? openSync(devNull, 'r') : undefined
  let child: RunnerProcess
  try {
    child = (internals.spawn ?? spawn)(command, [
      ...prefix,
      '--',
      ...spec.argv,
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      env: runnerEnvironment(WINDOWS_RUNNER_SELECTION, invocation),
      stdio: runnerStdio(spec, true, ignoredStdinFd ?? 'pipe'),
    }) as RunnerProcess
  } finally {
    if (ignoredStdinFd !== undefined) closeSync(ignoredStdinFd)
  }
  const targetStdin = child.stdio[4] as Writable | null
  const runnerStderr = child.stdio[2] as Readable | null
  let stderrTail = Buffer.alloc(0)
  /* v8 ignore next -- the Windows runner stdio always pipes fd 2; the guard contains only a custom spawn seam. */
  if (runnerStderr !== null) {
    runnerStderr.on('data', (chunk: Buffer) => {
      stderrTail = appendRunnerStderrTail(stderrTail, chunk)
    })
  }

  const direct = Promise.withResolvers<SubprocessOutcome>()
  const rangeExit = Promise.withResolvers<void>()
  let directResultType: WindowsRunnerResult['type'] | undefined
  let runnerSpawned = false
  let runnerExit: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined
  let ipcDisconnected = false
  const failInfrastructure = (error: unknown): void => {
    direct.reject(error)
    rangeExit.reject(error)
  }
  const settleRange = (): void => {
    if (!runnerSpawned || runnerExit === undefined) return
    const { exitCode, signal } = runnerExit
    if (exitCode === 0 && signal === null) {
      if (directResultType !== undefined) {
        rangeExit.resolve()
        return
      }
      // The private IPC result may arrive after the process-exit notification.
      if (!ipcDisconnected) return
    }
    const status = runnerExitStatus(exitCode, signal)
    failInfrastructure(new SubprocessError(
      withRunnerStderr(
        `subprocess-local: Windows Job runner exited with ${status} before proving its managed range empty`,
        runnerStderrText(stderrTail),
      ),
      'SUBPROCESS_RUNNER_FAILED',
    ))
  }

  const owner = new WindowsJobOwner(
    child,
    rangeExit.promise,
    () => directResultType,
    failInfrastructure,
  )
  child.on('message', (value: unknown) => {
    if (directResultType !== undefined) {
      const error = new SubprocessError('subprocess-local: Windows runner emitted more than one direct result', 'SUBPROCESS_RUNNER_IPC_FAILED')
      failInfrastructure(error)
      owner.terminateForHostExit()
      return
    }
    let result: ReturnType<typeof parseWindowsRunnerResult>
    try {
      result = parseWindowsRunnerResult(value)
    } catch (error) {
      failInfrastructure(new SubprocessError(
        `subprocess-local: Windows runner emitted a malformed result: ${String(error)}`,
        'SUBPROCESS_RUNNER_IPC_FAILED',
        { cause: error },
      ))
      owner.terminateForHostExit()
      return
    }
    directResultType = result.type
    if (result.type === 'target-exit') {
      direct.resolve({ exitCode: result.exitCode, signal: null })
    } else {
      direct.reject(owner.mapStartFailure(deserializeRunnerError(result.error), result.error))
    }
    settleRange()
  })
  child.once('spawn', () => {
    runnerSpawned = true
    try {
      if (child.send === undefined) {
        throw new SubprocessError('subprocess-local: Windows runner has no IPC channel', 'SUBPROCESS_RUNNER_IPC_FAILED')
      }
      child.send({ type: 'start', cwd: spec.cwd, env: targetEnv, ...spec.stdio.control === undefined ? {} : { control: spec.stdio.control } }, (error) => {
        if (error === null) return
        failInfrastructure(runnerIpcFailure(error))
        owner.terminateForHostExit()
      })
    } catch (error) {
      failInfrastructure(runnerIpcFailure(error))
      owner.terminateForHostExit()
    }
  })
  child.once('error', (error) => {
    if (!runnerSpawned) {
      direct.reject(error)
      rangeExit.resolve()
      return
    }
    failInfrastructure(new SubprocessError(
      withRunnerStderr(
        `subprocess-local: Windows Job runner failed after it started: ${String(error)}`,
        runnerStderrText(stderrTail),
      ),
      'SUBPROCESS_RUNNER_FAILED',
      { cause: error },
    ))
  })
  child.once('exit', (exitCode, signal) => {
    runnerExit = { exitCode, signal }
    settleRange()
  })
  child.once('disconnect', () => {
    ipcDisconnected = true
    settleRange()
  })

  return {
    stdin: spec.stdio.stdin === 'ignore' ? null : targetStdin,
    stdout: child.stdio[5] as Readable | null,
    stderr: child.stdio[6] as Readable | null,
    control: controlPipe(child, spec.stdio.control),
    direct: direct.promise,
    owner,
  }
}
