'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const APP_ID = 'ratio-crop-studio';
const APP_VERSION = '2.0.0';
const HOST = '127.0.0.1';
const ROOT = __dirname;
const START_PORT = Number(process.env.CROP_PORT) || 43169;
const MAX_BODY_BYTES = 200 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const NO_OPEN = process.env.CROP_NO_OPEN === '1';
const TEST_FOLDER = process.env.CROP_TEST_FOLDER || '';
const CONFIG_PATH = process.env.CROP_CONFIG || path.join(os.homedir(), '.ratio-crop-studio.json');

let activePort = START_PORT;

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function writeConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn(`[config] 无法保存配置：${error.message}`);
  }
}

let config = readConfig();

function defaultSaveDirectory() {
  const pictures = path.join(os.homedir(), 'Pictures');
  if (fs.existsSync(pictures)) return path.join(pictures, '裁切工坊');
  return path.join(os.homedir(), 'Desktop', '裁切工坊');
}

function currentSaveDirectory() {
  return config.lastSaveDir || defaultSaveDirectory();
}

function expandDirectory(input) {
  let value = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!value) return '';
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(2));
  value = value.replace(/%([^%]+)%/g, (match, name) => process.env[name] || match);
  return value;
}

function sanitizeFileName(rawName) {
  let name = String(rawName || '').trim();
  name = name.replace(/^.*[\\/]/, '');
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
  name = name.replace(/[. ]+$/g, '');
  if (!name) throw new HttpError(400, '文件名不能为空。');

  const extension = path.extname(name).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extension)) {
    throw new HttpError(400, '只支持保存为 JPG、PNG 或 WebP。');
  }

  let base = path.basename(name, path.extname(name)).replace(/[. ]+$/g, '');
  if (!base) base = '裁切图片';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = `_${base}`;
  if (base.length > 110) base = base.slice(0, 110).trim();
  return `${base}${extension}`;
}

function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function mimeForExtension(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  return {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp'
  }[extension] || '';
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;

    const fail = (error) => {
      if (finished) return;
      finished = true;
      reject(error);
    };

    request.on('data', (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, '上传的图片太大，超过本地服务限制。'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks));
    });
    request.on('error', fail);
    request.on('aborted', () => fail(new HttpError(400, '请求已中断。')));
  });
}

function sendJson(response, statusCode, data) {
  const payload = Buffer.from(JSON.stringify(data), 'utf8');
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(payload);
}

function isAllowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const localHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    return localHost && Number(parsed.port || 80) === activePort;
  } catch (error) {
    return false;
  }
}

async function uniqueFilePath(directory, fileName) {
  const parsed = path.parse(fileName);
  let candidate = path.join(directory, fileName);
  for (let index = 2; index < 1000; index += 1) {
    try {
      await fsp.access(candidate);
      candidate = path.join(directory, `${parsed.name} (${index})${parsed.ext}`);
    } catch (error) {
      if (error.code === 'ENOENT') return candidate;
      throw error;
    }
  }
  return path.join(directory, `${parsed.name} (${Date.now()})${parsed.ext}`);
}

async function handleSave(request, response, url) {
  const directoryInput = url.searchParams.get('dir') || '';
  const requestedName = sanitizeFileName(url.searchParams.get('filename') || '');

  const directory = expandDirectory(directoryInput || currentSaveDirectory());
  if (!directory) throw new HttpError(400, '请填写保存文件夹。');
  if (!path.isAbsolute(directory)) {
    throw new HttpError(400, '请填写绝对路径，例如 C:\\Users\\你的名字\\Pictures\\裁切。');
  }

  let directoryCreated = false;
  try {
    const stat = await fsp.stat(directory);
    if (!stat.isDirectory()) throw new HttpError(400, '填写的保存位置不是文件夹。');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error.code !== 'ENOENT') throw new HttpError(500, `无法访问保存文件夹：${error.message}`);
    await fsp.mkdir(directory, { recursive: true });
    directoryCreated = true;
  }

  const body = await readBody(request, MAX_BODY_BYTES);
  if (!body.length) throw new HttpError(400, '没有收到图片数据。');

  const detectedMime = detectImageMime(body);
  if (!detectedMime) throw new HttpError(415, '图片数据格式无法识别。');
  if (detectedMime !== mimeForExtension(requestedName)) {
    throw new HttpError(415, '图片内容与文件扩展名不一致。');
  }

  const target = await uniqueFilePath(directory, requestedName);
  const targetName = path.basename(target);
  const tempPath = path.join(directory, `.${targetName}.${process.pid}.${Date.now()}.tmp`);

  try {
    await fsp.writeFile(tempPath, body, { flag: 'wx' });
    await fsp.rename(tempPath, target);
  } catch (error) {
    try { await fsp.unlink(tempPath); } catch (cleanupError) { /* noop */ }
    throw new HttpError(500, `写入文件失败：${error.message}`);
  }

  config.lastSaveDir = directory;
  writeConfig(config);

  console.log(`[save] ${target} (${(body.length / 1024 / 1024).toFixed(1)} MB)`);
  sendJson(response, 200, {
    ok: true,
    app: APP_ID,
    path: target,
    dir: directory,
    filename: targetName,
    bytes: body.length,
    renamed: targetName !== requestedName,
    directoryCreated
  });
}

async function readJsonBody(request) {
  const body = await readBody(request, MAX_JSON_BYTES);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    throw new HttpError(400, '请求内容不是有效的 JSON。');
  }
}

function browseFolder(initialDirectory) {
  if (TEST_FOLDER) return Promise.resolve({ path: TEST_FOLDER, canceled: false });
  if (process.platform !== 'win32') {
    return Promise.reject(new HttpError(501, '当前系统暂不支持系统文件夹选择窗口。'));
  }

  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择图片保存文件夹'
$dialog.ShowNewFolderButton = $true
$initial = $env:CROP_INITIAL_DIR
if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) {
  $dialog.SelectedPath = $initial
}
$owner = New-Object System.Windows.Forms.Form
$owner.Text = '选择保存文件夹'
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Size = New-Object System.Drawing.Size -ArgumentList 1,1
$owner.Show()
try {
  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.SelectedPath)
  }
} finally {
  $owner.Close()
  $dialog.Dispose()
  $owner.Dispose()
}
`;

  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded
    ], {
      windowsHide: true,
      env: { ...process.env, CROP_INITIAL_DIR: expandDirectory(initialDirectory) }
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new HttpError(500, `无法启动文件夹选择窗口：${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new HttpError(500, stderr.trim() || '文件夹选择窗口已关闭。'));
        return;
      }
      const selected = stdout.trim();
      resolve(selected ? { path: selected, canceled: false } : { canceled: true });
    });
  });
}

async function handleBrowse(request, response) {
  let payload = {};
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    payload = {};
  }
  const result = await browseFolder(payload.initialDir || currentSaveDirectory());
  sendJson(response, 200, { ok: true, ...result });
}

async function handleOpenFolder(request, response) {
  const payload = await readJsonBody(request);
  const target = expandDirectory(payload.path || '');
  if (!target || !path.isAbsolute(target)) throw new HttpError(400, '文件路径无效。');

  let directory = target;
  try {
    const stat = await fsp.stat(target);
    if (stat.isFile()) directory = path.dirname(target);
  } catch (error) {
    directory = path.dirname(target);
  }

  if (process.platform === 'win32') {
    const child = spawn('explorer.exe', [directory], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
  } else if (process.platform === 'darwin') {
    const child = spawn('open', [directory], { detached: true, stdio: 'ignore' });
    child.unref();
  } else {
    const child = spawn('xdg-open', [directory], { detached: true, stdio: 'ignore' });
    child.unref();
  }

  sendJson(response, 200, { ok: true, path: directory });
}

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/preview.png': ['preview.png', 'image/png'],
  '/README.md': ['README.md', 'text/markdown; charset=utf-8']
};

async function serveStatic(response, fileName, contentType) {
  const filePath = path.join(ROOT, fileName);
  try {
    const data = await fsp.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(data);
  } catch (error) {
    throw new HttpError(404, '文件不存在。');
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url || '/', `http://${HOST}:${activePort}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/') && !isAllowedOrigin(request)) {
    sendJson(response, 403, { ok: false, error: '拒绝了非本机页面的请求。' });
    return;
  }

  if (request.method === 'GET' && pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === 'GET' && STATIC_FILES[pathname]) {
    const [fileName, contentType] = STATIC_FILES[pathname];
    await serveStatic(response, fileName, contentType);
    return;
  }

  if (request.method === 'GET' && pathname === '/api/info') {
    sendJson(response, 200, {
      ok: true,
      app: APP_ID,
      version: APP_VERSION,
      defaultDir: currentSaveDirectory(),
      lastSaveDir: config.lastSaveDir || '',
      platform: process.platform,
      node: process.version
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/save') {
    await handleSave(request, response, url);
    return;
  }

  if (request.method === 'POST' && pathname === '/api/browse-folder') {
    await handleBrowse(request, response);
    return;
  }

  if (request.method === 'POST' && pathname === '/api/open-folder') {
    await handleOpenFolder(request, response);
    return;
  }

  if (request.method === 'GET' && pathname === '/api/health') {
    sendJson(response, 200, { ok: true, app: APP_ID, version: APP_VERSION });
    return;
  }

  throw new HttpError(404, '页面或接口不存在。');
}

function createHttpServer() {
  return http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      if (statusCode >= 500) console.error(`[error] ${error.stack || error.message}`);
      if (!response.headersSent) {
        sendJson(response, statusCode, {
          ok: false,
          error: error.message || '本地服务发生错误。'
        });
      } else {
        response.end();
      }
    });
  });
}

let server = null;

function openBrowser(url) {
  if (NO_OPEN) return;
  const commands = {
    win32: ['cmd.exe', ['/c', 'start', '', url]],
    darwin: ['open', [url]],
    linux: ['xdg-open', [url]]
  };
  const command = commands[process.platform];
  if (!command) return;
  try {
    const child = spawn(command[0], command[1], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  } catch (error) {
    console.warn(`[browser] 无法自动打开浏览器，请手动访问 ${url}`);
  }
}

function listen(port) {
  if (server) {
    try { server.close(); } catch (error) { /* already closed */ }
  }

  const attempt = createHttpServer();
  server = attempt;
  activePort = port;

  const onError = (error) => {
    attempt.removeListener('error', onError);
    if (error.code === 'EADDRINUSE' && port - START_PORT < 12) {
      listen(port + 1);
      return;
    }
    console.error(`\n启动失败：${error.message}\n`);
    process.exitCode = 1;
  };

  attempt.once('error', onError);
  attempt.listen(port, HOST, () => {
    attempt.removeListener('error', onError);
    attempt.on('error', (error) => {
      console.error(`[server] ${error.message}`);
    });
    activePort = port;
    const url = `http://${HOST}:${port}`;
    console.log('');
    console.log('  比例裁切工坊 · 本地保存服务');
    console.log('  ---------------------------------');
    console.log(`  地址：${url}`);
    console.log(`  默认保存文件夹：${currentSaveDirectory()}`);
    console.log('  关闭此窗口即可停止服务。');
    console.log('');
    openBrowser(url);
  });
}

process.on('SIGINT', () => {
  console.log('\n正在停止本地服务…');
  if (!server) process.exit(0);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800);
});

listen(START_PORT);
