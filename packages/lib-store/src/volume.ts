// What a corpus is stored on: the filesystem and the free space of its volumes.
//
// The corpus is the only copy of what it archived, and it often lives on removable
// media. Two things went wrong there (issue #19): a corpus on a FAT32 stick, where
// macOS writes an AppleDouble `._` file beside every file and nothing warned before
// the first sync wrote into it, and a multi-hour sync that could run the disk full
// halfway. This module answers the two questions behind both — which filesystem,
// how much room — and turns the answers into refusals a sync makes before it writes.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/**
 * What matters about a filesystem for a corpus:
 *
 * - `fat32` — FAT (on a drive large enough for a corpus, FAT32): no extended
 *   attributes, so macOS writes a `._` companion beside every file; no journal; a
 *   4 GB file limit; 65,534 entries per directory.
 * - `exfat` — the first two, without the limits.
 * - `network` — SMB, NFS, AFP, WebDAV and the like: a lock from another host cannot
 *   be checked, and rename and fsync promise less than on a local disk.
 * - `local` — anything else this probe recognises: APFS, HFS+, ext4, btrfs, NTFS, ….
 */
export type FilesystemKind = "fat32" | "exfat" | "network" | "local";

/** The kinds `ka sync` refuses unless told otherwise (`--allow-fs`). */
export const REFUSED_FILESYSTEMS = ["fat32", "exfat"] as const satisfies readonly FilesystemKind[];

export type RefusedFilesystem = (typeof REFUSED_FILESYSTEMS)[number];

export interface FilesystemInfo {
  /** The system's own name for it: `apfs`, `msdos`, `exfat`, `ext4`, `smbfs`, …. */
  name: string;
  kind: FilesystemKind;
}

export interface VolumeSpace {
  /** Bytes a process without special privileges may still write (statfs `bavail`). */
  free: number;
  /** The volume's size in bytes. */
  total: number;
}

/**
 * The two questions asked of the volume a path is on. A path that does not exist yet
 * — a corpus before its first sync — is answered for its nearest existing ancestor,
 * which is where the directory will be created.
 */
export interface VolumeProbe {
  space(path: string): VolumeSpace;
  /** Undefined when this system cannot tell (Windows, an unrecognised type). */
  filesystem(path: string): FilesystemInfo | undefined;
}

/**
 * The free space a sync leaves on each volume it writes to, by default: 1 GB. A run
 * still needs room after its last document — the catalog is rewritten whole, through
 * a temporary copy, and grows with the corpus.
 */
export const DEFAULT_MIN_FREE_BYTES = 1_000_000_000;

/** `name` → kind, for the names macOS's `mount` and Linux's statfs magic give. */
const KIND_BY_NAME: Record<string, FilesystemKind> = {
  msdos: "fat32",
  vfat: "fat32",
  fat: "fat32",
  exfat: "exfat",
  smbfs: "network",
  cifs: "network",
  smb2: "network",
  smb: "network",
  nfs: "network",
  afpfs: "network",
  webdav: "network",
  ftp: "network",
  "9p": "network",
  ceph: "network",
  afs: "network",
};

/**
 * Linux's statfs `f_type` magic numbers (linux/magic.h), for the filesystems a corpus
 * is likely to meet. On Linux the number is fixed; on macOS it is a slot assigned when
 * the filesystem's driver loads, so there `mount` is asked instead.
 */
const LINUX_MAGIC: ReadonlyMap<number, string> = new Map([
  [0x4d44, "vfat"],
  [0x2011bab0, "exfat"],
  [0x6969, "nfs"],
  [0x517b, "smb"],
  [0xff534d42, "cifs"],
  [0xfe534d42, "smb2"],
  [0x01021997, "9p"],
  [0x00c36400, "ceph"],
  [0x5346414f, "afs"],
  [0xef53, "ext4"],
  [0x9123683e, "btrfs"],
  [0x58465342, "xfs"],
  [0x2fc12fc1, "zfs"],
  [0x01021994, "tmpfs"],
  [0x794c7630, "overlay"],
  [0x5346544e, "ntfs"],
  [0x65735546, "fuse"],
  [0xf15f, "ecryptfs"],
  [0x3153464a, "jfs"],
  [0x52654973, "reiserfs"],
  [0xf2f52010, "f2fs"],
]);

/** The kind a filesystem name stands for; anything not named above is local. */
export function filesystemKind(name: string): FilesystemKind {
  return KIND_BY_NAME[name.toLowerCase()] ?? "local";
}

/** The nearest ancestor of `path` (or `path` itself) that exists, with symlinks resolved. */
export function existingAncestor(path: string): string {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try {
    return realpathSync(current);
  } catch {
    return current;
  }
}

/**
 * One line of macOS's `mount`: `<device> on <mount point> (<type>, <option>, …)`. The
 * mount point may contain spaces ("/Volumes/My Stick"), so the type list is the last
 * parenthesis and the mount point everything between the first " on " and it.
 */
export function parseMountLine(line: string): { mountPoint: string; type: string } | undefined {
  const open = line.lastIndexOf(" (");
  const on = line.indexOf(" on ");
  if (open < 0 || on < 0 || on >= open || !line.endsWith(")")) return undefined;
  const type = line.slice(open + 2, -1).split(",")[0]?.trim();
  const mountPoint = line.slice(on + 4, open);
  return type === undefined || type === "" || mountPoint === "" ? undefined : { mountPoint, type };
}

/** The mount whose point is the longest prefix of `path` — the one `path` is on. */
export function mountFor(path: string, mounts: readonly { mountPoint: string; type: string }[]): { mountPoint: string; type: string } | undefined {
  let best: { mountPoint: string; type: string } | undefined;
  for (const mount of mounts) {
    const point = mount.mountPoint;
    const inside = point === sep || path === point || path.startsWith(point.endsWith(sep) ? point : point + sep);
    if (inside && (best === undefined || point.length > best.mountPoint.length)) best = mount;
  }
  return best;
}

function darwinFilesystem(path: string): string | undefined {
  let output: string;
  try {
    // `mount` with no arguments only lists; it reads the kernel's table, no privilege.
    output = execFileSync("/sbin/mount", [], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
  const mounts = output.split("\n").flatMap((line) => parseMountLine(line) ?? []);
  return mountFor(path, mounts)?.type;
}

function linuxFilesystem(path: string): string | undefined {
  const type = Number(statfsSync(path).type);
  const known = LINUX_MAGIC.get(type);
  if (known !== undefined) return known;
  // A type this table does not name: /proc/self/mounts still has its name.
  try {
    const mounts = readFileSync("/proc/self/mounts", "utf8")
      .split("\n")
      .flatMap((line) => {
        const [, point, fstype] = line.split(" ");
        // The kernel escapes a space in a mount point as \040.
        return point === undefined || fstype === undefined ? [] : [{ mountPoint: point.replace(/\\040/g, " "), type: fstype }];
      });
    return mountFor(path, mounts)?.type;
  } catch {
    return undefined;
  }
}

/** The probe of the machine this runs on. */
export const systemVolumes: VolumeProbe = {
  space(path) {
    const stats = statfsSync(existingAncestor(path));
    return { free: Number(stats.bavail) * Number(stats.bsize), total: Number(stats.blocks) * Number(stats.bsize) };
  },
  filesystem(path) {
    const at = existingAncestor(path);
    let name: string | undefined;
    try {
      name =
        process.platform === "darwin" ? darwinFilesystem(at) : process.platform === "linux" ? linuxFilesystem(at) : undefined;
    } catch {
      name = undefined;
    }
    return name === undefined ? undefined : { name, kind: filesystemKind(name) };
  },
};

/** Which of a corpus's directories a volume holds. */
export type VolumeRole = "corpus" | "blobs";

export interface VolumeCheckOptions {
  /** Refused kinds the caller accepts anyway (`--allow-fs`). */
  allowFilesystems?: readonly RefusedFilesystem[];
  /** Free space to keep (`--min-free`); default `DEFAULT_MIN_FREE_BYTES`, 0 checks none. */
  minFreeBytes?: number;
  probe?: VolumeProbe;
}

export interface VolumeReport {
  role: VolumeRole;
  path: string;
  /** Absent when the system cannot tell. */
  filesystem?: FilesystemInfo;
  /** Absent when the volume could not be asked (an unplugged blob drive). */
  space?: VolumeSpace;
  /** Reasons a sync refuses to write here. */
  problems: string[];
  /** What is worth knowing but does not stop a sync. */
  warnings: string[];
}

/** The directories a corpus writes to: its root, and the blob directory when it is named apart. */
export interface CorpusLocation {
  root: string;
  blobsRoot: string;
}

/**
 * Whether the documents are on a volume of their own to ask: a blob directory named
 * apart (`--blobs`), or a `<corpus>/blobs` that is a symbolic link elsewhere — which
 * the README offers as the other way to keep the documents on an external drive.
 */
export function blobsApart(location: CorpusLocation): boolean {
  if (!existsSync(location.blobsRoot)) return resolve(location.blobsRoot) !== resolve(location.root, "blobs");
  return existingAncestor(location.blobsRoot) !== join(existingAncestor(location.root), "blobs");
}

/**
 * Check the volumes a corpus is on: the root, and the blob directory when it is
 * named apart (`--blobs`). A FAT32 or exFAT volume is a problem unless allowed, a
 * network filesystem a warning, and less free space than `minFreeBytes` a problem.
 * Nothing is written.
 */
export function checkCorpusVolumes(location: CorpusLocation, options: VolumeCheckOptions = {}): VolumeReport[] {
  const probe = options.probe ?? systemVolumes;
  const minFree = options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  const allowed = new Set<FilesystemKind>(options.allowFilesystems ?? []);
  const roles: [VolumeRole, string][] = [["corpus", location.root]];
  if (blobsApart(location)) roles.push(["blobs", location.blobsRoot]);

  return roles.map(([role, path]) => {
    const report: VolumeReport = { role, path, problems: [], warnings: [] };
    const what = role === "corpus" ? `the corpus ${path}` : `the blob store ${path}`;
    // An unplugged blob drive has no volume to ask; the store names it
    // (`FileStore.blobStoreProblem`) as it always has.
    if (role === "blobs" && !existsSync(path)) return report;
    const filesystem = probe.filesystem(path);
    if (filesystem !== undefined) {
      report.filesystem = filesystem;
      const problem = filesystemProblem(filesystem, what, allowed);
      if (problem !== undefined) report.problems.push(problem);
      if (filesystem.kind === "network") {
        report.warnings.push(
          `${what} is on a network filesystem (${filesystem.name}): a lock left by a run on another machine cannot be ` +
            "checked, and a dropped connection mid-write can leave a file half-written. A local disk is safer.",
        );
      }
    }
    try {
      report.space = probe.space(path);
    } catch (err) {
      report.warnings.push(`could not ask how much space is free for ${what}: ${err instanceof Error ? err.message : String(err)}`);
      return report;
    }
    const low = lowSpaceProblem(report.space.free, minFree, what);
    if (low !== undefined) report.problems.push(low);
    return report;
  });
}

function filesystemProblem(filesystem: FilesystemInfo, what: string, allowed: ReadonlySet<FilesystemKind>): string | undefined {
  if (filesystem.kind !== "fat32" && filesystem.kind !== "exfat") return undefined;
  if (allowed.has(filesystem.kind)) return undefined;
  const label = filesystem.kind === "fat32" ? "FAT32" : "exFAT";
  return (
    `${what} is on ${label} (${filesystem.name}), which is unsuitable for the only copy of an archive: no extended ` +
    "attributes (macOS writes a ._ file beside every file) and no journal, so a crash or a pulled plug can damage it" +
    (filesystem.kind === "fat32" ? "; a 4 GB file limit and at most 65,534 entries per directory" : "") +
    `. Reformat it as APFS, HFS+ or ext4 — or pass --allow-fs ${filesystem.kind} to use it anyway.`
  );
}

/** Why `free` bytes are less than `minFree`, in words, or undefined. */
function lowSpaceProblem(free: number, minFree: number, what: string): string | undefined {
  if (minFree <= 0 || free >= minFree) return undefined;
  return `only ${formatBytes(free)} free for ${what}, less than the ${formatBytes(minFree)} to keep (--min-free)`;
}

/**
 * What a sync asks while it runs (`SyncOptions.space`): whether the documents still
 * to fetch fit, and — before each Anfrage — whether a volume has dropped below the
 * floor. Each answer is a reason to stop, or undefined.
 */
export interface SpaceGuard {
  /** Why `bytes` more of documents would leave less than the floor, or undefined. */
  fitProblem(bytes: number): string | undefined;
  /** Why the run must stop now, or undefined. */
  lowProblem(): string | undefined;
}

/**
 * The guard for a corpus: documents land in `blobsRoot`, records and the index in
 * `root`; both must keep `minFreeBytes` free. Asking costs one statfs per volume.
 */
export function spaceGuard(location: CorpusLocation, minFreeBytes = DEFAULT_MIN_FREE_BYTES, probe: VolumeProbe = systemVolumes): SpaceGuard {
  const volumes: [string, string][] = [[`the corpus ${location.root}`, location.root]];
  if (blobsApart(location)) volumes.push([`the blob store ${location.blobsRoot}`, location.blobsRoot]);
  const blobs = volumes[volumes.length - 1] as [string, string];
  // A volume that cannot be asked mid-run is not a reason to stop: the writes say
  // what is wrong with it, and the guard must not turn into the failure.
  const free = (path: string): number | undefined => {
    try {
      return probe.space(path).free;
    } catch {
      return undefined;
    }
  };
  return {
    fitProblem(bytes) {
      const [what, path] = blobs;
      const available = free(path);
      if (available === undefined || available - bytes >= minFreeBytes) return undefined;
      return (
        `the documents to fetch (≈ ${formatBytes(bytes)}) do not fit: ${formatBytes(available)} is free for ${what}` +
        (minFreeBytes > 0 ? `, and ${formatBytes(minFreeBytes)} of it is to be kept (--min-free)` : "")
      );
    },
    lowProblem() {
      if (minFreeBytes <= 0) return undefined;
      for (const [what, path] of volumes) {
        const available = free(path);
        const problem = available === undefined ? undefined : lowSpaceProblem(available, minFreeBytes, what);
        if (problem !== undefined) return problem;
      }
      return undefined;
    },
  };
}

const SIZE_UNITS: Record<string, number> = { "": 1, b: 1, k: 1e3, kb: 1e3, m: 1e6, mb: 1e6, g: 1e9, gb: 1e9, t: 1e12, tb: 1e12 };

/**
 * A size in bytes from "500M", "2 GB", "1.5G" or "0", in decimal units like
 * every size `ka` prints; undefined when it is not one.
 */
export function parseByteSize(text: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(text);
  if (match === null) return undefined;
  const factor = SIZE_UNITS[(match[2] ?? "").toLowerCase()];
  if (factor === undefined) return undefined;
  const bytes = Math.round(Number(match[1]) * factor);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

/** Why `text` is not a size `parseByteSize` reads, or undefined. */
export function byteSizeProblem(text: string): string | undefined {
  return parseByteSize(text) === undefined ? "Expected a size such as 500M, 2G or 0 (units B, K, M, G, T; decimal)." : undefined;
}

/** A byte count for people, in decimal units: "110 KB", "270 MB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${shown} ${units[unit]}`;
}
