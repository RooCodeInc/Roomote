import fs from 'node:fs/promises';
import path from 'node:path';

export const LOCAL_KNOWLEDGE_SCRIPT_PATHS = [
  '.agents/skills/agent-guidance-maintenance/scripts/knowledge-check.mjs',
  '.agents/skills/agent-guidance-maintenance/scripts/knowledge-garden.mjs',
  '.agents/skills/agent-guidance-maintenance/scripts/knowledge-lib.mjs',
  '.agents/skills/agent-guidance-maintenance/scripts/knowledge-scorecard.mjs',
];

const OPTIONAL_REPO_KNOWLEDGE_SCRIPT_PATHS = [
  'scripts/knowledge-check.mjs',
  'scripts/knowledge-garden.mjs',
  'scripts/knowledge-lib.mjs',
  'scripts/knowledge-scorecard.mjs',
];

export const SURFACE_MAP_PATH =
  '.agent-guidance/architecture/repository-surface-map.md';
const MAX_DOCUMENTED_SURFACES_PER_SHARED_DOC = 2;
const COMPLEX_SURFACE_CHILD_THRESHOLD = 8;
const MAX_DOCUMENTED_CHILD_SURFACES_PER_DOC = 4;

const IGNORED_SUBSURFACE_DIRECTORIES = new Set([
  '__fixtures__',
  '__generated__',
  '__mocks__',
  '__snapshots__',
  '__tests__',
  '.cache',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.turbo',
  '.vercel',
  '.vite',
  'assets',
  'audio',
  'build',
  'cache',
  'caches',
  'coverage',
  'dist',
  'doc',
  'docs',
  'fixture',
  'fixtures',
  'generated',
  'icons',
  'images',
  'locales',
  'logs',
  'media',
  'mock',
  'mocks',
  'node_modules',
  'out',
  'public',
  'storybook-static',
  'temp',
  'test',
  'tests',
  'tmp',
]);

function shouldIgnoreSubsurfaceDirectory(directoryName) {
  return IGNORED_SUBSURFACE_DIRECTORIES.has(directoryName);
}

function stripTrailingHeadingHashes(headingText) {
  return headingText.replace(/\s+#+\s*$/u, '').trim();
}

function normalizeHeadingLabel(headingText) {
  return stripTrailingHeadingHashes(headingText).trim().toLowerCase();
}

function normalizeMarkdownFragment(fragment) {
  if (typeof fragment !== 'string') {
    return null;
  }

  const normalized = decodeURIComponent(fragment)
    .replace(/^#/u, '')
    .trim()
    .toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function slugifyMarkdownHeading(headingText) {
  const normalized = stripTrailingHeadingHashes(headingText)
    .replace(/<[^>]+>/gu, '')
    .replace(/`/gu, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gu, '')
    .trim()
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');

  return normalized;
}

export function toRepoRelative(rootDir, absolutePath) {
  return path.relative(rootDir, absolutePath).split(path.sep).join('/');
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function walkFiles(dirPath, predicate = () => true) {
  const out = [];

  if (!(await pathExists(dirPath))) {
    return out;
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(absolute, predicate)));
      continue;
    }

    if (entry.isFile() && predicate(absolute)) {
      out.push(absolute);
    }
  }

  return out;
}

export function parseFrontmatter(markdown) {
  if (!markdown.startsWith('---\n')) {
    return { hasFrontmatter: false, frontmatter: {}, body: markdown };
  }

  const endIndex = markdown.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    return { hasFrontmatter: false, frontmatter: {}, body: markdown };
  }

  const rawFrontmatter = markdown.slice(4, endIndex).trim();
  const body = markdown.slice(endIndex + 5);
  const frontmatter = {};

  for (const line of rawFrontmatter.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/u);
    if (!match) {
      continue;
    }

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    frontmatter[match[1]] = value;
  }

  return { hasFrontmatter: true, frontmatter, body };
}

export function isValidDate(dateValue) {
  if (typeof dateValue !== 'string') {
    return false;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateValue)) {
    return false;
  }

  const date = new Date(`${dateValue}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().startsWith(`${dateValue}T`)
  );
}

export function daysSince(dateValue, now = new Date()) {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  const ms = now.getTime() - date.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function findMarkdownLinkLabelEnd(markdown, startIndex) {
  let depth = 0;

  for (let index = startIndex; index < markdown.length; index += 1) {
    const char = markdown[index];
    if (char === '\\') {
      index += 1;
      continue;
    }

    if (char === '[') {
      depth += 1;
      continue;
    }

    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function consumeMarkdownLinkDestination(markdown, openParenIndex) {
  let index = openParenIndex + 1;
  while (index < markdown.length && /\s/u.test(markdown[index])) {
    index += 1;
  }

  if (index >= markdown.length) {
    return null;
  }

  if (markdown[index] === '<') {
    const destinationStart = index + 1;
    index += 1;

    while (index < markdown.length) {
      const char = markdown[index];
      if (char === '\\') {
        index += 2;
        continue;
      }

      if (char === '>') {
        const destination = markdown.slice(destinationStart, index).trim();
        index += 1;
        const suffixStartIndex = index;

        while (index < markdown.length && /\s/u.test(markdown[index])) {
          index += 1;
        }

        if (markdown[index] !== ')') {
          if (index === suffixStartIndex) {
            return null;
          }

          const titleEndIndex = consumeMarkdownLinkTitleBeforeClosingParen(
            markdown,
            index,
          );
          if (titleEndIndex === null) {
            return null;
          }

          index = titleEndIndex;
        }

        return {
          destination,
          endIndex: index,
        };
      }

      index += 1;
    }

    return null;
  }

  const destinationStart = index;
  let depth = 1;

  while (index < markdown.length) {
    const char = markdown[index];
    if (char === '\\') {
      index += 2;
      continue;
    }

    if (char === '(') {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return {
          destination: markdown.slice(destinationStart, index).trim(),
          endIndex: index,
        };
      }
    }

    index += 1;
  }

  return null;
}

function consumeMarkdownLinkTitle(destinationText, startIndex) {
  let index = startIndex;
  while (index < destinationText.length && /\s/u.test(destinationText[index])) {
    index += 1;
  }

  if (index >= destinationText.length) {
    return null;
  }

  const opener = destinationText[index];
  const closer =
    opener === '"' || opener === "'" ? opener : opener === '(' ? ')' : null;
  if (!closer) {
    return null;
  }

  index += 1;
  while (index < destinationText.length) {
    const char = destinationText[index];
    if (char === '\\') {
      index += 2;
      continue;
    }

    if (char === closer) {
      index += 1;
      while (
        index < destinationText.length &&
        /\s/u.test(destinationText[index])
      ) {
        index += 1;
      }

      return index === destinationText.length ? startIndex : null;
    }

    index += 1;
  }

  return null;
}

function consumeMarkdownLinkTitleBeforeClosingParen(markdown, startIndex) {
  let index = startIndex;
  while (index < markdown.length && /\s/u.test(markdown[index])) {
    index += 1;
  }

  if (index >= markdown.length) {
    return null;
  }

  const opener = markdown[index];
  const closer =
    opener === '"' || opener === "'" ? opener : opener === '(' ? ')' : null;
  if (!closer) {
    return null;
  }

  index += 1;
  while (index < markdown.length) {
    const char = markdown[index];
    if (char === '\\') {
      index += 2;
      continue;
    }

    if (char === closer) {
      index += 1;
      while (index < markdown.length && /\s/u.test(markdown[index])) {
        index += 1;
      }

      return markdown[index] === ')' ? index : null;
    }

    index += 1;
  }

  return null;
}

function stripMarkdownLinkTitle(destinationText) {
  for (let index = 0; index < destinationText.length; index += 1) {
    const char = destinationText[index];
    if (char === '\\') {
      index += 1;
      continue;
    }

    if (!/\s/u.test(char)) {
      continue;
    }

    const titleStart = consumeMarkdownLinkTitle(destinationText, index);
    if (titleStart !== null) {
      return destinationText.slice(0, titleStart).trimEnd();
    }
  }

  return destinationText.trim();
}

export function extractMarkdownLinks(markdown) {
  const withoutCodeBlocks = markdown.replace(/```[\s\S]*?```/gu, '');
  const links = [];
  let index = 0;

  while (index < withoutCodeBlocks.length) {
    if (withoutCodeBlocks[index] !== '[') {
      index += 1;
      continue;
    }

    const labelEnd = findMarkdownLinkLabelEnd(withoutCodeBlocks, index);
    if (labelEnd === -1) {
      break;
    }

    let nextIndex = labelEnd + 1;
    while (
      nextIndex < withoutCodeBlocks.length &&
      /\s/u.test(withoutCodeBlocks[nextIndex])
    ) {
      nextIndex += 1;
    }

    if (withoutCodeBlocks[nextIndex] !== '(') {
      index = labelEnd + 1;
      continue;
    }

    const parsedDestination = consumeMarkdownLinkDestination(
      withoutCodeBlocks,
      nextIndex,
    );
    if (!parsedDestination) {
      index = nextIndex + 1;
      continue;
    }

    if (parsedDestination.destination.length > 0) {
      links.push(stripMarkdownLinkTitle(parsedDestination.destination));
    }

    index = parsedDestination.endIndex + 1;
  }

  return links;
}

export function shouldIgnoreLink(linkTarget) {
  if (!linkTarget) {
    return true;
  }

  const normalized = linkTarget.toLowerCase();
  return (
    normalized.startsWith('http://') ||
    normalized.startsWith('https://') ||
    normalized.startsWith('mailto:') ||
    normalized.startsWith('#') ||
    normalized.startsWith('data:')
  );
}

function splitMarkdownLinkTarget(linkTarget) {
  if (typeof linkTarget !== 'string') {
    return { targetPath: '', fragment: null };
  }

  const hashIndex = linkTarget.indexOf('#');
  if (hashIndex === -1) {
    return {
      targetPath: decodeURIComponent(linkTarget),
      fragment: null,
    };
  }

  const rawTargetPath = linkTarget.slice(0, hashIndex);
  const rawFragment = linkTarget.slice(hashIndex + 1);

  return {
    targetPath: rawTargetPath ? decodeURIComponent(rawTargetPath) : '',
    fragment: normalizeMarkdownFragment(rawFragment),
  };
}

export function resolveLinkTarget(filePath, linkTarget, rootDir) {
  const { targetPath } = splitMarkdownLinkTarget(linkTarget);
  if (!targetPath) {
    return null;
  }

  if (targetPath.startsWith('/')) {
    return path.join(rootDir, targetPath.slice(1));
  }

  return path.resolve(path.dirname(filePath), targetPath);
}

export function isGeneratedQualityReport(relativePath) {
  return (
    relativePath === '.agent-guidance/quality/latest-garden-report.md' ||
    relativePath === '.agent-guidance/quality/latest-scorecard.md'
  );
}

export async function getMarkdownFilesInGuidanceRoots(rootDir) {
  // Keep `docs/` in the scan only as a legacy fallback for unmigrated repos.
  const candidateRoots = ['.agent-guidance', 'docs'];
  const markdownFiles = await Promise.all(
    candidateRoots.map((relativeRoot) =>
      walkFiles(path.join(rootDir, relativeRoot), (absolutePath) =>
        absolutePath.endsWith('.md'),
      ),
    ),
  );

  return [...new Set(markdownFiles.flat())].sort();
}

function parseMarkdownSections(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const headings = [];
  let inCodeBlock = false;

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      continue;
    }

    const match = line.match(/^(#{1,6})\s+(.*)$/u);
    if (!match) {
      continue;
    }

    headings.push({
      level: match[1].length,
      title: match[2].trim(),
      lineIndex: index,
      anchor: slugifyMarkdownHeading(match[2]),
    });
  }

  const sections = [];
  for (const [index, heading] of headings.entries()) {
    let endLineIndex = lines.length;
    for (
      let nextIndex = index + 1;
      nextIndex < headings.length;
      nextIndex += 1
    ) {
      if (headings[nextIndex].level <= heading.level) {
        endLineIndex = headings[nextIndex].lineIndex;
        break;
      }
    }

    sections.push({
      ...heading,
      content: lines.slice(heading.lineIndex, endLineIndex).join('\n'),
    });
  }

  return sections;
}

function collectMarkdownAnchors(markdown) {
  const anchors = new Set();
  for (const section of parseMarkdownSections(markdown)) {
    if (section.anchor) {
      anchors.add(section.anchor);
    }
  }

  const lines = markdown.split(/\r?\n/u);
  let inCodeBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      continue;
    }

    for (const match of line.matchAll(
      /<a\s+(?:id|name)=["']([^"']+)["'][^>]*>/giu,
    )) {
      anchors.add(normalizeMarkdownFragment(match[1]));
    }
  }

  anchors.delete(null);
  return anchors;
}

function hasMatchingMarkdownAnchor(markdown, fragment) {
  const normalizedFragment = normalizeMarkdownFragment(fragment);
  if (!normalizedFragment) {
    return false;
  }

  return collectMarkdownAnchors(markdown).has(normalizedFragment);
}

function getMarkdownSectionForFragment(markdown, fragment) {
  const normalizedFragment = normalizeMarkdownFragment(fragment);
  if (!normalizedFragment) {
    return {
      content: markdown,
      section: null,
    };
  }

  const matchingSection = parseMarkdownSections(markdown).find(
    (section) => section.anchor === normalizedFragment,
  );
  if (matchingSection) {
    return {
      content: matchingSection.content,
      section: matchingSection,
    };
  }

  if (collectMarkdownAnchors(markdown).has(normalizedFragment)) {
    return {
      content: markdown,
      section: null,
    };
  }

  return null;
}

function normalizeTableCell(cell) {
  return cell.trim().replace(/^`|`$/gu, '');
}

function splitTableRow(row) {
  const trimmed = row.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    return null;
  }

  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => normalizeTableCell(cell));
}

function isAlignmentRow(cells) {
  return cells.every((cell) => /^:?-{3,}:?$/u.test(cell.replace(/\s+/gu, '')));
}

function normalizeSurfaceValue(value) {
  const trimmed = normalizeTableCell(value);
  if (!trimmed) {
    return '';
  }

  return trimmed.split(/\s+/u)[0];
}

function extractOwningDocTarget(value) {
  const markdownLinkMatch = value.match(/\[[^\]]*\]\(([^)]+)\)/u);
  if (markdownLinkMatch) {
    return markdownLinkMatch[1].trim();
  }

  return normalizeTableCell(value);
}

function parseSurfaceMapRows(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const rows = [];

  for (let index = 0; index < lines.length; index += 1) {
    const headerCells = splitTableRow(lines[index]);
    if (!headerCells || headerCells.length < 4) {
      continue;
    }

    const normalizedHeaders = headerCells.map((cell) => cell.toLowerCase());
    const surfaceIndex = normalizedHeaders.findIndex(
      (cell) => cell === 'surface' || cell === 'sub-surface',
    );
    const coverageIndex = normalizedHeaders.indexOf('coverage');
    const owningDocIndex = normalizedHeaders.indexOf('owning doc');
    const notesIndex = normalizedHeaders.indexOf('notes');
    const kindIndex = normalizedHeaders.indexOf('kind');

    if (surfaceIndex === -1 || coverageIndex === -1 || owningDocIndex === -1) {
      continue;
    }

    const alignmentCells = splitTableRow(lines[index + 1] ?? '');
    if (!alignmentCells || !isAlignmentRow(alignmentCells)) {
      continue;
    }

    let rowIndex = index + 2;
    while (rowIndex < lines.length) {
      const rowCells = splitTableRow(lines[rowIndex]);
      if (!rowCells) {
        break;
      }

      rows.push({
        surface: normalizeSurfaceValue(rowCells[surfaceIndex] ?? ''),
        kind: normalizeTableCell(rowCells[kindIndex] ?? ''),
        coverage: normalizeTableCell(
          rowCells[coverageIndex] ?? '',
        ).toLowerCase(),
        owningDoc: extractOwningDocTarget(rowCells[owningDocIndex] ?? ''),
        notes: normalizeTableCell(rowCells[notesIndex] ?? ''),
      });
      rowIndex += 1;
    }

    index = rowIndex - 1;
  }

  return rows;
}

function findChildInventorySections(markdown) {
  return parseMarkdownSections(markdown)
    .filter(
      (section) =>
        normalizeHeadingLabel(section.title) === 'child surface inventory',
    )
    .map((section) => ({
      ...section,
      rows: parseSurfaceMapRows(section.content),
    }));
}

function selectBestChildInventorySection(
  inventorySections,
  expectedChildSurfaces,
) {
  if (inventorySections.length === 0) {
    return null;
  }

  const expectedChildSurfaceSet =
    expectedChildSurfaces instanceof Set
      ? expectedChildSurfaces
      : new Set(expectedChildSurfaces);
  let bestMatch = null;

  for (const section of inventorySections) {
    const matchingRows = section.rows.filter((row) =>
      expectedChildSurfaceSet.has(row.surface),
    ).length;
    const extraRows = section.rows.filter(
      (row) => !expectedChildSurfaceSet.has(row.surface),
    ).length;

    if (
      !bestMatch ||
      matchingRows > bestMatch.matchingRows ||
      (matchingRows === bestMatch.matchingRows &&
        extraRows < bestMatch.extraRows)
    ) {
      bestMatch = {
        section,
        matchingRows,
        extraRows,
      };
    }
  }

  return bestMatch?.section ?? inventorySections[0];
}

export async function analyzeKnowledgeScriptCompliance(rootDir) {
  const localPresenceEntries = await Promise.all(
    LOCAL_KNOWLEDGE_SCRIPT_PATHS.map(async (relativePath) => [
      relativePath,
      await pathExists(path.join(rootDir, relativePath)),
    ]),
  );
  const localPresenceByPath = new Map(localPresenceEntries);
  const errors = [];
  const checks = [];

  const missingLocalScriptPaths = [...localPresenceByPath.entries()]
    .filter(([, isPresent]) => !isPresent)
    .map(([relativePath]) => relativePath)
    .sort();

  checks.push(missingLocalScriptPaths.length === 0);
  for (const relativePath of missingLocalScriptPaths) {
    errors.push(`missing required local docs skill script: ${relativePath}`);
  }

  const repoPresenceEntries = await Promise.all(
    OPTIONAL_REPO_KNOWLEDGE_SCRIPT_PATHS.map(async (relativePath) => [
      relativePath,
      await pathExists(path.join(rootDir, relativePath)),
    ]),
  );
  const repoPresenceByPath = new Map(repoPresenceEntries);
  const hasRepoScriptWrappers = [...repoPresenceByPath.values()].some(Boolean);

  if (hasRepoScriptWrappers) {
    const missingRepoWrapperPaths = [...repoPresenceByPath.entries()]
      .filter(([, isPresent]) => !isPresent)
      .map(([relativePath]) => relativePath)
      .sort();

    checks.push(missingRepoWrapperPaths.length === 0);
    for (const relativePath of missingRepoWrapperPaths) {
      errors.push(
        `missing required repo-level docs wrapper script: ${relativePath}`,
      );
    }
  }

  return {
    errors,
    checks,
    hasRepoScriptWrappers,
    localPresenceByPath,
    repoPresenceByPath,
  };
}

function normalizeDirectoryEntry(entry) {
  return entry.endsWith('/') ? entry : `${entry}/`;
}

async function listMeaningfulChildDirectories(rootDir, relativeDir) {
  const absoluteDir = path.join(rootDir, relativeDir);
  if (!(await pathExists(absoluteDir))) {
    return [];
  }

  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !shouldIgnoreSubsurfaceDirectory(name))
    .map((name) =>
      normalizeDirectoryEntry(
        path.posix.join(relativeDir, name).split(path.sep).join('/'),
      ),
    )
    .sort();
}

function isExcludedCoverage(row) {
  return row.coverage === 'excluded';
}

function isDocumentedCoverage(row) {
  return row.coverage === 'documented';
}

function docOwnsTooManyDocumentedSurfaces(documentedRows) {
  const counts = new Map();
  for (const row of documentedRows) {
    const owningDoc = row.owningDoc.split('#')[0];
    counts.set(owningDoc, (counts.get(owningDoc) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > MAX_DOCUMENTED_SURFACES_PER_SHARED_DOC)
    .map(([owningDoc, count]) => ({ owningDoc, count }));
}

export async function analyzeSurfaceMapCoverage(
  rootDir,
  surfaceMapRelativePath = SURFACE_MAP_PATH,
) {
  const errors = [];
  const checks = [];
  const surfaceMapFile = path.join(rootDir, surfaceMapRelativePath);

  if (!(await pathExists(surfaceMapFile))) {
    return { errors, checks };
  }

  const docContentCache = new Map();
  const meaningfulSubtreeCache = new Map();
  const visitedComplexSurfaces = new Set();

  async function readDoc(absolutePath) {
    if (docContentCache.has(absolutePath)) {
      return docContentCache.get(absolutePath);
    }

    const content = await fs.readFile(absolutePath, 'utf8');
    docContentCache.set(absolutePath, content);
    return content;
  }

  async function docHasFragment(absolutePath, fragment) {
    const content = await readDoc(absolutePath);
    return hasMatchingMarkdownAnchor(content, fragment);
  }

  async function getMeaningfulChildDirectories(relativeDir) {
    if (meaningfulSubtreeCache.has(relativeDir)) {
      return meaningfulSubtreeCache.get(relativeDir);
    }

    const children = await listMeaningfulChildDirectories(rootDir, relativeDir);
    meaningfulSubtreeCache.set(relativeDir, children);
    return children;
  }

  async function validateComplexSurface(
    surfaceRow,
    owningDocAbsolutePath,
    owningDocLinkTarget,
    scopeFragment = null,
  ) {
    const visitedKey = `${surfaceRow.surface}::${owningDocLinkTarget}`;
    if (visitedComplexSurfaces.has(visitedKey)) {
      return;
    }
    visitedComplexSurfaces.add(visitedKey);

    const childDirs = await getMeaningfulChildDirectories(surfaceRow.surface);
    if (childDirs.length < COMPLEX_SURFACE_CHILD_THRESHOLD) {
      return;
    }

    const docContent = await readDoc(owningDocAbsolutePath);
    const scopedSection = scopeFragment
      ? getMarkdownSectionForFragment(docContent, scopeFragment)
      : { content: docContent };
    if (!scopedSection) {
      errors.push(
        `${surfaceRow.surface}: owning doc ${owningDocLinkTarget} is missing the required fragment anchor.`,
      );
      checks.push(false);
      return;
    }

    const inventorySections = findChildInventorySections(scopedSection.content);
    if (inventorySections.length === 0) {
      errors.push(
        `${surfaceRow.surface}: complex documented surface is missing a ## Child Surface Inventory table in ${owningDocLinkTarget}.`,
      );
      checks.push(false);
      return;
    }

    const childSurfaceSet = new Set(childDirs);
    const bestInventory = selectBestChildInventorySection(
      inventorySections,
      childSurfaceSet,
    );
    const childRows = bestInventory?.rows ?? [];
    const childRowSurfaceSet = new Set(childRows.map((row) => row.surface));

    for (const childDir of childDirs) {
      if (!childRowSurfaceSet.has(childDir)) {
        errors.push(
          `${surfaceRow.surface}: child surface ${childDir} is missing from ${owningDocLinkTarget}.`,
        );
        checks.push(false);
      }
    }

    for (const childRow of childRows) {
      if (!childSurfaceSet.has(childRow.surface)) {
        errors.push(
          `${surfaceRow.surface}: child inventory row ${childRow.surface} is not a direct child surface in ${owningDocLinkTarget}.`,
        );
        checks.push(false);
      }

      if (!childRow.owningDoc) {
        errors.push(
          `${surfaceRow.surface}: child surface ${childRow.surface} is missing an owning doc link in ${owningDocLinkTarget}.`,
        );
        checks.push(false);
        continue;
      }

      const childOwningDocAbsolutePath = resolveLinkTarget(
        owningDocAbsolutePath,
        childRow.owningDoc,
        rootDir,
      );
      if (
        !childOwningDocAbsolutePath ||
        !(await pathExists(childOwningDocAbsolutePath))
      ) {
        errors.push(
          `${surfaceRow.surface}: child surface ${childRow.surface} points to missing owning doc ${childRow.owningDoc}.`,
        );
        checks.push(false);
      }

      const { targetPath, fragment } = splitMarkdownLinkTarget(
        childRow.owningDoc,
      );
      if (!targetPath) {
        errors.push(
          `${surfaceRow.surface}: child surface ${childRow.surface} has an invalid owning doc link ${childRow.owningDoc}.`,
        );
        checks.push(false);
        continue;
      }

      const sameDocTarget =
        path.resolve(path.dirname(owningDocAbsolutePath), targetPath) ===
        owningDocAbsolutePath;
      if (sameDocTarget && !fragment) {
        errors.push(
          `${surfaceRow.surface}: child surface ${childRow.surface} points back to ${owningDocLinkTarget} without a #fragment anchor.`,
        );
        checks.push(false);
      }

      if (
        sameDocTarget &&
        fragment &&
        !(await docHasFragment(owningDocAbsolutePath, fragment))
      ) {
        errors.push(
          `${surfaceRow.surface}: child surface ${childRow.surface} points to missing fragment ${childRow.owningDoc}.`,
        );
        checks.push(false);
      }
    }

    const documentedChildRows = childRows.filter(isDocumentedCoverage);
    const overlyBroadChildDocs =
      docOwnsTooManyDocumentedSurfaces(documentedChildRows);
    for (const broadDoc of overlyBroadChildDocs) {
      errors.push(
        `${surfaceRow.surface}: child doc ${broadDoc.owningDoc} owns ${broadDoc.count} documented child surfaces; split it further or tighten the grouping.`,
      );
      checks.push(false);
    }

    for (const childRow of documentedChildRows) {
      if (!childSurfaceSet.has(childRow.surface) || !childRow.owningDoc) {
        continue;
      }

      const childOwningDocAbsolutePath = resolveLinkTarget(
        owningDocAbsolutePath,
        childRow.owningDoc,
        rootDir,
      );
      if (
        !childOwningDocAbsolutePath ||
        !(await pathExists(childOwningDocAbsolutePath))
      ) {
        continue;
      }

      const { fragment } = splitMarkdownLinkTarget(childRow.owningDoc);
      await validateComplexSurface(
        childRow,
        childOwningDocAbsolutePath,
        childRow.owningDoc,
        fragment,
      );
    }
  }

  const surfaceMapContent = await fs.readFile(surfaceMapFile, 'utf8');
  const rows = parseSurfaceMapRows(surfaceMapContent);

  if (rows.length === 0) {
    errors.push(
      `${surfaceMapRelativePath}: missing or unreadable surface map rows.`,
    );
    checks.push(false);
    return { errors, checks };
  }

  const documentedRows = rows.filter(isDocumentedCoverage);
  const excludedRows = rows.filter(isExcludedCoverage);
  checks.push(documentedRows.length > 0);
  if (documentedRows.length === 0) {
    errors.push(`${surfaceMapRelativePath}: no documented rows found.`);
  }

  for (const row of rows) {
    if (!row.surface) {
      errors.push(
        `${surfaceMapRelativePath}: found a row without a surface value.`,
      );
      checks.push(false);
      continue;
    }

    if (!row.coverage || !['documented', 'excluded'].includes(row.coverage)) {
      errors.push(
        `${surfaceMapRelativePath}: ${row.surface} must set Coverage to documented or excluded.`,
      );
      checks.push(false);
    }

    if (!row.notes) {
      errors.push(
        `${surfaceMapRelativePath}: ${row.surface} is missing notes describing ownership or exclusion.`,
      );
      checks.push(false);
    }

    if (isDocumentedCoverage(row)) {
      if (!row.owningDoc) {
        errors.push(
          `${surfaceMapRelativePath}: ${row.surface} is documented but missing an owning doc.`,
        );
        checks.push(false);
        continue;
      }

      const owningDocAbsolutePath = resolveLinkTarget(
        surfaceMapFile,
        row.owningDoc,
        rootDir,
      );
      if (
        !owningDocAbsolutePath ||
        !(await pathExists(owningDocAbsolutePath))
      ) {
        errors.push(
          `${surfaceMapRelativePath}: ${row.surface} points to missing owning doc ${row.owningDoc}.`,
        );
        checks.push(false);
        continue;
      }

      const owningDocRelativePath = toRepoRelative(
        rootDir,
        owningDocAbsolutePath,
      );
      if (owningDocRelativePath.endsWith('/README.md')) {
        errors.push(
          `${surfaceMapRelativePath}: ${row.surface} points only to section index ${row.owningDoc}; add a concrete owning doc.`,
        );
        checks.push(false);
      }

      const { fragment } = splitMarkdownLinkTarget(row.owningDoc);
      if (
        fragment &&
        !(await docHasFragment(owningDocAbsolutePath, fragment))
      ) {
        errors.push(
          `${surfaceMapRelativePath}: ${row.surface} points to missing fragment ${row.owningDoc}.`,
        );
        checks.push(false);
      }

      await validateComplexSurface(
        row,
        owningDocAbsolutePath,
        row.owningDoc,
        fragment,
      );
    }

    if (isExcludedCoverage(row) && !row.notes) {
      errors.push(
        `${surfaceMapRelativePath}: ${row.surface} is excluded but missing an explanation.`,
      );
      checks.push(false);
    }
  }

  const broadDocs = docOwnsTooManyDocumentedSurfaces(documentedRows);
  for (const broadDoc of broadDocs) {
    errors.push(
      `${surfaceMapRelativePath}: shared doc ${broadDoc.owningDoc} owns ${broadDoc.count} documented major surfaces; split it further.`,
    );
    checks.push(false);
  }

  checks.push(excludedRows.every((row) => row.notes.length > 0));

  return {
    errors,
    checks,
  };
}
