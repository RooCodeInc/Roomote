import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const cookbookDirectory = join(scriptDirectory, '..', 'cookbook');
const indexPath = join(cookbookDirectory, 'index.mdx');
const tableStart = '{/* cookbook-recipes:start */}';
const tableEnd = '{/* cookbook-recipes:end */}';

const requiredFields = ['title', 'description', 'contributor'];

function parseFrontmatter(source, fileName) {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);

  if (!match) {
    throw new Error(`Missing frontmatter in ${fileName}`);
  }

  const metadata = parse(match[1]);

  for (const field of requiredFields) {
    if (typeof metadata[field] !== 'string' || metadata[field].trim() === '') {
      throw new Error(`Missing ${field} in ${fileName}`);
    }
  }

  return metadata;
}

function escapeTableCell(value) {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ').trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderLinkedValue(value, url) {
  const text = escapeTableCell(value);
  return url ? `[${text}](${url})` : text;
}

async function readRecipe(fileName) {
  const source = await readFile(join(cookbookDirectory, fileName), 'utf8');
  const metadata = parseFrontmatter(source, fileName);
  const slug = `/cookbook/${basename(fileName, '.mdx')}`;

  return {
    title: metadata.title,
    description: metadata.description,
    contributor: metadata.contributor,
    contributorUrl: metadata.contributor_url,
    contributorCompany: metadata.contributor_company,
    contributorCompanyUrl: metadata.contributor_company_url,
    slug,
  };
}

function renderTable(recipes) {
  const rows = recipes
    .sort((left, right) => left.title.localeCompare(right.title))
    .map((recipe) => {
      const contributor = renderLinkedValue(
        recipe.contributor,
        recipe.contributorUrl,
      );
      const company = recipe.contributorCompany
        ? ` (${renderLinkedValue(recipe.contributorCompany, recipe.contributorCompanyUrl)})`
        : '';

      return `| [${escapeTableCell(recipe.title)}](${recipe.slug}) | ${escapeTableCell(recipe.description)} | ${contributor}${company} |`;
    });

  return ['| Recipe | Description | By |', '| --- | --- | --- |', ...rows].join(
    '\n',
  );
}

const recipeFiles = (await readdir(cookbookDirectory))
  .filter((fileName) => fileName.endsWith('.mdx'))
  .filter((fileName) => !['index.mdx', 'template.mdx'].includes(fileName))
  .sort();
const recipes = await Promise.all(recipeFiles.map(readRecipe));
const indexSource = await readFile(indexPath, 'utf8');
const tablePattern = new RegExp(
  `${escapeRegExp(tableStart)}[\\s\\S]*?${escapeRegExp(tableEnd)}`,
);

if (!tablePattern.test(indexSource)) {
  throw new Error('Cookbook index is missing the generated table markers');
}

const generatedTable = `${tableStart}\n${renderTable(recipes)}\n${tableEnd}`;
const nextIndexSource = indexSource.replace(tablePattern, generatedTable);
const checkOnly = process.argv.includes('--check');

if (nextIndexSource !== indexSource) {
  if (checkOnly) {
    console.error(
      'Cookbook index is out of date; run generate-cookbook-index.',
    );
    process.exitCode = 1;
  } else {
    await writeFile(indexPath, nextIndexSource);
    console.log(`Updated cookbook index with ${recipes.length} recipes`);
  }
} else {
  console.log(`Cookbook index is up to date with ${recipes.length} recipes`);
}
