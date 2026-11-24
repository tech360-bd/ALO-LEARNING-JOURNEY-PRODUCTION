// Source declarations only. A listed route is not proof of runtime readiness.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
const root = 'src/app', pages = [], routes = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { await walk(p); continue; }
    const url = '/' + path.relative(root, dir).split(path.sep).join('/');
    if (e.name === 'page.tsx') pages.push(url);
    if (e.name !== 'route.ts') continue;
    const file = ts.createSourceFile(p, await readFile(p,'utf8'), ts.ScriptTarget.Latest);
    const names = new Set();
    for (const s of file.statements) {
      if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause)) {
        for (const e of s.exportClause.elements) names.add(e.name.text);
      } else if (s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)) {
        if (s.name) names.add(s.name.getText(file));
        if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) names.add(d.name.getText(file));
      }
    }
    routes.push([url, ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].filter(n=>names.has(n)).join(', ') || 'No explicit handler']);
  }
}
await walk(root);
const text = `# Application route inventory\n\nGenerated from the root App Router with \`node scripts/route-inventory.mjs\`. These are declarations, not live endpoint checks. Implicit framework methods are not counted.\n\n## Pages (${pages.length})\n\n${pages.sort().map(p=>'- `'+p+'`').join('\n')}\n\n## API routes (${routes.length})\n\n| Path | Explicit HTTP exports |\n| --- | --- |\n${routes.sort(([a],[b])=>a<b?-1:1).map(([p,m])=>'| `'+p+'` | '+m+' |').join('\n')}\n`;
await writeFile('docs/ROUTE-INVENTORY.md', text);
