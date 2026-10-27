import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// Sharing from the phone: an iOS Shortcut in the share sheet posts a link (an Instagram post, a TikTok, a page…) with a
// note. Shed fetches the post's media and caption itself, then starts a session with them attached.

// Sites whose posts Shed downloads. Anything else is passed to the agent as a link only, so a shared URL can never make
// the Mac fetch something on its own network.
const MEDIA_HOSTS = /(^|\.)(instagram\.com|tiktok\.com|youtube\.com|youtu\.be|x\.com|twitter\.com|threads\.net|threads\.com|facebook\.com|fb\.watch|reddit\.com|vimeo\.com|pinterest\.com|pin\.it|linkedin\.com)$/i;
const MAX_BYTES = 100 * 1024 * 1024;
const MEDIA_EXT = /\.(mp4|mov|webm|m4v|mkv|jpg|jpeg|png|webp|gif|heic|mp3|m4a)$/i;

export function extractUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return '';
  try { const url = new URL(match[0].replace(/[),.;!?]+$/, '')); return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''; } catch { return ''; }
}
export const siteName = url => { try { const host = new URL(url).hostname.replace(/^www\./, ''); return { 'instagram.com':'Instagram', 'tiktok.com':'TikTok', 'youtube.com':'YouTube', 'youtu.be':'YouTube', 'x.com':'X', 'twitter.com':'X', 'threads.net':'Threads', 'threads.com':'Threads', 'reddit.com':'Reddit' }[host.split('.').slice(-2).join('.')] || host; } catch { return 'web'; } };
export const fetchesMedia = url => { try { return MEDIA_HOSTS.test(new URL(url).hostname); } catch { return false; } };

function run(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    let stderr = '', done = false;
    const child = spawn(cmd, args, { stdio:['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(-1, 'Timed out.'); }, timeoutMs);
    const finish = (code, extra = '') => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stderr:(stderr + extra).slice(-2000) }); };
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 20000) stderr = stderr.slice(-4000); });
    child.on('error', error => finish(-1, error.message));
    child.on('close', code => finish(code));
  });
}

// yt-dlp handles videos and most carousels; `cookiesBrowser` lets it use the person's own login for posts behind one.
async function viaYtDlp(url, dir, cookiesBrowser) {
  const args = ['--no-progress', '--no-warnings', '--playlist-items', '1-10', '--max-filesize', '100M', '--socket-timeout', '20',
    '--write-info-json', '--no-write-playlist-metafiles', '-P', dir, '-o', '%(id)s-%(autonumber)s.%(ext)s',
    ...(cookiesBrowser ? ['--cookies-from-browser', cookiesBrowser] : []), '--', url];
  const result = await run('yt-dlp', args, 150000);
  let caption = '', author = '', date = '';
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.info.json'))) {
    try { const info = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); caption ||= info.description || info.title || ''; author ||= info.uploader || info.channel || ''; date ||= info.upload_date || ''; } catch {}
    fs.rmSync(path.join(dir, name), { force:true });
  }
  return { caption, author, date:date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'), error:result.code === 0 ? '' : (result.stderr.match(/ERROR: (.*)/)?.[1] || result.stderr.trim().split('\n').pop() || 'yt-dlp failed.') };
}

const decode = s => s.replace(/&quot;/g, '"').replace(/&#039;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

// What the site shows link previews: the post's image or video and its caption.
async function viaPreview(url, dir) {
  const response = await fetch(url, { headers:{ 'User-Agent':'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' }, signal:AbortSignal.timeout(20000), redirect:'follow' });
  const html = (await response.text()).slice(0, 2_000_000);
  const meta = name => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)="${name}"[^>]+content="([^"]*)"`, 'i')); return m ? decode(m[1]) : ''; };
  const caption = meta('og:description') || meta('description') || meta('og:title');
  const media = meta('og:video') || meta('og:video:secure_url') || meta('og:image');
  if (media && /^https:\/\//.test(media)) {
    const file = response.ok ? await fetch(media, { signal:AbortSignal.timeout(60000) }) : null;
    if (file?.ok && Number(file.headers.get('content-length') || 0) <= MAX_BYTES) {
      const type = file.headers.get('content-type') || '';
      const ext = type.includes('mp4') ? '.mp4' : type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : type.includes('video') ? '.mp4' : '.jpg';
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.length && bytes.length <= MAX_BYTES) fs.writeFileSync(path.join(dir, `post${ext}`), bytes, { mode:0o600 });
    }
  }
  return { caption };
}

// Downloads what it can into a temporary folder. Returns the files found and the post's caption; never throws.
export async function fetchShared(url, { cookiesBrowser = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-share-'));
  const result = { dir, files:[], caption:'', author:'', date:'', note:'' };
  if (!fetchesMedia(url)) return result;
  try {
    Object.assign(result, await viaYtDlp(url, dir, cookiesBrowser));
  } catch (error) { result.error = error.message; }
  const media = () => fs.readdirSync(dir).filter(n => MEDIA_EXT.test(n)).map(n => path.join(dir, n));
  if (!media().length) {
    try { const preview = await viaPreview(url, dir); result.caption ||= preview.caption; } catch {}
  }
  result.files = media();
  if (!result.files.length) result.note = `Shed could not download this post${result.error ? ` (${result.error.slice(0, 200)})` : ''}. yt-dlp is installed on this Mac if you want to try yourself${cookiesBrowser ? '' : '; the post may need a login'}.`;
  return result;
}

export function sharePrompt({ url, text, note, fetched }) {
  const site = siteName(url);
  const ask = String(note || '').trim() || `Take a look at this ${site} post and tell me what's in it.`;
  const extra = url && String(text || '').replace(url, '').trim();
  return [
    ask,
    '',
    url ? `Shared from my phone (${site}): ${url}` : `Shared from my phone:\n${String(text || '').trim()}`,
    extra && extra.length < 2000 ? `Shared text: ${extra}` : '',
    fetched?.author ? `Posted by: ${fetched.author}${fetched.date ? ` on ${fetched.date}` : ''}` : '',
    fetched?.caption ? `Post caption:\n"""\n${fetched.caption.slice(0, 4000)}\n"""` : '',
    fetched?.note || '',
  ].filter(Boolean).join('\n');
}

// --- The Shortcut ---------------------------------------------------------------------------------------------------
// Shortcuts files are property lists. Shed writes one with the address and key built in, then `shortcuts sign` makes
// it installable on an iPhone.

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plistValue(value) {
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join('')}</array>`;
  if (value === true || value === false) return `<${value}/>`;
  if (typeof value === 'number') return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`;
  if (value && typeof value === 'object') return `<dict>${Object.entries(value).map(([k, v]) => `<key>${xml(k)}</key>${plistValue(v)}`).join('')}</dict>`;
  return `<string>${xml(value)}</string>`;
}
const text = string => ({ Value:{ string, attachmentsByRange:{} }, WFSerializationType:'WFTextTokenString' });
const variable = attachment => ({ Value:{ string:'￼', attachmentsByRange:{ '{0, 1}':attachment } }, WFSerializationType:'WFTextTokenString' });
const dictionary = pairs => ({ Value:{ WFDictionaryFieldValueItems:pairs.map(([key, value]) => ({ WFItemType:0, WFKey:text(key), WFValue:typeof value === 'string' ? text(value) : value })) }, WFSerializationType:'WFDictionaryFieldValue' });

export function shortcutPlist(baseUrl, key) {
  const ask = crypto.randomUUID().toUpperCase(), post = crypto.randomUUID().toUpperCase();
  const workflow = {
    WFWorkflowClientVersion:'2302.0.4', WFWorkflowMinimumClientVersion:900, WFWorkflowMinimumClientVersionString:'900',
    WFWorkflowIcon:{ WFWorkflowIconStartColor:4282601983, WFWorkflowIconGlyphNumber:59511 },
    WFWorkflowImportQuestions:[], WFWorkflowTypes:['ActionExtension'], WFQuickActionSurfaces:[],
    WFWorkflowInputContentItemClasses:['WFURLContentItem', 'WFStringContentItem', 'WFSafariWebPageContentItem'],
    WFWorkflowHasShortcutInputVariables:true, WFWorkflowOutputContentItemClasses:[], WFWorkflowHasOutputFallback:false,
    WFWorkflowActions:[
      { WFWorkflowActionIdentifier:'is.workflow.actions.ask', WFWorkflowActionParameters:{ UUID:ask, WFAskActionPrompt:'What should Shed do with it?', WFInputType:'Text', WFAskActionDefaultAnswer:'' } },
      { WFWorkflowActionIdentifier:'is.workflow.actions.downloadurl', WFWorkflowActionParameters:{
        UUID:post, WFURL:`${baseUrl}/api/share`, WFHTTPMethod:'POST', WFHTTPBodyType:'JSON', ShowHeaders:true,
        WFHTTPHeaders:dictionary([['Authorization', `Bearer ${key}`]]),
        WFJSONValues:dictionary([['shared', variable({ Type:'ExtensionInput' })], ['note', variable({ Type:'ActionOutput', OutputUUID:ask, OutputName:'Provided Input' })]]),
      } },
      { WFWorkflowActionIdentifier:'is.workflow.actions.notification', WFWorkflowActionParameters:{
        WFNotificationActionTitle:'Shed', WFNotificationActionSound:false,
        WFNotificationActionBody:variable({ Type:'ActionOutput', OutputUUID:post, OutputName:'Contents of URL' }),
      } },
    ],
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${plistValue(workflow)}</plist>\n`;
}

// Writes and signs the Shortcut; resolves to the signed file's bytes.
export async function signedShortcut(baseUrl, key) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-shortcut-'));
  try {
    const input = path.join(dir, 'unsigned.shortcut'), output = path.join(dir, 'Send to Shed.shortcut');
    fs.writeFileSync(input, shortcutPlist(baseUrl, key), { mode:0o600 });
    const result = await run('/usr/bin/shortcuts', ['sign', '--mode', 'anyone', '--input', input, '--output', output], 60000);
    if (result.code !== 0 || !fs.existsSync(output)) throw new Error(`Could not sign the Shortcut: ${result.stderr.trim().split('\n').pop() || 'shortcuts sign failed'}`);
    return fs.readFileSync(output);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
}
