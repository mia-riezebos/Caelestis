import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'

const image = process.argv[2]
if (!image) throw new Error('Usage: node scripts/test-portable-image.mjs IMAGE')
const prefix = `caelestis-smoke-${process.pid}-${Date.now()}`
const containers = []
const volumes = []
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
const run = (name, args) => {
  containers.push(name)
  return docker('run', '--name', name, '--network', prefix, ...args)
}
const inside = (name, source) => {
  const result = spawnSync(
    'docker',
    ['exec', '-i', '-w', '/app/apps/backend', name, 'node', '--input-type=module'],
    { input: source, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}
const ready = async (name) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = spawnSync('docker', [
      'exec',
      name,
      'node',
      '-e',
      "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    ])
    if (result.status === 0) return
    if (docker('inspect', '--format', '{{.State.Running}}', name) === 'false') break
    await setTimeout(1000)
  }
  throw new Error(`Server did not become ready:\n${docker('logs', name)}`)
}

docker('network', 'create', prefix)
try {
  run(`${prefix}-pg`, [
    '-d',
    '-e',
    'POSTGRES_PASSWORD=smoke',
    '-e',
    'POSTGRES_DB=caelestis',
    'postgres:17@sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675',
  ])
  run(`${prefix}-s3`, [
    '-d',
    '-e',
    'MINIO_ROOT_USER=caelestis-smoke',
    '-e',
    'MINIO_ROOT_PASSWORD=caelestis-smoke-password',
    'minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e',
    'server',
    '/data',
  ])
  for (const adapter of ['sqlite', 'postgres']) {
    const name = `${prefix}-${adapter}`
    const volume = `${name}-data`
    volumes.push(volume)
    docker('volume', 'create', volume)
    const env = ['-e', 'ADMIN_TOKEN=smoke-admin', '-e', 'SERVER_NAME=Portable smoke']
    if (adapter === 'postgres')
      env.push(
        '-e',
        'DB_ADAPTER=postgres',
        '-e',
        `DATABASE_URL=postgresql://postgres:smoke@${prefix}-pg:5432/caelestis`,
        '-e',
        'PG_TLS_MODE=disable',
        '-e',
        'OBJECT_STORAGE=s3',
        '-e',
        'S3_BUCKET=caelestis',
        '-e',
        `S3_ENDPOINT=http://${prefix}-s3:9000`,
        '-e',
        'S3_FORCE_PATH_STYLE=true',
        '-e',
        'AWS_ACCESS_KEY_ID=caelestis-smoke',
        '-e',
        'AWS_SECRET_ACCESS_KEY=caelestis-smoke-password',
      )
    if (adapter === 'postgres') {
      run(`${name}-setup`, [
        ...env,
        '-w',
        '/app/apps/backend',
        image,
        'node',
        '--input-type=module',
        '-e',
        `
        import { createRequire } from 'node:module';
        const { S3Client, CreateBucketCommand } = createRequire(import.meta.resolve('@caelestis/storage/s3'))('@aws-sdk/client-s3');
        const client = new S3Client({ region: 'us-east-1', endpoint: process.env.S3_ENDPOINT, forcePathStyle: true });
        await client.send(new CreateBucketCommand({ Bucket: 'caelestis' })); client.destroy();
      `,
      ])
    }
    run(name, ['-d', '--read-only', '--tmpfs', '/tmp', '-v', `${volume}:/data`, ...env, image])
    await ready(name)
    const id = inside(
      name,
      `
      import assert from 'node:assert/strict';
      import { once } from 'node:events';
      import { WebSocket } from 'ws';
      const site = 'http://127.0.0.1:3000';
      assert.equal((await fetch(site+'/backend/v1/manifest')).status, 401);
      const manifest = await (await fetch(site+'/api/v1/manifest')).json();
      assert.equal(manifest.server.liveSyncMax, 2);
      const page = await fetch(site); assert.equal(page.status, 200);
      assert.ok((await page.text()).includes(manifest.server.id));
      const ws = new WebSocket('ws://127.0.0.1:3000/api/v1/telemetry/live?season=0&scope=public&stateVector=1', ['caelestis.live.v2']);
      const timeout = setTimeout(()=>process.exit(1), 10000);
      await once(ws, 'open'); const message = once(ws, 'message');
      ws.send(JSON.stringify({ type: 'state-vector', requestId: '01890f3e-7b2c-7abc-8def-000000000003', revision: null, projections: [] }));
      assert.equal(JSON.parse(String((await message)[0])).type, 'status-snapshot');
      const closed = once(ws, 'close'); ws.close(); await closed; clearTimeout(timeout);
      console.log(manifest.server.id);
    `,
    )
    inside(
      name,
      `
      import { Worker } from 'node:worker_threads';
      import { once } from 'node:events';
      process.chdir('/app');
      const worker = new Worker('/app/apps/backend/dist/node/social-worker.js', { execArgv: [], workerData: { site: 'http://127.0.0.1:3000', output: '/data/social-smoke' } });
      const [code] = await once(worker, 'exit');
      if (code !== 0) throw new Error('Packaged social worker failed');
    `,
    )
    inside(
      name,
      `
      import { nodeObjectStorage } from '@caelestis/storage/node';
      const storage = nodeObjectStorage(process.env);
      await storage.put('smoke/persisted', new TextEncoder().encode('persisted bytes'), { contentType: 'text/plain', metadata: { source: 'smoke' } });
      storage.close?.();
    `,
    )
    const rival = `${name}-rival`
    containers.push(rival)
    const rejected = spawnSync(
      'docker',
      ['run', '--name', rival, '--network', prefix, '-v', `${volume}:/data`, ...env, image],
      { encoding: 'utf8', timeout: 30000 },
    )
    assert.notEqual(rejected.status, 0, 'A second application owner must fail startup')
    assert.equal(rejected.error, undefined, 'A second owner must fail promptly, not hang')
    assert.match(rejected.stderr + rejected.stdout, /owner|lock|already running/i)
    docker('restart', '--time', '35', name)
    await ready(name)
    inside(
      name,
      `
      import assert from 'node:assert/strict';
      import { nodeObjectStorage } from '@caelestis/storage/node';
      const manifest = await (await fetch('http://127.0.0.1:3000/api/v1/manifest')).json();
      assert.equal(manifest.server.id, ${JSON.stringify(id)});
      const storage = nodeObjectStorage(process.env);
      const object = await storage.get('smoke/persisted');
      assert.equal(new TextDecoder().decode(object.bytes), 'persisted bytes');
      assert.equal(object.metadata.source, 'smoke');
      storage.close?.();
    `,
    )
    console.log(`${adapter}: HTTP, SSR, WebSocket, ownership, objects, and restart passed`)
  }
} finally {
  for (const name of containers) spawnSync('docker', ['rm', '-f', name])
  for (const volume of volumes) spawnSync('docker', ['volume', 'rm', volume])
  docker('network', 'rm', prefix)
}
