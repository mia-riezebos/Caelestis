import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { acceptance, waitFor } from './stack-tests/acceptance.mjs'
import { availablePort, run, start } from './stack-tests/process.mjs'

const [backend, frontend, stack] = process.argv.slice(2)
if (!backend || !frontend || !['sqlite', 'cnpg', 'mariadb'].includes(stack))
  throw new Error(
    'Usage: node scripts/test-helm-stack.mjs BACKEND_IMAGE FRONTEND_IMAGE sqlite|cnpg|mariadb',
  )
const name = `caelestis-ci-${process.pid}`
const directory = mkdtempSync(`${tmpdir()}/${name}-`)
const output = resolve(`test-results/helm-${stack}`)
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
const log = `${output}/provision.log`
const env = { ...process.env, KUBECONFIG: `${directory}/kubeconfig` }
const kind = process.env.KIND ?? 'kind'
const kubectl = (...args) =>
  execFileSync('kubectl', args, { env, encoding: 'utf8', timeout: 240_000 }).trim()
const apply = (...items) =>
  execFileSync('kubectl', ['apply', '-f', '-'], {
    env,
    input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items }),
    encoding: 'utf8',
  })
const secret = (name, stringData) => ({
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: { name },
  stringData,
})
const service = (name, port) => ({
  apiVersion: 'v1',
  kind: 'Service',
  metadata: { name },
  spec: { selector: { app: name }, ports: [{ port }] },
})
const workload = (name, image, port, variables, args = [], volumes = []) => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: name } },
    template: {
      metadata: { labels: { app: name } },
      spec: {
        containers: [
          {
            name,
            image,
            args,
            env: Object.entries(variables).map(([name, value]) => ({ name, value })),
            ports: [{ containerPort: port }],
            readinessProbe: {
              ...(name === 's3'
                ? { httpGet: { path: '/minio/health/ready', port } }
                : { tcpSocket: { port } }),
              periodSeconds: 2,
            },
            volumeMounts: volumes.map(({ name, mountPath }) => ({ name, mountPath })),
          },
        ],
        volumes: volumes.map(({ name, secret }) => ({ name, secret: { secretName: secret } })),
      },
    },
  },
})
const imageValues = (image) => {
  const colon = image.lastIndexOf(':')
  assert.ok(colon > image.lastIndexOf('/'), 'Test images must have an explicit tag')
  return { repository: image.slice(0, colon), tag: image.slice(colon + 1), pullPolicy: 'Never' }
}
let forward
let created = false
try {
  await run(
    kind,
    [
      'create',
      'cluster',
      '--name',
      name,
      '--kubeconfig',
      env.KUBECONFIG,
      '--image',
      'kindest/node:v1.35.8@sha256:07b2536e30b803ed61d1677a79df6115f798ce64c80f9e22f6ed45afd09323c0',
      '--wait',
      '180s',
    ],
    { env, log, timeout: 360_000 },
  )
  created = true
  await run(kind, ['load', 'docker-image', '--name', name, backend, frontend], { env, log })
  apply(
    secret('caelestis-server', {
      ADMIN_TOKEN: 'helm-admin-test',
      CAELESTIS_READ_TOKEN: 'helm-read-test',
    }),
  )
  const values = {
    image: imageValues(backend),
    frontend: { image: imageValues(frontend) },
    server: { origin: '' },
    ingress: { enabled: false },
    persistence: { size: '1Gi' },
  }
  const files = []
  if (stack !== 'sqlite') {
    files.push('-f', `deploy/helm/${stack}-s3.example.yaml`)
    apply(
      secret('caelestis-s3', {
        AWS_ACCESS_KEY_ID: 'stack-test',
        AWS_SECRET_ACCESS_KEY: 'stack-test-password',
      }),
      service('s3', 9000),
      workload(
        's3',
        'minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e',
        9000,
        { MINIO_ROOT_USER: 'stack-test', MINIO_ROOT_PASSWORD: 'stack-test-password' },
        ['server', '/data'],
      ),
    )
    kubectl('rollout', 'status', 'deployment/s3', '--timeout=180s')
    apply({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'bucket' },
      spec: {
        backoffLimit: 0,
        template: {
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'bucket',
                image: backend,
                imagePullPolicy: 'Never',
                workingDir: '/app/apps/backend',
                envFrom: [{ secretRef: { name: 'caelestis-s3' } }],
                command: [
                  'node',
                  '--input-type=module',
                  '-e',
                  `import {createRequire} from 'node:module';
                  import {setTimeout} from 'node:timers/promises';
                  const deadline=Date.now()+60000;
                  for(;;) {
                    try { if((await fetch('http://s3:9000/minio/health/ready',{signal:AbortSignal.timeout(3000)})).ok) break; } catch {}
                    if(Date.now()>deadline) throw new Error('MinIO service routing did not become ready');
                    await setTimeout(1000);
                  }
                  const {S3Client,CreateBucketCommand}=createRequire(import.meta.resolve('@caelestis/storage/s3'))('@aws-sdk/client-s3');
                  const client=new S3Client({endpoint:'http://s3:9000',region:'us-east-1',forcePathStyle:true});
                  await client.send(new CreateBucketCommand({Bucket:'caelestis'})); client.destroy();`,
                ],
              },
            ],
          },
        },
      },
    })
    kubectl('wait', '--for=condition=complete', 'job/bucket', '--timeout=90s')
    values.storage = { s3: { endpoint: 'http://s3:9000' } }
  }
  if (stack === 'cnpg') {
    await run(
      'kubectl',
      [
        'apply',
        '--server-side',
        '-f',
        'https://raw.githubusercontent.com/cloudnative-pg/artifacts/0a96e6b4debcc6a0a01ea8e7e52dbacd9fe7fab2/manifests/operator-manifest.yaml',
      ],
      { env, log },
    )
    kubectl(
      'rollout',
      'status',
      'deployment/cnpg-controller-manager',
      '-n',
      'cnpg-system',
      '--timeout=180s',
    )
    apply({
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'Cluster',
      metadata: { name: 'caelestis-db' },
      spec: {
        instances: process.env.CAELESTIS_TEST_EXTENDED === 'true' ? 2 : 1,
        imageName: 'ghcr.io/cloudnative-pg/postgresql:17.6',
        storage: { size: '1Gi' },
        bootstrap: { initdb: { database: 'caelestis', owner: 'caelestis' } },
      },
    })
    kubectl('wait', '--for=condition=Ready', 'cluster/caelestis-db', '--timeout=240s')
  }
  if (stack === 'mariadb') {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-keyout',
        `${directory}/key.pem`,
        '-out',
        `${directory}/cert.pem`,
        '-subj',
        '/CN=mariadb.default.svc',
        '-addext',
        'subjectAltName=DNS:mariadb.default.svc',
      ],
      { stdio: 'ignore' },
    )
    apply(
      secret('caelestis-mariadb', {
        username: 'caelestis',
        password: 'stack-maria-test',
        database: 'caelestis',
      }),
      secret('mariadb-ca', { 'ca.crt': readFileSync(`${directory}/cert.pem`, 'utf8') }),
      secret('mariadb-tls', {
        'ca.crt': readFileSync(`${directory}/cert.pem`, 'utf8'),
        'tls.crt': readFileSync(`${directory}/cert.pem`, 'utf8'),
        'tls.key': readFileSync(`${directory}/key.pem`, 'utf8'),
      }),
      service('mariadb', 3306),
      workload(
        'mariadb',
        'mariadb:11.8@sha256:2d2f4095530294735a857cfe22bb101e19b0849b416911c796ec4aa81b164a62',
        3306,
        {
          MARIADB_DATABASE: 'caelestis',
          MARIADB_USER: 'caelestis',
          MARIADB_PASSWORD: 'stack-maria-test',
          MARIADB_RANDOM_ROOT_PASSWORD: '1',
        },
        [
          '--ssl-ca=/tls/ca.crt',
          '--ssl-cert=/tls/tls.crt',
          '--ssl-key=/tls/tls.key',
          '--require-secure-transport=ON',
        ],
        [{ name: 'tls', secret: 'mariadb-tls', mountPath: '/tls' }],
      ),
    )
    kubectl('rollout', 'status', 'deployment/mariadb', '--timeout=180s')
  }
  const override = `${directory}/values.json`
  writeFileSync(override, JSON.stringify(values))
  const helm = (...args) =>
    run(
      'helm',
      ['upgrade', '--install', 'test', 'deploy/helm/caelestis', ...files, '-f', override, ...args],
      { env, log },
    )
  await helm('--wait', '--timeout', '4m')
  const port = await availablePort()
  const site = `http://127.0.0.1:${port}`
  const connect = async () => {
    await forward?.stop()
    forward = start(
      'kubectl',
      ['port-forward', 'service/test-caelestis', `${port}:80`, '--address', '127.0.0.1'],
      { env, log },
    )
    await waitFor(
      async () =>
        (await fetch(`${site}/api/v1/manifest`, { signal: AbortSignal.timeout(3000) })).ok,
      'Helm frontend',
    )
  }
  await connect()
  const suite = acceptance({ site, adminToken: 'helm-admin-test', readToken: 'helm-read-test' })
  const state = await suite.seed()
  await suite.verify(state)
  const frontendEnv = kubectl(
    'exec',
    'deployment/test-caelestis',
    '-c',
    'frontend',
    '--',
    'node',
    '-e',
    'console.log(JSON.stringify(Object.keys(process.env)))',
  )
  assert.ok(
    !JSON.parse(frontendEnv).some((name) =>
      /^(ADMIN_TOKEN|PGPASSWORD|MARIADB_PASSWORD|DATABASE_URL)$/.test(name),
    ),
  )
  kubectl('delete', 'pod', '-l', 'app.kubernetes.io/instance=test', '--wait=true')
  kubectl('rollout', 'status', 'deployment/test-caelestis', '--timeout=180s')
  await connect()
  await suite.verify(state)
  if (stack === 'cnpg' && process.env.CAELESTIS_TEST_EXTENDED === 'true') {
    const backendRestarts = () =>
      JSON.parse(
        kubectl('get', 'pods', '-l', 'app.kubernetes.io/instance=test', '-o', 'json'),
      ).items[0].status.containerStatuses.find((container) => container.name === 'backend')
        .restartCount
    const before = backendRestarts()
    const primary = kubectl(
      'get',
      'cluster',
      'caelestis-db',
      '-o',
      'jsonpath={.status.currentPrimary}',
    )
    const replicas = JSON.parse(
      kubectl('get', 'pods', '-l', 'cnpg.io/cluster=caelestis-db', '-o', 'json'),
    ).items
    const replacement = replicas.find((pod) => pod.metadata.name !== primary).metadata.name
    kubectl(
      'patch',
      'cluster',
      'caelestis-db',
      '--type=merge',
      '-p',
      JSON.stringify({ status: { targetPrimary: replacement } }),
      '--subresource=status',
    )
    await waitFor(
      () =>
        kubectl('get', 'cluster', 'caelestis-db', '-o', 'jsonpath={.status.currentPrimary}') ===
        replacement,
      'CNPG switchover',
      180_000,
    )
    kubectl('wait', '--for=condition=Ready', 'cluster/caelestis-db', '--timeout=180s')
    await waitFor(() => backendRestarts() > before, 'backend restart after primary connection loss')
    await connect()
    await suite.verify(state)
  }
  await forward.stop()
  kubectl('scale', 'deployment/test-caelestis', '--replicas=0')
  kubectl('wait', '--for=delete', 'pod', '-l', 'app.kubernetes.io/instance=test', '--timeout=90s')
  await helm(
    '--set',
    'replicaCount=0,migration.enabled=true',
    '--wait',
    '--wait-for-jobs',
    '--timeout',
    '4m',
  )
  await helm('--wait', '--timeout', '4m')
  await connect()
  await suite.verify(state)
  await suite.remove(state)
  writeFileSync(`${output}/result.json`, JSON.stringify({ stack, passed: true }))
  console.log(`Helm ${stack}: acceptance, pod replacement, TLS and migration passed`)
} finally {
  await forward?.stop()
  if (created) {
    for (const [file, args] of [
      ['pods', ['get', 'pods', '-A', '-o', 'wide']],
      ['events', ['get', 'events', '-A', '--sort-by=.lastTimestamp']],
      ['backend', ['logs', 'deployment/test-caelestis', '-c', 'backend', '--tail=300']],
      ['frontend', ['logs', 'deployment/test-caelestis', '-c', 'frontend', '--tail=300']],
      ['bucket', ['logs', 'job/bucket', '--tail=100']],
      ['s3', ['logs', 'deployment/s3', '--tail=100']],
      ['mariadb', ['logs', 'deployment/mariadb', '--tail=100']],
      ['cnpg', ['logs', 'deployment/cnpg-controller-manager', '-n', 'cnpg-system', '--tail=100']],
    ]) {
      const result = spawnSync('kubectl', args, { env, encoding: 'utf8', timeout: 30_000 })
      writeFileSync(`${output}/${file}.log`, (result.stdout ?? '') + (result.stderr ?? ''))
    }
  }
  // Explicit name and private kubeconfig keep this driver away from the user's cluster.
  await run(kind, ['delete', 'cluster', '--name', name], { env, log })
  rmSync(directory, { recursive: true, force: true })
}
