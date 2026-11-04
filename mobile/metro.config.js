// Metro configuration for the DDL Mate native client.
//
// Why this file exists (root cause, verified — see
// .supervision/ios-metro-restored-handoff.md):
//
// On this Windows volume, Node's `fs.readdir(..., {withFileTypes: true})`
// `Dirent` classification disagrees with `lstat` for OneDrive/cloud
// reparse-point files. For `mobile/node_modules/expo/src/Expo.ts` the Dirent
// reports `isSymbolicLink() === true`, while `lstatSync().isSymbolicLink()` is
// `false`, `isFile()` is `true`, and the file is fully readable (1318 bytes).
//
// Expo CLI swaps Metro's file map for `@expo/metro-file-map`, whose node crawler
// takes a cold-start shortcut that *trusts the Dirent* and stores
// `[/*mtime*/ null, /*size*/ 0, 0, null, /*SYMLINK*/ 1, null]` for such a file.
// TreeFS then treats `expo/src/Expo.ts` as a symlink with an unknown target, so
// Metro's `fileSystemLookup()` answers `exists: false` and metro-resolver throws
// "this package itself specifies a `main` module field that could not be
// resolved" — even though the file is present and readable on disk. Bypassing
// only the resolver then fails the next stage with
// "Failed to get the SHA-1 for: ...", because no consumer of the file map can
// see the file.
//
// The correction is generic and config-level only. Paths the file map refuses to
// resolve are re-validated with `lstat` — the same authority the file map's own
// fallback filesystem uses — and repaired with the file's real metadata through
// Metro's own `addOrModify`, so the resolver, the SHA-1 computation, the
// transform step, the serializer, and file watching all see a healthy entry.
// Paths the map resolves normally are never touched, so nothing is hidden,
// rewritten, or reordered. No file under `node_modules` is modified on disk and
// no file is copied.
//
// Installation point: the repair runs from `resolver.resolveRequest`, Metro's
// supported extension point for module resolution and the only hook that both
// runs while the dependency graph is being built and gives access to the live
// file map. A `DependencyGraph.prototype._createModuleResolver` wrap hands the
// graph's file system to that hook before the first module is resolved; if the
// internal shape ever changes, the wrap is a no-op and the hook degrades to a
// plain pass-through, leaving Metro exactly as it is today.
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { getDefaultConfig } = require('@expo/metro-config');
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

// Metro file metadata tuple: [mtime, size, visited, sha1, symlink, pluginData].
const MTIME = 0;
const SIZE = 1;
const VISITED = 2;
const SHA1 = 3;
const SYMLINK = 4;

// Directories that never contain app dependencies and would only slow the sweep.
const SKIPPED_DIRECTORIES = new Set(['.git', '.hg', '.cxx', '.expo']);

// One repair pass per file map. Metro builds a fresh file map for each graph
// generation, so a rebuilt map is repaired again on its own.
const repairedFileSystems = new WeakSet();

// The live file map, captured through the `DependencyGraph` wrap below. The
// reference is intentionally module-local: it points at the graph this config
// belongs to, never at global state.
let liveFileSystem = null;

/**
 * A repaired entry for a file `lstat` proved is a regular file. Zero in the
 * symlink slot marks a regular file; a null SHA-1 lets Metro compute it on
 * demand from the real file.
 */
function fileMetadata(onDisk) {
  const metadata = [];
  metadata[MTIME] = onDisk.modifiedTime;
  metadata[SIZE] = onDisk.size;
  metadata[VISITED] = 0;
  metadata[SHA1] = null;
  metadata[SYMLINK] = 0;
  // Trailing plugin-data slot, matching the crawler's tuple shape exactly.
  metadata[5] = null;
  return metadata;
}

/**
 * Normalise an `fs.Stats` object into the two values the metadata tuple needs.
 */
export function onDiskFromStats(stats) {
  return {
    modifiedTime: stats.mtimeMs,
    size: stats.size,
  };
}

/**
 * Walk `directory` and repair every file the file map refuses to resolve but
 * that `lstat` proves is a regular file on disk.
 *
 * The walk uses `readdirSync` only for names: it never consults
 * `Dirent.isSymbolicLink()`, which is the classification this volume gets wrong.
 * `lstatSync` is only called for a path the map already failed to resolve, so a
 * healthy tree costs one directory listing and no per-file syscall.
 */
function repairTree(fileSystem, directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let repaired = 0;
  for (const entry of entries) {
    const name = entry.name;
    if (SKIPPED_DIRECTORIES.has(name)) {
      continue;
    }
    const absolutePath = path.join(directory, name);
    const lookup = fileSystem.lookup(absolutePath);
    if (lookup != null && lookup.exists) {
      if (lookup.type === 'd') {
        repaired += repairTree(fileSystem, absolutePath);
      }
      continue;
    }
    let stats;
    try {
      stats = fs.lstatSync(absolutePath);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      repaired += repairTree(fileSystem, absolutePath);
      continue;
    }
    if (!stats.isFile()) {
      // Real symlinks and special files keep whatever the file map recorded.
      continue;
    }
    try {
      fileSystem.addOrModify(
        path.normalize(absolutePath),
        fileMetadata(onDiskFromStats(stats)),
      );
      repaired++;
    } catch {
      // Some paths (for example broken `.bin` shims) have no usable parent node
      // in the map. Skipping them keeps the sweep going for the rest.
    }
  }
  return repaired;
}

/**
 * Repair file-map entries that contradict the filesystem.
 *
 * Only two filesystem questions are ever asked: whether a directory listing
 * succeeds, and whether a path the map could not resolve is a regular file.
 * Returns `{repaired}`, or `null` when the file map is unusable. Never throws: a
 * failed correction must leave the build exactly as it was.
 */
export function repairMisclassifiedFiles(fileSystem, roots) {
  if (
    fileSystem == null ||
    typeof fileSystem.lookup !== 'function' ||
    typeof fileSystem.addOrModify !== 'function'
  ) {
    return null;
  }
  if (repairedFileSystems.has(fileSystem)) {
    return { repaired: 0, alreadyRepaired: true };
  }
  let repaired = 0;
  try {
    for (const root of roots) {
      if (typeof root === 'string' && fs.existsSync(root)) {
        repaired += repairTree(fileSystem, root);
      }
    }
  } catch {
    return null;
  }
  repairedFileSystems.add(fileSystem);
  return { repaired };
}

/**
 * Wrap `DependencyGraph.prototype._createModuleResolver` on every Metro copy
 * reachable from this config. The wrap only captures `this._fileSystem` for the
 * resolver hook; it does not change Metro's behaviour.
 *
 * `@expo/metro` ships both a `metro` shim tree and a nested real `metro` package;
 * whichever copy the server loads is patched, and patches are idempotent per
 * prototype.
 */
function captureLiveFileSystem() {
  const candidates = [
    '@expo/metro/metro/node-haste/DependencyGraph',
    'metro/private/node-haste/DependencyGraph',
  ];
  for (const moduleId of candidates) {
    let DependencyGraph;
    try {
      DependencyGraph = require(moduleId).default;
    } catch {
      continue;
    }
    if (
      DependencyGraph == null ||
      typeof DependencyGraph.prototype._createModuleResolver !== 'function'
    ) {
      continue;
    }
    const prototype = DependencyGraph.prototype;
    if (prototype.__ddlMateFileMapCapture === true) {
      continue;
    }
    const original = prototype._createModuleResolver;
    prototype._createModuleResolver = function _createModuleResolver() {
      if (this._fileSystem != null) {
        liveFileSystem = this._fileSystem;
      }
      return original.call(this);
    };
    Object.defineProperty(prototype, '__ddlMateFileMapCapture', {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

const config = getDefaultConfig(projectRoot);

// Metro's file map is rooted at the project root, so only paths under it can be
// repaired. `watchFolders` covers the project root plus any extra roots this
// config adds.
const repairRoots = Array.from(
  new Set([projectRoot, ...(config.watchFolders ?? [])]),
).filter((root) => typeof root === 'string' && fs.existsSync(root));

captureLiveFileSystem();

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver = {
  ...config.resolver,
  resolveRequest(context, moduleName, platform) {
    if (liveFileSystem != null) {
      try {
        repairMisclassifiedFiles(liveFileSystem, repairRoots);
      } catch {
        // Fail open: a failed correction must never break the build.
      }
    }
    if (typeof defaultResolveRequest === 'function') {
      return defaultResolveRequest(context, moduleName, platform);
    }
    const { resolve } = require('metro-resolver');
    return resolve(context, moduleName, platform);
  },
};

export default config;
