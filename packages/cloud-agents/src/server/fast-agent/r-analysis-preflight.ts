const PACKAGE_CALL =
  /\b(?:library|require)\s*\(\s*(?:package\s*=\s*)?(?:["']([A-Za-z][A-Za-z0-9.]*)["']|([A-Za-z][A-Za-z0-9.]*))\s*\)/gu;
const NAMESPACE_CALL =
  /\b([A-Za-z][A-Za-z0-9.]*)\s*:::{0,1}\s*[A-Za-z.][A-Za-z0-9._]*/gu;
const DYNAMIC_PACKAGE_CALL =
  /\b(?:library|require)\s*\(\s*(?:package\s*=\s*)?([^,)'"\s][^,)]*)\s*,[^)]*\bcharacter\.only\s*=\s*TRUE[^)]*\)/gu;

const BASE_PACKAGES = new Set([
  'base',
  'compiler',
  'datasets',
  'graphics',
  'grDevices',
  'grid',
  'methods',
  'parallel',
  'splines',
  'stats',
  'stats4',
  'tcltk',
  'tools',
  'utils',
]);

type RAnalysisPreflight = {
  packages: string[];
  unresolvedPackageExpressions: string[];
};

function stripComments(source: string): string {
  return source
    .split(/\r?\n/u)
    .map((line) => line.replace(/(^|\s)#.*$/u, '$1'))
    .join('\n');
}

export function inspectRAnalysisScript(source: string): RAnalysisPreflight {
  const code = stripComments(source);
  const packages = new Map<string, string>();
  const unresolved = new Set<string>();

  for (const match of code.matchAll(PACKAGE_CALL)) {
    const name = match[1] ?? match[2];
    if (name && !BASE_PACKAGES.has(name))
      packages.set(name.toLowerCase(), name);
  }
  for (const match of code.matchAll(NAMESPACE_CALL)) {
    const name = match[1];
    if (name && !BASE_PACKAGES.has(name))
      packages.set(name.toLowerCase(), name);
  }
  for (const match of code.matchAll(DYNAMIC_PACKAGE_CALL)) {
    const expression = match[1]?.trim();
    if (expression) unresolved.add(expression);
  }

  return {
    packages: [...packages.values()].sort((a, b) => a.localeCompare(b)),
    unresolvedPackageExpressions: [...unresolved].sort(),
  };
}
