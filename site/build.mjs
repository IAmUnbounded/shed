// Builds the deployable site: site/index.html is written as a page fragment (for the Artifact preview, which adds
// the document wrapper itself), so this wraps it in a full HTML document and copies the assets into dist/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'dist');
const page = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
// Vercel provides the production domain at build time; fall back to a relative URL locally.
const site = process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');

const headEnd = page.indexOf('</style>') + '</style>'.length;
const head = page.slice(0, headEnd), body = page.slice(headEnd);
const description = 'Shed connects your phone to the Claude Code, Codex, Gemini, OpenCode and Pi sessions on your Mac. Send a message from anywhere; it runs in a real Terminal window you can watch and approve. Powered by Laya.';

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${description}">
<meta name="theme-color" content="#131b17">
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:title" content="Shed: your coding agents, in your pocket">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${site}/tour-poster.jpg">
<meta property="og:video" content="${site}/shed-tour.mp4">
<meta name="twitter:card" content="summary_large_image">
${head}
</head>
<body>
${body}
</body>
</html>
`;

fs.rmSync(out, { recursive:true, force:true });
fs.mkdirSync(out, { recursive:true });
fs.writeFileSync(path.join(out, 'index.html'), html);
for (const file of ['shed-tour.mp4', 'tour-poster.jpg', 'logo.svg']) fs.copyFileSync(path.join(here, file), path.join(out, file));
console.log(`Built ${out} for ${site || 'local preview'}`);
