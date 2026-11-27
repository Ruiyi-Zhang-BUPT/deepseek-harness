/**
 * Canonical directory-boundary checks for the Windows ACL workspace and
 * private-temp capabilities, plus the WSL UNC namespace predicate.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/path-boundary
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

/** WSL's Windows-side UNC namespace roots, as their leading path text (lowercase: compared against a lowercased path). */
const WSL_UNC_ROOTS = [
  '\\\\wsl.localhost\\',
  '\\\\wsl$\\',
  '//wsl.localhost/',
  '//wsl$/',
  '\\\\?\\unc\\wsl.localhost\\',
  '\\\\?\\unc\\wsl$\\',
] as const

/**
 * Whether `path` starts at a WSL UNC namespace root (`\\wsl.localhost\…`,
 * `\\wsl$\…`, their forward-slash spellings, or an extended-length
 * `\\?\UNC\` spelling). WSL serves that namespace from its Windows-side
 * redirector, which implements no Windows security descriptors, so no ACL
 * grant can be read or written there. Other UNC shares, such as SMB, are not
 * matched.
 * @param path - the path to classify, in any casing.
 * @returns whether the path names content inside a WSL UNC namespace.
 */
export function isWslUncPath(path: string): boolean {
  const normalized = path.toLowerCase()
  return WSL_UNC_ROOTS.some(root => normalized.startsWith(root))
}

/** Whether `root` is the same canonical directory as `candidate` or contains it. */
function containsDirectory(root: string, candidate: string): boolean {
  const relation = relative(realpathSync.native(root), realpathSync.native(candidate))
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
}

/**
 * Whether a temp parent is inside the workspace, where every child created
 * below it would inherit the standing workspace capability.
 * @param workspaceRoot - the canonical workspace root that receives the standing ACE.
 * @param tempRoot - the existing parent beneath which a private temp child would be created.
 * @returns whether the canonical workspace contains the canonical temp root.
 * @throws the filesystem error when either directory cannot be resolved.
 */
export function isTempRootInsideWorkspace(workspaceRoot: string, tempRoot: string): boolean {
  return containsDirectory(workspaceRoot, tempRoot)
}

/**
 * Reject a temp parent that is inside the workspace (see {@link isTempRootInsideWorkspace}).
 * @param workspaceRoot - the canonical workspace root that receives the standing ACE.
 * @param tempRoot - the existing parent beneath which a private temp child would be created.
 */
export function assertTempRootOutsideWorkspace(workspaceRoot: string, tempRoot: string): void {
  if (isTempRootInsideWorkspace(workspaceRoot, tempRoot)) {
    throw new Error(`Windows ACL temp root must be outside the workspace: workspace=${workspaceRoot}; temp=${tempRoot}`)
  }
}

/**
 * Reject overlap between an actual private temp directory and any writable
 * directory: either inheritance direction would merge the two capabilities.
 * @param writableDirs - directories carrying the standing workspace capability.
 * @param tempDir - the existing directory carrying the revocable temp capability.
 */
export function assertPrivateTempDisjoint(writableDirs: readonly string[], tempDir: string): void {
  for (const writableDir of writableDirs) {
    if (containsDirectory(writableDir, tempDir) || containsDirectory(tempDir, writableDir)) {
      throw new Error(`AclSandbox private temp directory must be disjoint from writable directories: writable=${writableDir}; temp=${tempDir}`)
    }
  }
}
