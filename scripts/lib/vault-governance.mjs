import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

export const VAULT_TYPES = [
  'hub',
  'feature',
  'architecture',
  'decision',
  'glossary',
  'open-question',
  'meta',
];
export const VAULT_STATUSES = [
  'active',
  'implemented',
  'partial',
  'planned',
  'unknown',
  'superseded',
  'open',
  'proposed',
  'accepted',
  'deprecated',
];
export const VAULT_CONFIDENCES = ['Confirmed', 'Needs-confirmation'];
export const REQUIRED_FRONTMATTER = [
  'type',
  'status',
  'tags',
  'related',
  'last-updated',
  'last-verified',
  'source',
  'confidence',
];
export const STALE_WARN_DAYS = 30;
export const STALE_HARD_DAYS = 90;

function walkMarkdown(directory) {
  return readdirSync(directory).flatMap((name) => {
    const absolutePath = join(directory, name);
    if (statSync(absolutePath).isDirectory()) {
      return name === 'templates' ? [] : walkMarkdown(absolutePath);
    }
    return name.endsWith('.md') ? [absolutePath] : [];
  });
}

export function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const keyValue = line.match(/^([\w-]+):\s*(.*)$/);
    if (!keyValue) continue;
    const [, key, rawValue] = keyValue;
    const value = rawValue.trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      frontmatter[key] = inner
        ? inner.split(',').map((item) => item.trim())
        : [];
    } else {
      frontmatter[key] = value;
    }
  }
  return frontmatter;
}

export function validDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}

function dateValue(value) {
  return Date.parse(`${value}T00:00:00Z`);
}

export function findBodyDatesNewerThan(body, lastUpdated) {
  if (!validDate(lastUpdated)) return [];
  return [
    ...new Set(
      [...body.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)]
        .map((match) => match[0])
        .filter(validDate)
        .filter((value) => dateValue(value) > dateValue(lastUpdated)),
    ),
  ].sort();
}

export function extractBindingDecisionIds(authorityText) {
  const resolvedSection =
    authorityText
      .split(/^## B\./m, 1)[0]
      ?.split(/^## A\./m)
      .slice(1)
      .join('') ?? '';

  return [
    ...new Set(
      [...resolvedSection.matchAll(/^(\d+)\.\s+(.+)$/gm)]
        .filter((match) => !/\(agent (?:task|verification task)/i.test(match[2]))
        .map((match) => Number(match[1])),
    ),
  ].sort((left, right) => left - right);
}

export function extractDecisionDigestIds(digestText) {
  return [
    ...new Set(
      [...digestText.matchAll(/^\|\s*(\d+)\s*\|\s*[^|]+\|/gm)].map(
        (match) => Number(match[1]),
      ),
    ),
  ].sort((left, right) => left - right);
}

export function findMissingDecisionIds(authorityText, digestText) {
  const digestIds = new Set(extractDecisionDigestIds(digestText));
  return extractBindingDecisionIds(authorityText).filter(
    (decisionId) => !digestIds.has(decisionId),
  );
}

export function findResolvedUncheckedTasks(body) {
  const findings = [];
  for (const [index, line] of body.split(/\r?\n/).entries()) {
    const unchecked = line.match(/^\s*-\s*\[\s\]\s*(.+)$/);
    if (!unchecked) continue;
    const task = unchecked[1].trim();
    const emphasizedTitle = task.match(/^(?:~~)?\*\*([^*]+)\*\*/)?.[1] ?? '';
    const leadingMarker = task
      .replace(/^~~/, '')
      .replace(/^[^\p{L}\p{N}]*/u, '')
      .slice(0, 32);
    if (
      task.startsWith('~~') ||
      /\b(?:RESOLVED|CLOSED|SUPERSEDED|SHIPPED|DONE)\b/i.test(
        emphasizedTitle,
      ) ||
      /^(?:RESOLVED|CLOSED|SUPERSEDED|SHIPPED|DONE)\b/i.test(leadingMarker)
    ) {
      findings.push({ line: index + 1, task });
    }
  }
  return findings;
}

const STABLE_TASK_ID =
  /\b(?:DOC-P[01]-\d{3}|BUG-\d{3}|AA-GAP-\d{2}|R\d+[a-z]?|T\d+(?:\.\d+)?)\b/gi;

export function findTaskStatusConflicts(notes) {
  const statesById = new Map();

  for (const note of notes) {
    for (const [index, line] of note.body.split(/\r?\n/).entries()) {
      const checkbox = line.match(/^\s*-\s*\[([ xX])\]/);
      if (!checkbox) continue;
      const state = checkbox[1].toLowerCase() === 'x' ? 'closed' : 'open';
      const taskTitle =
        line.match(
          /^\s*-\s*\[[ xX]\]\s*(?:~~)?\*\*([^*]+)\*\*/,
        )?.[1] ?? '';
      for (const match of taskTitle.matchAll(STABLE_TASK_ID)) {
        const id = match[0].toUpperCase();
        const records = statesById.get(id) ?? [];
        if (
          !records.some(
            (record) =>
              record.state === state &&
              record.rel === note.rel &&
              record.line === index + 1,
          )
        ) {
          records.push({ state, rel: note.rel, line: index + 1 });
        }
        statesById.set(id, records);
      }
    }
  }

  return [...statesById.entries()]
    .filter(([, records]) => new Set(records.map((record) => record.state)).size > 1)
    .map(([id, records]) => ({ id, records }));
}

function sourceToPath(entry) {
  return entry
    .split(' ')[0]
    .replace(/:[\d,–-]+$/, '')
    .replace(/[),.;]+$/, '');
}

const REPOSITORY_PATH_PREFIX =
  /^(?:\.(?:agent|agents|claude|codex|github|githooks)\/|app\/|components\/|design-system\/|docs\/|lib\/|public\/|scripts\/|types\/|vault\/|(?:AGENTS|CLAUDE|GEMINI|README)\.md$|package(?:-lock)?\.json$|vitest[^/]*\.ts$)/;

/**
 * Is this path deliberately gitignored? Cached per repository root — `git
 * check-ignore` is a process spawn, and this runs across every note.
 * Fails OPEN (returns false) when git is unavailable, so a missing path is still
 * reported rather than silently excused.
 */
const gitIgnoreCache = new Map();
const ignoreKey = (repositoryRoot, relativePath) => `${repositoryRoot}\u0000${relativePath}`;
function isGitIgnored(repositoryRoot, relativePath) {
  const key = ignoreKey(repositoryRoot, relativePath);
  if (gitIgnoreCache.has(key)) return gitIgnoreCache.get(key);
  /*
   * Asked twice: as the path itself, then as a file INSIDE it.
   *
   * `git check-ignore` can only match a directory-only pattern (`foo/bar/`) when it
   * can tell the path is a directory, and the only way it knows that is by looking at
   * the working tree. So the same query matched on a machine where the directory
   * happened to exist and missed in a clean checkout where it never does -- exactly
   * the local-passes/CI-fails divergence this exemption exists to eliminate,
   * reintroduced one layer down. Verified in an isolated repo: with `a/b/` ignored,
   * `check-ignore a/b` matches only while `a/b` is present on disk.
   *
   * The child probe resolves it because a `foo/` pattern matches everything beneath
   * `foo`, and a child path is unambiguously a file, so the answer is a property of
   * .gitignore rather than of the filesystem.
   *
   * Asking with a trailing slash instead (`check-ignore 'foo/'`) looks like the
   * obvious fix and is WRONG here: in this repository it returns "ignored" for every
   * directory path, including `totally-unrelated/`, which silently turns this whole
   * rule off. It was caught by planting a missing non-ignored path and finding the
   * linter no longer reported it.
   */
  const probes = [relativePath, `${relativePath}/.gitkeep-probe`];
  let ignored = false;
  for (const candidate of probes) {
    try {
      execFileSync('git', ['check-ignore', '-q', '--', candidate], {
        cwd: repositoryRoot,
        stdio: 'ignore',
      });
      ignored = true;
      break;
    } catch {
      // exit 1 = not ignored; any other failure is treated the same (fails OPEN)
    }
  }
  gitIgnoreCache.set(key, ignored);
  return ignored;
}

/**
 * Answers many isGitIgnored questions with one `git check-ignore --stdin`, asking the same
 * two probes per path. One spawn per path cost 15 s across `docs/` on Windows (doc 36 S4).
 * On any failure but "nothing ignored" (exit 1) the cache stays empty, so isGitIgnored
 * still asks path by path.
 */
export function primeGitIgnoreCache(repositoryRoot, relativePaths) {
  const todo = [...new Set(relativePaths)].filter(
    (p) => !gitIgnoreCache.has(ignoreKey(repositoryRoot, p)),
  );
  if (todo.length === 0) return;
  let output = '';
  try {
    output = execFileSync('git', ['check-ignore', '--stdin', '-z'], {
      cwd: repositoryRoot,
      input: `${todo.flatMap((p) => [p, `${p}/.gitkeep-probe`]).join('\0')}\0`,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (error) {
    if (error?.status !== 1) return;
  }
  const ignored = new Set(output.split('\0').filter(Boolean));
  for (const p of todo) {
    gitIgnoreCache.set(
      ignoreKey(repositoryRoot, p),
      ignored.has(p) || ignored.has(`${p}/.gitkeep-probe`),
    );
  }
}

/** Repository paths a body cites in backticks, minus those whose sentence says they are gone. */
export function inlinePathCandidates(body) {
  const candidates = [];
  for (const match of body.matchAll(/`([^`\r\n]+)`/g)) {
    const rawValue = match[1].trim();
    if (
      !REPOSITORY_PATH_PREFIX.test(rawValue) ||
      /[*|<>{}]/.test(rawValue) ||
      /^https?:\/\//.test(rawValue)
    ) {
      continue;
    }

    const context = body
      .slice(
      Math.max(0, match.index - 100),
      Math.min(body.length, match.index + match[0].length + 100),
      )
      .replace(match[0], '');
    if (
      /\b(?:deleted|removed|missing|non-?existent|no longer exists|recover(?:able)? from git|superseded)\b/i.test(
        context,
      )
    ) {
      continue;
    }

    const relativePath = sourceToPath(
      rawValue.split(/[?#]/, 1)[0].replace(/\/$/, ''),
    );
    if (relativePath) candidates.push(relativePath);
  }
  return candidates;
}

export function findMissingInlinePaths(repositoryRoot, body) {
  // A gitignored path is SUPPOSED to be absent from a clean checkout — it is a
  // runtime artifact, not a broken reference. Checking only existsSync made this
  // rule pass on a working machine (where the file had been created) and fail in
  // CI (where it never exists), which is a false positive that no amount of
  // rewording the documentation can honestly fix.
  const findings = inlinePathCandidates(body).filter(
    (relativePath) =>
      !existsSync(join(repositoryRoot, relativePath)) &&
      !isGitIgnored(repositoryRoot, relativePath),
  );
  return [...new Set(findings)].sort();
}

export const ACTIVE_CONTEXT_MAX_LINES = 80;
export const ACTIVE_CONTEXT_MAX_LATEST = 3;

/**
 * Doc 36 C2: every agent reads Active-Context at the start of every task, so its size is
 * paid on every task. It held 10 "Latest" entries and 12 KB when its own header said 3 and
 * ~80 lines; a budget no check enforces is a wish. Also catches UTF-8 read as Latin-1
 * ("Â§"), which garbled three lines of it.
 * @param {string} text the whole note
 * @returns {string[]} one message per breach
 */
export function findActiveContextOverBudget(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const problems = [];
  if (lines.length > ACTIVE_CONTEXT_MAX_LINES) {
    problems.push(`${lines.length} lines, over the ${ACTIVE_CONTEXT_MAX_LINES}-line budget; move detail to _meta/active-context-archive-* or the feature notes`);
  }
  const start = lines.findIndex((line) => line.startsWith('## Latest'));
  if (start >= 0) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => line.startsWith('## '));
    const entries = (end < 0 ? rest : rest.slice(0, end)).filter((line) => line.startsWith('- **')).length;
    if (entries > ACTIVE_CONTEXT_MAX_LATEST) {
      problems.push(`"Latest" holds ${entries} entries, over ${ACTIVE_CONTEXT_MAX_LATEST}; move the oldest to _meta/active-context-archive-*`);
    }
  }
  if (/Â[§·]/.test(text)) problems.push('mojibake ("Â§" or "Â·"): the file was decoded as Latin-1 somewhere; restore the UTF-8 sign');
  return problems;
}

function ageInDays(date, now) {
  return Math.floor((now.getTime() - dateValue(date)) / 86_400_000);
}

export function auditVault(repositoryRoot, now = new Date()) {
  const vaultRoot = join(repositoryRoot, 'vault');
  const errors = [];
  const warnings = [];
  const files = walkMarkdown(vaultRoot);
  const noteNames = new Set(
    files.map((file) => file.split(sep).pop().replace(/\.md$/, '')),
  );
  const inlinks = new Map([...noteNames].map((name) => [name, 0]));
  const parsed = files.map((file) => {
    const rel = relative(repositoryRoot, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    const frontmatter = parseFrontmatter(text);
    const body = text.replace(/^---[\s\S]*?---/, '');
    return { file, rel, text, body, frontmatter };
  });

  for (const note of parsed) {
    const { rel, body, frontmatter } = note;
    if (!frontmatter) {
      errors.push(`${rel}: no frontmatter block`);
      continue;
    }

    for (const key of REQUIRED_FRONTMATTER) {
      if (!(key in frontmatter)) {
        errors.push(`${rel}: missing frontmatter key '${key}'`);
      }
    }
    if (
      frontmatter.type &&
      !VAULT_TYPES.includes(frontmatter.type)
    ) {
      errors.push(`${rel}: invalid type '${frontmatter.type}'`);
    }
    if (
      frontmatter.status &&
      !VAULT_STATUSES.includes(frontmatter.status)
    ) {
      errors.push(`${rel}: invalid status '${frontmatter.status}'`);
    }
    if (
      frontmatter.confidence &&
      !VAULT_CONFIDENCES.includes(frontmatter.confidence)
    ) {
      errors.push(`${rel}: invalid confidence '${frontmatter.confidence}'`);
    }
    for (const key of ['last-updated', 'last-verified']) {
      if (frontmatter[key] && !validDate(frontmatter[key])) {
        errors.push(`${rel}: '${key}' is not a valid YYYY-MM-DD date`);
      }
    }

    const newerBodyDates = findBodyDatesNewerThan(
      body,
      frontmatter['last-updated'],
    );
    if (newerBodyDates.length > 0) {
      errors.push(
        `${rel}: body contains date(s) newer than last-updated: ${newerBodyDates.join(', ')}`,
      );
    }

    if (
      frontmatter.confidence === 'Confirmed' &&
      validDate(frontmatter['last-updated']) &&
      validDate(frontmatter['last-verified']) &&
      dateValue(frontmatter['last-updated']) >
        dateValue(frontmatter['last-verified'])
    ) {
      errors.push(
        `${rel}: confidence is Confirmed but last-updated is newer than last-verified`,
      );
    }

    if (validDate(frontmatter['last-verified'])) {
      const days = ageInDays(frontmatter['last-verified'], now);
      if (days < 0) {
        continue;
      } else if (
        days > STALE_HARD_DAYS &&
        frontmatter.confidence === 'Confirmed'
      ) {
        errors.push(
          `${rel}: confidence is Confirmed but last-verified is ${days} days old (>${STALE_HARD_DAYS}d)`,
        );
      } else if (days > STALE_HARD_DAYS) {
        warnings.push(
          `${rel}: not re-verified in ${days} days (>${STALE_HARD_DAYS}d hard threshold)`,
        );
      } else if (days > STALE_WARN_DAYS) {
        warnings.push(
          `${rel}: not re-verified in ${days} days (>${STALE_WARN_DAYS}d)`,
        );
      }
    }

    const sources = Array.isArray(frontmatter.source)
      ? frontmatter.source
      : frontmatter.source
        ? [frontmatter.source]
        : [];
    if (sources.length === 0 && frontmatter.type !== 'meta') {
      errors.push(
        `${rel}: empty 'source' — every non-meta note must cite its grounding`,
      );
    }
    for (const entry of sources) {
      const sourcePath = sourceToPath(entry);
      if (!existsSync(join(repositoryRoot, sourcePath))) {
        errors.push(
          `${rel}: source path does not exist: '${sourcePath}' (from '${entry}')`,
        );
      }
    }

    const related = Array.isArray(frontmatter.related)
      ? frontmatter.related
      : [];
    for (const relatedNote of related) {
      if (relatedNote && !noteNames.has(relatedNote)) {
        errors.push(
          `${rel}: related entry '${relatedNote}' is not an existing note`,
        );
      }
    }

    for (const match of body.matchAll(/\[\[([^\]|#]+)/g)) {
      const target = match[1].trim();
      if (noteNames.has(target)) {
        inlinks.set(target, inlinks.get(target) + 1);
      } else if (
        !existsSync(
          join(repositoryRoot, target.endsWith('.md') ? target : `${target}.md`),
        )
      ) {
        errors.push(`${rel}: broken wikilink [[${target}]]`);
      }
    }

    if (rel !== 'vault/_CHANGELOG.md') {
      for (const missingPath of findMissingInlinePaths(repositoryRoot, body)) {
        errors.push(
          `${rel}: inline repository path does not exist: '${missingPath}'`,
        );
      }
    }

    for (const finding of findResolvedUncheckedTasks(body)) {
      errors.push(
        `${rel}:${finding.line}: unchecked task is explicitly closed or superseded`,
      );
    }
  }

  const decisionsNote = parsed.find(
    (note) => note.rel === 'vault/Decisions.md',
  );
  const authorityPath = join(repositoryRoot, 'docs', 'OPEN_QUESTIONS.md');
  if (decisionsNote && existsSync(authorityPath)) {
    const missingDecisionIds = findMissingDecisionIds(
      readFileSync(authorityPath, 'utf8'),
      decisionsNote.text,
    );
    if (missingDecisionIds.length > 0) {
      errors.push(
        `vault/Decisions.md: binding decision IDs missing from digest: ${missingDecisionIds.join(', ')}`,
      );
    }
  }

  const activeContext = parsed.find((note) => note.rel === 'vault/Active-Context.md');
  if (activeContext) {
    for (const problem of findActiveContextOverBudget(activeContext.text)) {
      errors.push(`vault/Active-Context.md: ${problem}`);
    }
  }

  const currentTaskNotes = parsed
    .filter(
      (note) =>
        note.frontmatter &&
        note.rel !== 'vault/_CHANGELOG.md' &&
        note.frontmatter.status !== 'superseded' &&
        note.frontmatter.status !== 'deprecated',
    )
    .map((note) => ({ rel: note.rel, body: note.body }));
  for (const conflict of findTaskStatusConflicts(currentTaskNotes)) {
    errors.push(
      `stable task ${conflict.id} has conflicting current checkbox states: ${conflict.records
        .map(
          (record) =>
            `${record.state} at ${record.rel}:${record.line}`,
        )
        .join(', ')}`,
    );
  }

  for (const note of parsed) {
    const name = note.file.split(sep).pop().replace(/\.md$/, '');
    if (name === '_START-HERE') continue;
    if ((inlinks.get(name) ?? 0) === 0) {
      warnings.push(`${note.rel}: orphan — no note links to it`);
    }
  }

  const score = Math.max(
    0,
    100 - 5 * errors.length - 2 * warnings.length,
  );
  return {
    noteCount: parsed.length,
    errors,
    warnings,
    score,
  };
}
