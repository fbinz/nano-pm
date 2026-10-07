// Deployment regression: run the real WhiteNoise manifest post-processing.
const { test, expect } = require('@playwright/test');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

test('vendored Datastar assets collect with their source map', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nano-static-'));
  try {
    await promisify(execFile)('uv', ['run', 'python', 'src/manage.py', 'collectstatic', '--noinput'], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        DJANGO_DEBUG: 'false',
        DJANGO_SECRET_KEY: 'collectstatic-test-only',
        DJANGO_STATIC_ROOT: root,
      },
    });
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'staticfiles.json'), 'utf8'));
    const bundle = manifest.paths['vendor/datastar-rocket-1.0.4.js'];
    const map = manifest.paths['vendor/datastar-rocket-1.0.4.js.map'];
    expect(bundle).toBeTruthy();
    expect(map).toBeTruthy();
    const source = await fs.readFile(path.join(root, bundle), 'utf8');
    expect(source).toContain(`sourceMappingURL=${path.basename(map)}`);
    const sourceMap = JSON.parse(await fs.readFile(path.join(root, map), 'utf8'));
    expect(sourceMap.version).toBe(3);
    expect(sourceMap.sourcesContent.length).toBe(sourceMap.sources.length);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
